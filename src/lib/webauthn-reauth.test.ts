// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
// vitest — node env, no DOM, no network. Exercises the per-device passkey memory
// and the WebAuthnConfig builder (the opt-in switch for redirect-free re-auth).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebAuthnTokenProvider } from "@jeswr/solid-webauthn-client";
import type { KeyValueStorage } from "./login-ux.js";
import {
  buildWebAuthnConfig,
  buildWebAuthnReauthProviderForWebId,
  issuerHost,
  PasskeyCeremonyFailedError,
  PasskeyRegistry,
  rejectOnlyFallback,
  webIdClaimOf,
  WebIdBoundWebAuthnProvider,
} from "./webauthn-reauth.js";

/** In-memory KeyValueStorage stub (matches localStorage's shape). */
class MemoryStorage implements KeyValueStorage {
  #map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.#map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.#map.set(key, value);
  }
  raw(key: string): string | null {
    return this.getItem(key);
  }
  poison(key: string): void {
    this.#map.set(key, "{not json");
  }
  /** Store an ARBITRARY raw value (valid JSON of the wrong shape, etc.). */
  setRaw(key: string, value: string): void {
    this.#map.set(key, value);
  }
}

const ISSUER = "https://idp.solid-test.jeswr.org";
// A common Solid layout: storage host differs from the issuer host.
const WEBID = "https://alice.solid-test.jeswr.org/profile/card#me";
const STORAGE = "https://alice.solid-test.jeswr.org/storage/";
const CLIENT_ID = "https://app.solid-test.jeswr.org/clientid.jsonld";

const reg = (over: Partial<import("./webauthn-reauth.js").PasskeyRegistration> = {}) => ({
  webId: WEBID,
  issuer: ISSUER,
  resourceHosts: [new URL(STORAGE).host],
  ...over,
});

describe("issuerHost", () => {
  it("returns the host of an issuer origin (ignoring path/scheme)", () => {
    expect(issuerHost("https://idp.solid-test.jeswr.org")).toBe("idp.solid-test.jeswr.org");
    expect(issuerHost("https://idp.solid-test.jeswr.org/oidc")).toBe("idp.solid-test.jeswr.org");
  });
});

