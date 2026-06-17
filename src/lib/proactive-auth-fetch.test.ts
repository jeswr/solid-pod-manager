// AUTHORED-BY Claude Opus 4.8
/**
 * Tests for the PROACTIVE-ATTACH authenticated fetch — the fix for the per-resource 401
 * dance (#123 Phase 1). The load-bearing assertions:
 *   - the token is attached PROACTIVELY on the FIRST request (no wasted unauthenticated
 *     probe) — so 401s do NOT scale with the number of resources touched (the dance
 *     regression guard, at unit level);
 *   - a FOREIGN origin (or no session) is left UNAUTHENTICATED — the credential boundary;
 *   - exactly ONE bounded 401 re-upgrade for a stale token; none for a pure-nonce 401.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isProviderOAuthRequest,
  makeProactiveAuthFetch,
  type AuthTokenProvider,
} from "./proactive-auth-fetch.js";

const ALLOWED = new Set(["https://storage.example"]);
const NO_ISSUER = new Set<string>(); // tests that don't exercise the issuer-scoped OAuth bypass

/** A provider that stamps a marker header so we can see WHEN it upgraded. */
function makeProvider(over: Partial<AuthTokenProvider> = {}): AuthTokenProvider {
  return {
    matches: vi.fn(async () => true),
    upgrade: vi.fn(async (req: Request, forceRefresh?: boolean) => {
      const h = new Headers(req.headers);
      h.set("authorization", forceRefresh ? "DPoP fresh-token" : "DPoP token");
      return new Request(req, { headers: h });
    }),
    invalidate: vi.fn(async () => {}),
    ...over,
  };
}

/** A base fetch that records every request it saw and replies per a scripted queue. */
function makeBaseFetch(statuses: number[]): {
  fn: typeof fetch;
  seen: { url: string; authorization: string | null }[];
} {
  const seen: { url: string; authorization: string | null }[] = [];
  let i = 0;
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    seen.push({ url: req.url, authorization: req.headers.get("authorization") });
    const status = statuses[i++] ?? 200;
    const headers: Record<string, string> =
      status === 401 ? { "WWW-Authenticate": 'DPoP error="invalid_token"' } : {};
    return new Response(null, { status, headers });
  }) as typeof fetch;
  return { fn, seen };
}

