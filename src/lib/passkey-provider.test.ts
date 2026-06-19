// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
// vitest — node env. Exercises the composer that slots the passkey provider into
// the #123 SINGLE-provider proactive-auth-fetch model (replacing the old
// ReactiveFetchManager first-matches-wins array). No DOM, no network.
import { describe, it, expect, vi } from "vitest";
import type { AuthTokenProvider } from "./proactive-auth-fetch.js";
import type { WebIdBoundWebAuthnProvider } from "./webauthn-reauth.js";
import { composePasskeyProvider } from "./passkey-provider.js";

const STORAGE = "https://alice.solid-test.jeswr.org/storage/";
const OTHER = "https://other.example/x";

/** A fake interactive provider that tags its outputs so we can assert delegation. */
function fakeInteractive() {
  const matches = vi.fn(async () => true);
  // Note: the mock's declared arity is 1, but vitest still records the actual
  // 2-arg call (req, forceRefresh) so `toHaveBeenCalledWith(req, true)` works.
  const upgrade = vi.fn(
    async (req: Request) => new Request(req, { headers: { "x-interactive": "1" } }),
  );
  const invalidate = vi.fn(async () => {});
  const provider: AuthTokenProvider = { matches, upgrade, invalidate };
  return { provider, matches, upgrade, invalidate };
}

/** A fake passkey provider with a configurable host matcher + upgrade tag. */
function fakePasskey(matchesHost: boolean) {
  const matches = vi.fn(async (req: Request) => req.url.startsWith(STORAGE) && matchesHost);
  const upgrade = vi.fn(
    async (req: Request) => new Request(req, { headers: { "x-passkey": "1" } }),
  );
  const provider = { matches, upgrade } as unknown as WebIdBoundWebAuthnProvider;
  return { provider, matches, upgrade };
}

describe("composePasskeyProvider", () => {
  it("returns the interactive provider UNCHANGED when there is no passkey provider", () => {
    const { provider } = fakeInteractive();
    expect(composePasskeyProvider(provider, undefined)).toBe(provider);
  });

  it("delegates matches to the INTERACTIVE provider (the structural contract owner)", async () => {
    const i = fakeInteractive();
    const p = fakePasskey(true);
    const composed = composePasskeyProvider(i.provider, p.provider);
    await expect(composed.matches(new Request(STORAGE))).resolves.toBe(true);
    expect(i.matches).toHaveBeenCalledOnce();
    // matches must NOT consult the passkey host matcher (that is upgrade-only).
    expect(p.matches).not.toHaveBeenCalled();
  });

  it("routes upgrade through the PASSKEY path when its host matcher matches", async () => {
    const i = fakeInteractive();
    const p = fakePasskey(true);
    const composed = composePasskeyProvider(i.provider, p.provider);
    const out = await composed.upgrade(new Request(`${STORAGE}private/notes`));
    expect(out.headers.get("x-passkey")).toBe("1");
    expect(out.headers.get("x-interactive")).toBeNull();
    expect(i.upgrade).not.toHaveBeenCalled();
  });

  it("routes upgrade through the INTERACTIVE path when the passkey host matcher declines", async () => {
    const i = fakeInteractive();
    const p = fakePasskey(true); // matches only the STORAGE host
    const composed = composePasskeyProvider(i.provider, p.provider);
    const out = await composed.upgrade(new Request(OTHER));
    expect(out.headers.get("x-interactive")).toBe("1");
    expect(out.headers.get("x-passkey")).toBeNull();
    expect(p.upgrade).not.toHaveBeenCalled();
  });

  it("never lets the passkey host matcher widen the request set — a non-passkey host still gets interactive", async () => {
    const i = fakeInteractive();
    const p = fakePasskey(false); // passkey registered but matcher disabled for the test
    const composed = composePasskeyProvider(i.provider, p.provider);
    const out = await composed.upgrade(new Request(`${STORAGE}x`));
    expect(out.headers.get("x-interactive")).toBe("1");
    expect(p.upgrade).not.toHaveBeenCalled();
  });

  it("delegates invalidate to the INTERACTIVE provider (the stale-token retry owner)", async () => {
    const i = fakeInteractive();
    const p = fakePasskey(true);
    const composed = composePasskeyProvider(i.provider, p.provider);
    const req = new Request(STORAGE);
    await composed.invalidate?.(req);
    expect(i.invalidate).toHaveBeenCalledWith(req);
  });

  it("omits invalidate when the interactive provider has none", () => {
    const matches = vi.fn(async () => true);
    const upgrade = vi.fn(async (req: Request) => req);
    const noInvalidate: AuthTokenProvider = { matches, upgrade };
    const p = fakePasskey(true);
    const composed = composePasskeyProvider(noInvalidate, p.provider);
    expect(composed.invalidate).toBeUndefined();
  });

  it("forwards forceRefresh on the interactive path (the stale-token retry's second arg)", async () => {
    const i = fakeInteractive();
    const p = fakePasskey(false);
    const composed = composePasskeyProvider(i.provider, p.provider);
    await composed.upgrade(new Request(OTHER), true);
    expect(i.upgrade).toHaveBeenCalledWith(expect.any(Request), true);
  });

  it("forwards forceRefresh on the PASSKEY path too (so its fallback delegation refreshes — roborev Finding 2)", async () => {
    const i = fakeInteractive();
    const p = fakePasskey(true); // matcher matches the STORAGE host → passkey path
    const composed = composePasskeyProvider(i.provider, p.provider);
    await composed.upgrade(new Request(`${STORAGE}private/notes`), true);
    // The composer must hand forceRefresh to passkey.upgrade so that WHEN that
    // upgrade delegates to its interactive fallback on a stale-token retry, the
    // fallback mints a fresh token rather than reusing the rejected cached one.
    expect(p.upgrade).toHaveBeenCalledWith(expect.any(Request), true);
    expect(i.upgrade).not.toHaveBeenCalled();
  });
});