describe("PasskeyRegistry", () => {
  let storage: MemoryStorage;
  let registry: PasskeyRegistry;
  beforeEach(() => {
    storage = new MemoryStorage();
    registry = new PasskeyRegistry(storage);
  });

  it("starts empty and reports no passkey", () => {
    expect(registry.list()).toEqual([]);
    expect(registry.hasFor(WEBID)).toBe(false);
  });

  it("remembers a registration and matches by exact WebID", () => {
    expect(registry.remember(reg())).toBe(true);
    expect(registry.hasFor(WEBID)).toBe(true);
    // A DIFFERENT WebID on the SAME issuer must NOT be considered registered
    // (roborev High: no cross-account passkey bleed).
    expect(registry.hasFor("https://bob.solid-test.jeswr.org/profile/card#me")).toBe(false);
  });

  it("deduplicates by WebID (re-registering refreshes, does not duplicate)", () => {
    registry.remember(reg());
    registry.remember(reg({ resourceHosts: ["new.example"] }));
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].resourceHosts).toEqual(["new.example"]);
  });

  it("keeps two distinct WebIDs on the same issuer separate", () => {
    registry.remember(reg());
    registry.remember(reg({ webId: "https://bob.solid-test.jeswr.org/profile/card#me" }));
    expect(registry.list()).toHaveLength(2);
    expect(registry.hasFor(WEBID)).toBe(true);
    expect(registry.hasFor("https://bob.solid-test.jeswr.org/profile/card#me")).toBe(true);
  });

  it("forget removes only the matching WebID", () => {
    registry.remember(reg());
    registry.remember(reg({ webId: "https://c.example/#me" }));
    registry.forget(WEBID);
    expect(registry.hasFor(WEBID)).toBe(false);
    expect(registry.hasFor("https://c.example/#me")).toBe(true);
  });

  it("survives corrupt storage (never throws)", () => {
    storage.poison("solid-pod-manager:passkey-issuers");
    expect(registry.list()).toEqual([]);
    expect(registry.hasFor(WEBID)).toBe(false);
  });

  // SHAPE VALIDATION (roborev Finding 5): valid JSON of the WRONG shape (an old
  // schema, a scalar, a non-array, a missing/invalid `issuer`, a non-array
  // `resourceHosts`) must NEVER escape `list()` and throw later in
  // `.some()/.find()/issuerHost()/new Set()` on the login-restore path.
  const STORE_KEY = "solid-pod-manager:passkey-issuers";
  it("returns [] for a non-array JSON value (a scalar / an object)", () => {
    storage.setRaw(STORE_KEY, JSON.stringify("just a string"));
    expect(registry.list()).toEqual([]);
    storage.setRaw(STORE_KEY, JSON.stringify(42));
    expect(registry.list()).toEqual([]);
    storage.setRaw(STORE_KEY, JSON.stringify({ webId: WEBID }));
    expect(registry.list()).toEqual([]);
    storage.setRaw(STORE_KEY, JSON.stringify(null));
    expect(registry.list()).toEqual([]);
  });

  it("filters out malformed entries (old schema, missing/invalid issuer, bad resourceHosts)", () => {
    storage.setRaw(
      STORE_KEY,
      JSON.stringify([
        reg(), // well-formed — kept
        { webId: WEBID }, // OLD schema: no issuer / resourceHosts — dropped
        { webId: WEBID, issuer: "not a url", resourceHosts: [] }, // unparsable issuer — dropped
        { webId: 123, issuer: ISSUER, resourceHosts: [] }, // non-string webId — dropped
        { webId: "https://x.example/#me", issuer: ISSUER, resourceHosts: "nope" }, // non-array hosts — dropped
        { webId: "https://y.example/#me", issuer: ISSUER, resourceHosts: [1, 2] }, // non-string hosts — dropped
        "scalar", // not an object — dropped
        null, // not an object — dropped
      ]),
    );
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].webId).toBe(WEBID);
  });

  it("hasFor / buildWebAuthnConfig do NOT throw on a malformed store (login-path safety)", () => {
    // The exact downstream calls that would have thrown: hasFor → .some(),
    // buildWebAuthnConfig → issuerHost(new URL) + new Set(resourceHosts).
    storage.setRaw(
      STORE_KEY,
      JSON.stringify([
        { webId: WEBID, issuer: "::::not-a-url", resourceHosts: 5 }, // both fields bad
        { issuer: ISSUER }, // missing webId + resourceHosts
      ]),
    );
    expect(() => registry.hasFor(WEBID)).not.toThrow();
    expect(registry.hasFor(WEBID)).toBe(false);
    expect(() => buildWebAuthnConfig(registry.list(), CLIENT_ID)).not.toThrow();
    // Nothing well-formed survived → no config (caller skips the provider).
    expect(buildWebAuthnConfig(registry.list(), CLIENT_ID)).toBeUndefined();
  });

  it("remember returns false (not throw) when storage is unavailable", () => {
    const blocked = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    };
    const r = new PasskeyRegistry(blocked);
    expect(r.remember(reg())).toBe(false); // credential exists; hint just unsaved
  });
});

describe("buildWebAuthnConfig", () => {
  it("returns undefined when there are no registrations (opt-out by default)", () => {
    expect(buildWebAuthnConfig([], CLIENT_ID)).toBeUndefined();
  });

  it("keys config by RESOURCE host (storage host != issuer host) and binds clientId", () => {
    const config = buildWebAuthnConfig([reg()], CLIENT_ID);
    expect(config).toBeDefined();
    const storageHost = new URL(STORAGE).host;
    // The storage host (where protected reads land) is keyed — the bug roborev
    // flagged: keying by issuer host alone would never match resource reads.
    expect(config?.[storageHost]).toEqual({ issuer: ISSUER, clientId: CLIENT_ID });
    // The issuer host is also covered defensively (broker-cohosted resources).
    expect(config?.[issuerHost(ISSUER)]).toEqual({ issuer: ISSUER, clientId: CLIENT_ID });
  });

  it("always covers the WebID host even if it is not in resourceHosts", () => {
    const config = buildWebAuthnConfig([reg({ resourceHosts: [] })], CLIENT_ID);
    expect(config?.[new URL(WEBID).host]).toBeDefined();
  });
});