describe("proactive-auth fetch", () => {
  let provider: AuthTokenProvider;

  beforeEach(() => {
    provider = makeProvider();
  });

  it("attaches the token PROACTIVELY on the FIRST request (no unauthenticated probe)", async () => {
    const base = makeBaseFetch([200]);
    const f = makeProactiveAuthFetch({ provider, allowedOrigins: () => ALLOWED, issuerOrigins: () => NO_ISSUER, baseFetch: base.fn });

    const r = await f("https://storage.example/alice/notes/1");
    expect(r.status).toBe(200);
    // ONE network request, and it ALREADY carried the token — no 401 round-trip.
    expect(base.seen).toHaveLength(1);
    expect(base.seen[0].authorization).toBe("DPoP token");
    expect(provider.upgrade).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION GUARD: 401s do not scale with the number of resources", async () => {
    // Every allowed-origin resource gets the token on its first request, so a warm
    // session browsing N children pays ZERO 401s (vs ≈N with the old reactive manager).
    const base = makeBaseFetch(new Array(50).fill(200));
    const f = makeProactiveAuthFetch({ provider, allowedOrigins: () => ALLOWED, issuerOrigins: () => NO_ISSUER, baseFetch: base.fn });

    let four01s = 0;
    for (let n = 0; n < 50; n++) {
      const r = await f(`https://storage.example/alice/child-${n}`);
      if (r.status === 401) four01s++;
    }
    expect(four01s).toBe(0);
    // exactly one network request per resource (no probe+retry doubling)
    expect(base.seen).toHaveLength(50);
    expect(base.seen.every((s) => s.authorization === "DPoP token")).toBe(true);
  });

  it("does NOT authenticate a FOREIGN origin (the credential boundary)", async () => {
    const base = makeBaseFetch([200]);
    const f = makeProactiveAuthFetch({ provider, allowedOrigins: () => ALLOWED, issuerOrigins: () => NO_ISSUER, baseFetch: base.fn });

    await f("https://evil.example/steal");
    expect(base.seen[0].authorization).toBeNull(); // no token sent cross-origin
    expect(provider.upgrade).not.toHaveBeenCalled();
  });

  it("does NOT authenticate when there is no live session (matches=false)", async () => {
    provider = makeProvider({ matches: vi.fn(async () => false) });
    const base = makeBaseFetch([200]);
    const f = makeProactiveAuthFetch({ provider, allowedOrigins: () => ALLOWED, issuerOrigins: () => NO_ISSUER, baseFetch: base.fn });

    await f("https://storage.example/alice/1");
    expect(base.seen[0].authorization).toBeNull();
    expect(provider.upgrade).not.toHaveBeenCalled();
  });

  it("does NOT authenticate (no popup) when the session is NOT non-interactively renewable", async () => {
    // The session-liveness gate: a passive read for an account whose refresh token is dead
    // must NOT trigger upgrade() (which would start the interactive code flow / popup) —
    // even though matches() is true and the origin is allowed (the roborev finding).
    const base = makeBaseFetch([200, 200]);
    let renewable = false;
    const f = makeProactiveAuthFetch({
      provider,
      allowedOrigins: () => ALLOWED,
      issuerOrigins: () => NO_ISSUER,
      baseFetch: base.fn,
      canAttachNonInteractively: () => renewable,
    });

    await f("https://storage.example/alice/1"); // not renewable → unauthenticated, no upgrade
    expect(base.seen[0].authorization).toBeNull();
    expect(provider.upgrade).not.toHaveBeenCalled();

    renewable = true; // a session was restored / explicit login → renewable
    await f("https://storage.example/alice/2");
    expect(base.seen[1].authorization).toBe("DPoP token");
    expect(provider.upgrade).toHaveBeenCalledTimes(1);
  });

  it("does NOT authenticate when the boundary is empty (logged out / fail-closed)", async () => {
    const base = makeBaseFetch([200]);
    const f = makeProactiveAuthFetch({
      provider,
      allowedOrigins: () => new Set<string>(),
      issuerOrigins: () => NO_ISSUER,
      baseFetch: base.fn,
    });
    await f("https://storage.example/alice/1");
    expect(base.seen[0].authorization).toBeNull();
  });

  it("retries ONCE with a forced refresh on a stale-token 401, then surfaces the result", async () => {
    const base = makeBaseFetch([401, 200]); // first (proactive) rejected, retry ok
    const f = makeProactiveAuthFetch({ provider, allowedOrigins: () => ALLOWED, issuerOrigins: () => NO_ISSUER, baseFetch: base.fn });

    const r = await f("https://storage.example/alice/1");
    expect(r.status).toBe(200);
    expect(base.seen).toHaveLength(2);
    expect(base.seen[0].authorization).toBe("DPoP token"); // proactive
    expect(base.seen[1].authorization).toBe("DPoP fresh-token"); // forced-refresh retry
    expect(provider.invalidate).toHaveBeenCalledTimes(1);
    expect(provider.upgrade).toHaveBeenCalledTimes(2);
  });

  it("is BOUNDED: a still-401 after the retry surfaces the 401 (never loops)", async () => {
    const base = makeBaseFetch([401, 401]);
    const f = makeProactiveAuthFetch({ provider, allowedOrigins: () => ALLOWED, issuerOrigins: () => NO_ISSUER, baseFetch: base.fn });

    const r = await f("https://storage.example/alice/1");
    expect(r.status).toBe(401);
    expect(base.seen).toHaveLength(2); // exactly two — no third attempt
  });

  it("retries-once on a use_dpop_nonce 401 too (no worse than the old manager)", async () => {
    // The PM provider does not yet embed RS DPoP nonces, so a strict-nonce server cannot
    // be satisfied from the wrapper — but we must not REGRESS vs the old manager, which
    // retried once on ANY post-upgrade 401. So a nonce-401 is also retried once (then
    // surfaced if still 401). A refreshed token may carry a server-bound nonce on some
    // servers, so the retry can succeed; here the scripted base 401s twice → surfaced.
    // A pure-nonce 401 on the first try; the forced-refresh retry then succeeds.
    const nonceBase = (() => {
      const seen: (string | null)[] = [];
      let i = 0;
      const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input as RequestInfo, init);
        seen.push(req.headers.get("authorization"));
        const status = i++ === 0 ? 401 : 200; // retry succeeds
        return new Response(null, {
          status,
          headers: status === 401 ? { "WWW-Authenticate": 'DPoP error="use_dpop_nonce"' } : {},
        });
      }) as typeof fetch;
      return { fn, seen };
    })();
    const f = makeProactiveAuthFetch({
      provider,
      allowedOrigins: () => ALLOWED,
      issuerOrigins: () => NO_ISSUER,
      baseFetch: nonceBase.fn,
    });

    const r = await f("https://storage.example/alice/1");
    expect(r.status).toBe(200);
    expect(nonceBase.seen).toHaveLength(2); // retried once
    expect(nonceBase.seen[1]).toBe("DPoP fresh-token"); // with a refreshed token
    expect(provider.invalidate).toHaveBeenCalledTimes(1);
  });

  it("reads the allowed-origin set FRESH per request (post-login storage change)", async () => {
    let allowed: ReadonlySet<string> = new Set<string>();
    const base = makeBaseFetch([200, 200]);
    const f = makeProactiveAuthFetch({
      provider,
      allowedOrigins: () => allowed,
      issuerOrigins: () => NO_ISSUER,
      baseFetch: base.fn,
    });

    await f("https://storage.example/alice/1"); // boundary empty → unauthenticated
    allowed = ALLOWED; // session resolves, storage origin learned
    await f("https://storage.example/alice/2"); // now authenticated, no re-install

    expect(base.seen[0].authorization).toBeNull();
    expect(base.seen[1].authorization).toBe("DPoP token");
  });

  it("does not require invalidate (provider without it just surfaces the 401)", async () => {
    provider = makeProvider({ invalidate: undefined });
    const base = makeBaseFetch([401]);
    const f = makeProactiveAuthFetch({ provider, allowedOrigins: () => ALLOWED, issuerOrigins: () => NO_ISSUER, baseFetch: base.fn });

    const r = await f("https://storage.example/alice/1");
    expect(r.status).toBe(401);
    expect(base.seen).toHaveLength(1);
  });
});