describe("buildWebAuthnReauthProviderForWebId", () => {
  const noopFallback = { matches: async () => true, upgrade: async (r: Request) => r };

  it("returns undefined when that WebID has no passkey", () => {
    const registry = new PasskeyRegistry(new MemoryStorage());
    expect(
      buildWebAuthnReauthProviderForWebId(registry, WEBID, CLIENT_ID, noopFallback),
    ).toBeUndefined();
  });

  it("returns a WebID-bound provider for a registered WebID", () => {
    const registry = new PasskeyRegistry(new MemoryStorage());
    registry.remember(reg());
    const provider = buildWebAuthnReauthProviderForWebId(registry, WEBID, CLIENT_ID, noopFallback);
    expect(provider).toBeInstanceOf(WebIdBoundWebAuthnProvider);
  });

  it("is scoped to the requested WebID only — a different account's passkey is NOT wired", () => {
    const registry = new PasskeyRegistry(new MemoryStorage());
    registry.remember(reg()); // alice
    // Restoring bob (no passkey) must NOT pick up alice's passkey on the shared host.
    expect(
      buildWebAuthnReauthProviderForWebId(
        registry,
        "https://bob.solid-test.jeswr.org/profile/card#me",
        CLIENT_ID,
        noopFallback,
      ),
    ).toBeUndefined();
  });

  it("matches a request to the STORAGE host (not just the issuer), declines others", async () => {
    const registry = new PasskeyRegistry(new MemoryStorage());
    registry.remember(reg());
    const provider = buildWebAuthnReauthProviderForWebId(registry, WEBID, CLIENT_ID, noopFallback);
    expect(provider).toBeDefined();
    // Protected read on the storage host — must match (the resource-host fix).
    await expect(
      provider?.matches(new Request(`${STORAGE}private/notes`)),
    ).resolves.toBe(true);
    await expect(
      provider?.matches(new Request("https://unrelated.example/x")),
    ).resolves.toBe(false);
  });
});