describe("isProviderOAuthRequest — issuer-scoped: keep the provider's own OAuth calls out", () => {
  const ISSUERS = new Set(["https://idp.example"]);

  it("flags an ISSUER-ORIGIN request carrying a DPoP proof (oauth4webapi token/refresh)", () => {
    expect(
      isProviderOAuthRequest(
        new Request("https://idp.example/anything", { headers: { dpop: "proof" } }),
        ISSUERS,
      ),
    ).toBe(true);
  });

  it("flags ISSUER-ORIGIN well-known + /.oidc discovery (header-less GET)", () => {
    expect(
      isProviderOAuthRequest(
        new Request("https://idp.example/.well-known/openid-configuration"),
        ISSUERS,
      ),
    ).toBe(true);
    expect(isProviderOAuthRequest(new Request("https://idp.example/.oidc/auth?x=1"), ISSUERS)).toBe(
      true,
    );
  });

  it("does NOT flag an issuer-origin request that carries ONLY Authorization (a pre-authed resource)", () => {
    // The header signal is the DPoP PROOF, not Authorization: a caller that pre-authed a
    // resource on the IdP-shared origin with only an Authorization header must keep the
    // wrapper's stale-token retry (the roborev finding), not be bypassed as OAuth traffic.
    expect(
      isProviderOAuthRequest(
        new Request("https://idp.example/alice/doc", {
          method: "PUT",
          headers: { authorization: "Bearer x" },
        }),
        ISSUERS,
      ),
    ).toBe(false);
  });

  it("does NOT flag a request to a NON-issuer origin even with a DPoP header (resource write)", () => {
    // The bypass is issuer-scoped — a write to the pod (different origin) is never mistaken
    // for OAuth infrastructure.
    expect(
      isProviderOAuthRequest(
        new Request("https://storage.example/alice/doc", {
          method: "PUT",
          headers: { dpop: "x" },
        }),
        ISSUERS,
      ),
    ).toBe(false);
  });

  it("does NOT flag an ordinary pod read on the issuer's SHARED origin (no headers, normal path)", () => {
    // CSS topology: pod + IdP share an origin. A `/alice/…` read (no OAuth path, no pre-set
    // header) is NOT OAuth infrastructure → still gets proactively authenticated.
    expect(isProviderOAuthRequest(new Request("https://idp.example/alice/notes/1"), ISSUERS)).toBe(
      false,
    );
    expect(
      isProviderOAuthRequest(new Request("https://idp.example/alice/token-list.ttl"), ISSUERS),
    ).toBe(false);
  });

  it("flags nothing when there are no issuer origins (logged out)", () => {
    expect(
      isProviderOAuthRequest(
        new Request("https://idp.example/.oidc/token", { headers: { dpop: "x" } }),
        new Set<string>(),
      ),
    ).toBe(false);
  });
});

describe("the wrapper does NOT upgrade the provider's own OAuth requests", () => {
  // The dance fix: the issuer origin is in the allowed set (a CSS pod shares its IdP's
  // origin), so a provider-internal OAuth call would otherwise be upgraded — overwriting
  // oauth4webapi's own Authorization/DPoP and risking recursion (the roborev finding).
  const SAME_ORIGIN = new Set(["https://podidp.example"]);

  it("leaves a header-less /.oidc discovery GET unauthenticated (no upgrade, no recursion)", async () => {
    const provider = makeProvider();
    const base = makeBaseFetch([200]);
    const f = makeProactiveAuthFetch({
      provider,
      allowedOrigins: () => SAME_ORIGIN,
      issuerOrigins: () => SAME_ORIGIN,
      baseFetch: base.fn,
      canAttachNonInteractively: () => true,
    });

    await f("https://podidp.example/.oidc/auth?response_type=code");
    expect(base.seen[0].authorization).toBeNull();
    expect(provider.upgrade).not.toHaveBeenCalled();
  });

  it("does NOT overwrite oauth4webapi's headers on a token request to the same-origin IdP", async () => {
    const provider = makeProvider();
    const seen: { url: string; authorization: string | null; dpop: string | null }[] = [];
    const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input as RequestInfo, init);
      seen.push({
        url: req.url,
        authorization: req.headers.get("authorization"),
        dpop: req.headers.get("dpop"),
      });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const f = makeProactiveAuthFetch({
      provider,
      allowedOrigins: () => SAME_ORIGIN,
      issuerOrigins: () => SAME_ORIGIN,
      baseFetch: base,
      canAttachNonInteractively: () => true,
    });

    // oauth4webapi would set its own client-auth + DPoP proof; simulate that.
    await f("https://podidp.example/.oidc/token", {
      method: "POST",
      headers: { authorization: "Basic clientcreds", dpop: "oauth-own-proof" },
      body: "grant_type=refresh_token",
    });

    expect(provider.upgrade).not.toHaveBeenCalled(); // not re-upgraded → no recursion
    expect(seen[0].authorization).toBe("Basic clientcreds"); // oauth4webapi's own header kept
    expect(seen[0].dpop).toBe("oauth-own-proof");
  });

  it("STILL upgrades an ordinary resource read on the same shared origin", async () => {
    // The bypass must be SURGICAL — a real pod read on the IdP-shared origin is still
    // proactively authenticated (otherwise we'd reintroduce the dance for CSS pods).
    const provider = makeProvider();
    const base = makeBaseFetch([200]);
    const f = makeProactiveAuthFetch({
      provider,
      allowedOrigins: () => SAME_ORIGIN,
      issuerOrigins: () => SAME_ORIGIN,
      baseFetch: base.fn,
      canAttachNonInteractively: () => true,
    });

    await f("https://podidp.example/alice/notes/1");
    expect(base.seen[0].authorization).toBe("DPoP token");
    expect(provider.upgrade).toHaveBeenCalledTimes(1);
  });
});