/** Minimal unsigned JWT with a given `webid` claim (no crypto — payload only). */
function jwtWithWebId(webid: string): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "ES256", typ: "at+jwt" })}.${b64({ webid })}.sig`;
}

describe("webIdClaimOf", () => {
  it("reads the webid claim from an at+jwt", () => {
    expect(webIdClaimOf(jwtWithWebId(WEBID))).toBe(WEBID);
  });
  it("returns undefined for malformed tokens (never throws)", () => {
    expect(webIdClaimOf("not-a-jwt")).toBeUndefined();
    expect(webIdClaimOf("")).toBeUndefined();
    expect(webIdClaimOf("a.b.c")).toBeUndefined(); // b is not base64 JSON
  });
});

describe("WebIdBoundWebAuthnProvider", () => {
  // A fake inner provider that mints a token for a CONFIGURABLE webid — stands in
  // for the platform prompt returning a credential for some account on the RP.
  function fakeInner(mintedWebId: string) {
    return {
      matches: async () => true,
      upgrade: async (req: Request) =>
        new Request(req, {
          headers: { authorization: `DPoP ${jwtWithWebId(mintedWebId)}` },
        }),
      invalidate: async () => {},
    } as unknown as WebAuthnTokenProvider;
  }

  // A fallback that tags the request so we can assert delegation happened. Real
  // life: the interactive WebIdDPoPTokenProvider (popup/silent code flow).
  function fakeFallback() {
    const calls: Request[] = [];
    const fallback = {
      matches: async () => true,
      upgrade: async (req: Request) => {
        calls.push(req);
        return new Request(req, { headers: { "x-fallback": "1" } });
      },
    };
    return { fallback, calls };
  }

  it("returns the upgraded request when the minted WebID matches the expected one", async () => {
    const { fallback, calls } = fakeFallback();
    const p = new WebIdBoundWebAuthnProvider(fakeInner(WEBID), fallback, WEBID);
    const out = await p.upgrade(new Request(`${STORAGE}x`));
    expect(out.headers.get("authorization")).toContain("DPoP ");
    expect(calls).toHaveLength(0); // no fallback when the account matches
  });

  it("DELEGATES to the interactive fallback when the prompt returns a DIFFERENT account on the same RP (roborev High)", async () => {
    const bob = "https://bob.solid-test.jeswr.org/profile/card#me";
    const { fallback, calls } = fakeFallback();
    const p = new WebIdBoundWebAuthnProvider(fakeInner(bob), fallback, WEBID);
    // Account A expected, credential resolved to B → delegate (NOT throw): the
    // manager has no next-provider fallback of its own.
    const out = await p.upgrade(new Request(`${STORAGE}x`));
    expect(out.headers.get("x-fallback")).toBe("1");
    expect(calls).toHaveLength(1);
  });

  it("DELEGATES on an unreadable token rather than accepting or rejecting", async () => {
    const bad = {
      matches: async () => true,
      upgrade: async (req: Request) =>
        new Request(req, { headers: { authorization: "DPoP garbage" } }),
    } as unknown as WebAuthnTokenProvider;
    const { fallback, calls } = fakeFallback();
    const p = new WebIdBoundWebAuthnProvider(bad, fallback, WEBID);
    const out = await p.upgrade(new Request(`${STORAGE}x`));
    expect(out.headers.get("x-fallback")).toBe("1");
    expect(calls).toHaveLength(1);
  });

  it("DELEGATES when the passkey ceremony/exchange itself fails (no rejected fetch)", async () => {
    const failing = {
      matches: async () => true,
      upgrade: async () => {
        throw new Error("user cancelled the passkey prompt");
      },
    } as unknown as WebAuthnTokenProvider;
    const { fallback, calls } = fakeFallback();
    const p = new WebIdBoundWebAuthnProvider(failing, fallback, WEBID);
    const out = await p.upgrade(new Request(`${STORAGE}x`));
    expect(out.headers.get("x-fallback")).toBe("1");
    expect(calls).toHaveLength(1);
  });

  it("forwards forceRefresh to the fallback on a wrong-account delegation (roborev Finding 2)", async () => {
    const bob = "https://bob.solid-test.jeswr.org/profile/card#me";
    const forceRefreshes: (boolean | undefined)[] = [];
    const fallback = {
      matches: async () => true,
      upgrade: async (req: Request, forceRefresh?: boolean) => {
        forceRefreshes.push(forceRefresh);
        return new Request(req, { headers: { "x-fallback": "1" } });
      },
    };
    const p = new WebIdBoundWebAuthnProvider(fakeInner(bob), fallback, WEBID);
    // A stale-token RETRY calls upgrade(req, true) → the wrong-account delegation
    // must forward forceRefresh so the fallback mints a FRESH token, not the
    // rejected cached one.
    const out = await p.upgrade(new Request(`${STORAGE}x`), true);
    expect(out.headers.get("x-fallback")).toBe("1");
    expect(forceRefreshes).toEqual([true]);
  });

  it("forwards forceRefresh to the fallback when the ceremony itself fails (roborev Finding 2)", async () => {
    const failing = {
      matches: async () => true,
      upgrade: async () => {
        throw new Error("user cancelled the passkey prompt");
      },
    } as unknown as WebAuthnTokenProvider;
    const forceRefreshes: (boolean | undefined)[] = [];
    const fallback = {
      matches: async () => true,
      upgrade: async (req: Request, forceRefresh?: boolean) => {
        forceRefreshes.push(forceRefresh);
        return new Request(req, { headers: { "x-fallback": "1" } });
      },
    };
    const p = new WebIdBoundWebAuthnProvider(failing, fallback, WEBID);
    await p.upgrade(new Request(`${STORAGE}x`), true);
    expect(forceRefreshes).toEqual([true]);
  });

  it("invalidate() invalidates BOTH the inner passkey provider AND the fallback (roborev Finding 6)", async () => {
    const innerInvalidate = vi.fn(async () => {});
    const fallbackInvalidate = vi.fn(async () => {});
    const inner = {
      matches: async () => true,
      upgrade: async (req: Request) => req,
      invalidate: innerInvalidate,
    } as unknown as WebAuthnTokenProvider;
    const fallback = {
      matches: async () => true,
      upgrade: async (req: Request) => req,
      invalidate: fallbackInvalidate,
    };
    const p = new WebIdBoundWebAuthnProvider(inner, fallback, WEBID);
    const req = new Request(`${STORAGE}x`);
    await p.invalidate(req);
    // Both must be invalidated: upgrade() can return EITHER an inner-minted OR a
    // fallback-issued token, and on a later rejection we don't know which.
    expect(innerInvalidate).toHaveBeenCalledWith(req);
    expect(fallbackInvalidate).toHaveBeenCalledWith(req);
  });

  it("invalidate() swallows a thrown inner invalidate and still invalidates the fallback", async () => {
    const fallbackInvalidate = vi.fn(async () => {});
    const inner = {
      matches: async () => true,
      upgrade: async (req: Request) => req,
      invalidate: async () => {
        throw new Error("inner invalidate blew up");
      },
    } as unknown as WebAuthnTokenProvider;
    const fallback = {
      matches: async () => true,
      upgrade: async (req: Request) => req,
      invalidate: fallbackInvalidate,
    };
    const p = new WebIdBoundWebAuthnProvider(inner, fallback, WEBID);
    const req = new Request(`${STORAGE}x`);
    await expect(p.invalidate(req)).resolves.toBeUndefined();
    expect(fallbackInvalidate).toHaveBeenCalledWith(req);
  });

  it("invalidate() swallows a SYNCHRONOUSLY-thrown inner invalidate and still invalidates the fallback (roborev A1)", async () => {
    // A1: a 1-arg/sync inner `invalidate` that throws SYNCHRONOUSLY (not a rejected
    // promise) must not abort the best-effort fan-out. `Promise.resolve(call())` would
    // let the sync throw escape array construction and reject `invalidate()` before the
    // fallback runs; the async-thunk wrapping converts it to a settled rejection.
    const fallbackInvalidate = vi.fn(async () => {});
    const inner = {
      matches: async () => true,
      upgrade: async (req: Request) => req,
      // NOTE: a NON-async function that throws synchronously.
      invalidate: () => {
        throw new Error("inner invalidate threw synchronously");
      },
    } as unknown as WebAuthnTokenProvider;
    const fallback = {
      matches: async () => true,
      upgrade: async (req: Request) => req,
      invalidate: fallbackInvalidate,
    };
    const p = new WebIdBoundWebAuthnProvider(inner, fallback, WEBID);
    const req = new Request(`${STORAGE}x`);
    await expect(p.invalidate(req)).resolves.toBeUndefined();
    expect(fallbackInvalidate).toHaveBeenCalledWith(req);
  });

  it("invalidate() swallows a SYNCHRONOUSLY-thrown fallback invalidate and still invalidates the inner (roborev A1)", async () => {
    // Symmetric: a sync throw from the FALLBACK's invalidate must not prevent the inner's.
    const innerInvalidate = vi.fn(async () => {});
    const inner = {
      matches: async () => true,
      upgrade: async (req: Request) => req,
      invalidate: innerInvalidate,
    } as unknown as WebAuthnTokenProvider;
    const fallback = {
      matches: async () => true,
      upgrade: async (req: Request) => req,
      invalidate: () => {
        throw new Error("fallback invalidate threw synchronously");
      },
    };
    const p = new WebIdBoundWebAuthnProvider(inner, fallback, WEBID);
    const req = new Request(`${STORAGE}x`);
    await expect(p.invalidate(req)).resolves.toBeUndefined();
    expect(innerInvalidate).toHaveBeenCalledWith(req);
  });

  it("invalidate() works when the fallback has no invalidate (best-effort)", async () => {
    const innerInvalidate = vi.fn(async () => {});
    const inner = {
      matches: async () => true,
      upgrade: async (req: Request) => req,
      invalidate: innerInvalidate,
    } as unknown as WebAuthnTokenProvider;
    const fallback = { matches: async () => true, upgrade: async (req: Request) => req };
    const p = new WebIdBoundWebAuthnProvider(inner, fallback, WEBID);
    const req = new Request(`${STORAGE}x`);
    await expect(p.invalidate(req)).resolves.toBeUndefined();
    expect(innerInvalidate).toHaveBeenCalledWith(req);
  });

  // REJECT-FAST FALLBACK (roborev H2): on the EXPLICIT user-gesture signInWithPasskey
  // path the passkey provider is built with `rejectOnlyFallback`, so a failed / wrong-
  // account ceremony REJECTS the read (rather than delegating to an interactive popup
  // inside upgrade(), which would run outside the user activation and be popup-blocked).
  // The recent-account click's .catch then opens the interactive login under the gesture.
  describe("with rejectOnlyFallback (the explicit signInWithPasskey provider, roborev H2)", () => {
    it("REJECTS with PasskeyCeremonyFailedError when the ceremony itself fails (no interactive delegation)", async () => {
      const failing = {
        matches: async () => true,
        upgrade: async () => {
          throw new Error("user cancelled the passkey prompt");
        },
      } as unknown as WebAuthnTokenProvider;
      const p = new WebIdBoundWebAuthnProvider(failing, rejectOnlyFallback, WEBID);
      await expect(p.upgrade(new Request(`${STORAGE}x`))).rejects.toBeInstanceOf(
        PasskeyCeremonyFailedError,
      );
    });

    it("REJECTS with PasskeyCeremonyFailedError on a WRONG-account minted token", async () => {
      const bob = "https://bob.solid-test.jeswr.org/profile/card#me";
      const p = new WebIdBoundWebAuthnProvider(fakeInner(bob), rejectOnlyFallback, WEBID);
      await expect(p.upgrade(new Request(`${STORAGE}x`))).rejects.toBeInstanceOf(
        PasskeyCeremonyFailedError,
      );
    });

    it("STILL returns the upgraded request when the minted WebID matches (happy path unaffected)", async () => {
      const p = new WebIdBoundWebAuthnProvider(fakeInner(WEBID), rejectOnlyFallback, WEBID);
      const out = await p.upgrade(new Request(`${STORAGE}x`));
      expect(out.headers.get("authorization")).toContain("DPoP ");
    });

    it("rejectOnlyFallback declines all matches + has a no-op invalidate", async () => {
      await expect(rejectOnlyFallback.matches(new Request(STORAGE))).resolves.toBe(false);
      await expect(rejectOnlyFallback.invalidate?.(new Request(STORAGE))).resolves.toBeUndefined();
    });
  });

  it("preserves a body-bearing request's body for the fallback after a wrong-account token (roborev)", async () => {
    const bob = "https://bob.solid-test.jeswr.org/profile/card#me";
    // Inner provider CONSUMES the body (like the real DPoP-bound rewrap would).
    const consuming = {
      matches: async () => true,
      upgrade: async (req: Request) => {
        await req.text(); // drain the original body stream
        return new Request("https://x.example/", {
          headers: { authorization: `DPoP ${jwtWithWebId(bob)}` },
        });
      },
    } as unknown as WebAuthnTokenProvider;
    // The fallback reads the body it receives — it must still be there.
    const bodies: string[] = [];
    const fallback = {
      matches: async () => true,
      upgrade: async (req: Request) => {
        // Read the body BEFORE re-wrapping (clone first so the wrapped Request
        // still has a usable body — a test-only nicety).
        bodies.push(await req.clone().text());
        return new Request(req, { headers: { "x-fallback": "1" } });
      },
    };
    const p = new WebIdBoundWebAuthnProvider(consuming, fallback, WEBID);
    const req = new Request(`${STORAGE}private/notes`, {
      method: "PUT",
      body: "the-payload",
    });
    const out = await p.upgrade(req);
    expect(out.headers.get("x-fallback")).toBe("1");
    expect(bodies).toEqual(["the-payload"]); // body survived for the fallback
  });
});