describe("body handling — the 401 retry is body-safe", () => {
  it("replays a bodied PUT on a stale-token 401 (clone tees the body)", async () => {
    const provider = makeProvider();
    const bodies: string[] = [];
    let i = 0;
    const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input as RequestInfo, init);
      bodies.push(await req.text());
      return new Response(null, {
        status: i++ === 0 ? 401 : 200,
        headers: i === 1 ? { "WWW-Authenticate": 'DPoP error="invalid_token"' } : {},
      });
    }) as typeof fetch;
    const f = makeProactiveAuthFetch({
      provider,
      allowedOrigins: () => ALLOWED,
      issuerOrigins: () => NO_ISSUER,
      baseFetch: base,
      canAttachNonInteractively: () => true,
    });

    const r = await f("https://storage.example/alice/doc", { method: "PUT", body: "hello" });
    expect(r.status).toBe(200);
    // The retry re-sent the SAME body, not an empty/consumed stream.
    expect(bodies).toEqual(["hello", "hello"]);
  });

  it("CANCELS the unused clone's body on the SUCCESS (no-retry) path (no tee buffering)", async () => {
    // A bodied request that succeeds on the first try must NOT leave its retry-clone's body
    // tee'd and unread (which can buffer indefinitely on large/streaming uploads — the
    // roborev finding). We assert the clone's body stream is cancelled.
    const provider = makeProvider();
    const base = makeBaseFetch([200]); // first try succeeds → no retry
    const f = makeProactiveAuthFetch({
      provider,
      allowedOrigins: () => ALLOWED,
      issuerOrigins: () => NO_ISSUER,
      baseFetch: base.fn,
      canAttachNonInteractively: () => true,
    });

    // Spy on ReadableStream.cancel to confirm the unused clone body is cancelled.
    const cancelled: unknown[] = [];
    const origCancel = ReadableStream.prototype.cancel;
    ReadableStream.prototype.cancel = function (reason) {
      cancelled.push(reason ?? "cancel");
      return origCancel.call(this, reason);
    };
    try {
      const r = await f("https://storage.example/alice/doc", { method: "PUT", body: "payload" });
      expect(r.status).toBe(200);
      // The clone's body was cancelled (at least once) rather than left tee'd + unread.
      expect(cancelled.length).toBeGreaterThanOrEqual(1);
    } finally {
      ReadableStream.prototype.cancel = origCancel;
    }
  });

  it("CANCELS the unused clone's body even when upgrade()/fetch THROWS (try/finally)", async () => {
    // If the upgrade/fetch flow throws after cloning, the tee'd clone must still be cancelled
    // (the roborev finding — the cancel lives in a `finally`). We assert the call rejects
    // (propagating the error) AND the clone body was cancelled.
    const provider = makeProvider({
      upgrade: vi.fn(async () => {
        throw new Error("upgrade boom");
      }),
    });
    const base = makeBaseFetch([200]);
    const f = makeProactiveAuthFetch({
      provider,
      allowedOrigins: () => ALLOWED,
      issuerOrigins: () => NO_ISSUER,
      baseFetch: base.fn,
      canAttachNonInteractively: () => true,
    });

    const cancelled: unknown[] = [];
    const origCancel = ReadableStream.prototype.cancel;
    ReadableStream.prototype.cancel = function (reason) {
      cancelled.push(reason ?? "cancel");
      return origCancel.call(this, reason);
    };
    try {
      await expect(
        f("https://storage.example/alice/doc", { method: "PUT", body: "payload" }),
      ).rejects.toThrow("upgrade boom");
      expect(cancelled.length).toBeGreaterThanOrEqual(1); // clone cancelled despite the throw
    } finally {
      ReadableStream.prototype.cancel = origCancel;
    }
  });

  it("a bodyless GET retries from the request itself (no clone needed)", async () => {
    // A bodyless request is its own replay source — the wrapper must NOT depend on clone()
    // for it, and the stale-token retry still works.
    const provider = makeProvider();
    const base = makeBaseFetch([401, 200]);
    const f = makeProactiveAuthFetch({
      provider,
      allowedOrigins: () => ALLOWED,
      issuerOrigins: () => NO_ISSUER,
      baseFetch: base.fn,
      canAttachNonInteractively: () => true,
    });

    const r = await f("https://storage.example/alice/1"); // GET, no body
    expect(r.status).toBe(200);
    expect(base.seen).toHaveLength(2); // retried once from the (bodyless) request itself
  });

  it("does not throw on a streaming-body request (clone is guarded)", async () => {
    // A streaming body whose 401 retry can't safely replay must surface the response, never
    // throw out of the wrapper (the clone is wrapped in try/catch; on failure the retry is
    // skipped). We assert the call RESOLVES to a Response rather than rejecting.
    const provider = makeProvider();
    const base = makeBaseFetch([401]);
    const f = makeProactiveAuthFetch({
      provider,
      allowedOrigins: () => ALLOWED,
      issuerOrigins: () => NO_ISSUER,
      baseFetch: base.fn,
      canAttachNonInteractively: () => true,
    });

    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("chunk"));
        c.close();
      },
    });
    await expect(
      f("https://storage.example/alice/doc", {
        method: "PUT",
        body: stream,
        // @ts-expect-error duplex is required by the runtime for a stream body
        duplex: "half",
      }),
    ).resolves.toBeInstanceOf(Response);
  });
});
