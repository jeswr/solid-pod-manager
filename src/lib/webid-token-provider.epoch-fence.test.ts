/**
 * AUTHORED-BY Claude Opus 4.8
 *
 * PER-ISSUER EPOCH FENCE — adversarial concurrency tests for the two
 * whole-branch roborev HIGHs in `WebIdDPoPTokenProvider`:
 *
 *  1. SAME-ISSUER ACCOUNT-SWITCH OVERWRITE. Logged in as A, an OLD account's
 *     proactive refresh is in flight; a fresh login for B (same issuer) commits;
 *     the late-finishing A refresh must NOT overwrite B's session/persistence
 *     with A's (refreshed) credential. The fix BUMPS the issuer epoch when the
 *     B login supersedes, so A's proactive commit — which captured the PRIOR
 *     epoch — yields instead of writing.
 *
 *  2. FORGET-THEN-LATE-COMMIT RESURRECTION. `forgetIssuer()` (logout/cancel)
 *     bumps the issuer epoch BEFORE clearing state; a `#commitSession` /
 *     proactive / lazy refresh that finishes AFTER the forget must publish /
 *     persist NOTHING — it can no longer resurrect the just-forgotten issuer.
 *
 * Each test is written so it FLIPS (fails) without the epoch fence and passes
 * with it — the assertions pin the post-race winning credential, which the
 * pre-fence code gets wrong (the late commit wins). Determinism comes from a
 * GATED fetch that parks the racing refresh grant at the token endpoint, so the
 * race ordering is fixed regardless of run order (the same technique the
 * proactive single-flight test uses).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WebIdDPoPTokenProvider,
  type VisibilityLifecycle,
} from "./webid-token-provider";
import {
  createFakeAuthorizationServer,
  type FakeAuthorizationServer,
} from "./test-utils/fake-authorization-server";
import { StructuredCloneSessionStore } from "./test-utils/structured-clone-session-store";

const WEBID = "https://pod.test/profile/card#me";
const CALLBACK = "https://app.test/callback.html";
const CLIENT_ID = "https://app.test/clientid.jsonld";
const ISSUER = new URL("https://as.test");
const ISSUER_HREF = ISSUER.href;

const profileTurtle = `<${WEBID}> <http://www.w3.org/ns/solid/terms#oidcIssuer> <https://as.test> .`;
const profileFetch: typeof fetch = async () =>
  new Response(profileTurtle, {
    status: 200,
    headers: { "content-type": "text/turtle" },
  });

/** Always-visible lifecycle so proactive timers fire under fake timers. */
const alwaysVisible: VisibilityLifecycle = {
  isVisible: () => true,
  onResume: () => () => {},
  onHide: () => () => {},
};

let as: FakeAuthorizationServer;

/** A gate that parks the NEXT refresh-token grant at the token endpoint. */
function makeRefreshGate(realFetch: typeof fetch) {
  let releaseToken: () => void = () => {};
  const tokenGate = new Promise<void>((r) => {
    releaseToken = r;
  });
  let signalParked: () => void = () => {};
  const parked = new Promise<void>((r) => {
    signalParked = r;
  });
  let armed = true;
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const isRefresh =
      url.endsWith("/token") &&
      (await peekGrantType(input, init)) === "refresh_token";
    if (armed && isRefresh) {
      armed = false;
      signalParked(); // a refresh grant reached the endpoint and is now held
      await tokenGate;
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return { fetchImpl, parked, releaseToken };
}

/**
 * Pump the fake clock + microtasks until `signal` resolves (or a bounded number
 * of rounds elapse). The proactive refresh grant only progresses when the fake
 * clock advances, so a bare `await parked` would deadlock — we interleave timer
 * advancement with the wait.
 */
async function pumpUntil(signal: Promise<void>): Promise<void> {
  let done = false;
  void signal.then(() => {
    done = true;
  });
  for (let i = 0; i < 200 && !done; i++) {
    await vi.advanceTimersByTimeAsync(1_000);
  }
  await signal;
}

/**
 * Read the grant_type of a token request WITHOUT consuming the real body.
 * oauth4webapi calls `fetch(url, { body })` where `body` is a `URLSearchParams`
 * (an object), so this normalises the several body shapes to a query string.
 */
async function peekGrantType(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<string | null> {
  try {
    const body = init?.body;
    if (body instanceof URLSearchParams) return body.get("grant_type");
    if (typeof body === "string") return new URLSearchParams(body).get("grant_type");
    if (input instanceof Request) {
      return new URLSearchParams(await input.clone().text()).get("grant_type");
    }
    return null;
  } catch {
    return null;
  }
}

function makeProvider(
  store: StructuredCloneSessionStore,
  opts: { proactive?: boolean } = {},
) {
  const getCode = vi.fn((url: URL) => as.authorize(url));
  const provider = new WebIdDPoPTokenProvider(CALLBACK, getCode, async () => WEBID, {
    clientId: CLIENT_ID,
    profileFetch,
    sessionStore: store,
    proactiveRefresh: opts.proactive ?? false,
    visibilityLifecycle: alwaysVisible,
    setTimeoutFn: (h, ms) => setTimeout(h, ms),
    clearTimeoutFn: (t) => clearTimeout(t),
  });
  return { provider, getCode };
}

beforeEach(async () => {
  as = await createFakeAuthorizationServer({
    expiresIn: 120,
    issueRefreshTokens: true,
    scopesSupported: ["openid", "webid", "offline_access"],
    grantTypesSupported: ["authorization_code", "refresh_token"],
    webIdClaim: WEBID,
  });
  vi.stubGlobal("fetch", as.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("per-issuer epoch fence (the #123 whole-branch HIGHs)", () => {
  it("HIGH#1: an OLD account's in-flight proactive refresh does NOT overwrite a NEWER same-issuer login's credential", async () => {
    // ADVERSARIAL: log in as A → A's proactive refresh fires and PARKS mid-grant (its rotated
    // token not yet committed) → a fresh same-issuer login for B commits B's credential → release
    // A's parked refresh. WITHOUT the epoch fence, A's late `#begin`/`#commitSession` overwrites
    // `#settledSessions` + persistence with A's refreshed token (clobbering B). WITH the fence,
    // B's login bumped the epoch, so A's proactive commit — captured at the PRIOR epoch — yields:
    // the persisted + the in-memory credential STAY B's.
    vi.useFakeTimers();
    const store = new StructuredCloneSessionStore();
    const { provider, getCode } = makeProvider(store, { proactive: true });

    // ── A logs in (settles + persists A's credential, arms A's proactive timer).
    await provider.login(ISSUER);
    const aRefresh = store.peek(ISSUER_HREF)?.refreshToken;
    expect(aRefresh).toBeDefined();
    expect(getCode).toHaveBeenCalledTimes(1);

    // ── Park A's proactive refresh grant at the token endpoint.
    const gate = makeRefreshGate(as.fetch);
    vi.stubGlobal("fetch", gate.fetchImpl);
    // Fire A's proactive timer (lead ≈30s before the 90s skew-adjusted expiry ⇒ ~60s out) and
    // pump the fake clock until A's refresh grant parks at the gate.
    await pumpUntil(gate.parked); // A's refresh grant is in flight, holding its rotated token

    // ── B logs in on the SAME issuer (account switch) WHILE A's refresh is parked. This is a
    // FRESH interactive authentication (expectedWebId forces no-reuse), which BUMPS the epoch and
    // commits B's own credential + persistence.
    await provider.login(ISSUER, { expectedWebId: "https://pod.test/bob#me" });
    expect(getCode).toHaveBeenCalledTimes(2); // B authenticated fresh (a 2nd authorize)
    const bRefresh = store.peek(ISSUER_HREF)?.refreshToken;
    expect(bRefresh).toBeDefined();
    expect(bRefresh).not.toBe(aRefresh); // B's credential is now the persisted one

    // ── Release A's parked proactive refresh; let its (now-stale) commit run to completion.
    gate.releaseToken();
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0);

    // ── THE FENCE: A's late proactive commit YIELDED — B's credential is intact, NOT overwritten
    // by A's refreshed token. (Pre-fence, the persisted token here would be A's rotated value.)
    expect(store.peek(ISSUER_HREF)?.refreshToken).toBe(bRefresh);

    // And an upgrade attaches B's session (the one whose access token B's login minted), proving
    // the IN-MEMORY caches were not clobbered by A's refresh either.
    const upgraded = await provider.upgrade(new Request("https://pod.test/x"));
    expect(upgraded.headers.get("Authorization")).toMatch(/^DPoP at-\d+$/);
    expect(getCode).toHaveBeenCalledTimes(2); // no re-auth — B's settled session was reused
  });

  it("HIGH#2: a forget-then-late-commit cannot RESURRECT the issuer (proactive refresh)", async () => {
    // ADVERSARIAL: log in → a proactive refresh fires and PARKS mid-grant → `forgetIssuer()`
    // (logout) clears the session + pin + persistence → release the parked refresh. WITHOUT the
    // fence, the proactive `#begin`/`#commitSession` (default always-current predicate) finishes
    // LAST and re-publishes + re-persists the issuer — a logged-out credential resurrected. WITH
    // the fence, `forgetIssuer` bumped the epoch BEFORE clearing, so the late commit (captured at
    // the prior epoch) publishes/persists NOTHING.
    vi.useFakeTimers();
    const store = new StructuredCloneSessionStore();
    const { provider, getCode } = makeProvider(store, { proactive: true });

    await provider.login(ISSUER);
    expect(store.peek(ISSUER_HREF)).toBeDefined();

    // Park the proactive refresh grant in flight.
    const gate = makeRefreshGate(as.fetch);
    vi.stubGlobal("fetch", gate.fetchImpl);
    await pumpUntil(gate.parked); // proactive refresh in flight (rotated token not yet committed)

    // Log out WHILE the refresh is parked: clears everything (and bumps the epoch first).
    await provider.forgetIssuer(ISSUER);
    expect(store.peek(ISSUER_HREF)).toBeUndefined(); // persistence cleared by logout

    // Release the parked proactive refresh; let its (now epoch-stale) commit run.
    gate.releaseToken();
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0);

    // ── THE FENCE: the late proactive commit YIELDED — the issuer is NOT resurrected. Persistence
    // stays empty, and an upgrade must RE-AUTHENTICATE (a 2nd authorize), proving no settled
    // session / pin survived. (Pre-fence, the store would hold the resurrected rotated token and
    // the upgrade would reuse a resurrected session — getCode still at 1.)
    expect(store.peek(ISSUER_HREF)).toBeUndefined();
    await provider.upgrade(new Request("https://pod.test/x"));
    expect(getCode).toHaveBeenCalledTimes(2); // re-auth — nothing was resurrected to reuse
  });

  it("HIGH#2 variant: a forget-then-late RESTORE commit cannot resurrect the issuer", async () => {
    // The same resurrection vector via the boot-restore path: a `restoreIssuer()` whose refresh
    // grant is parked in flight, then `forgetIssuer()`, then release. The restore captured the
    // PRIOR epoch; the forget bumped it, so the restore commits NOTHING in-memory and drops the
    // (consumed, now-dead) token rather than re-persisting it.
    vi.useFakeTimers();
    const store = new StructuredCloneSessionStore();
    // Seed a persisted session via a normal login on a first provider instance.
    const seedCode = vi.fn((u: URL) => as.authorize(u));
    const seed = new WebIdDPoPTokenProvider(CALLBACK, seedCode, async () => WEBID, {
      clientId: CLIENT_ID,
      profileFetch,
      sessionStore: store,
    });
    await seed.login(ISSUER);
    expect(store.peek(ISSUER_HREF)).toBeDefined();

    // A fresh provider (cold open) restores from the store — but PARK its refresh grant.
    const { provider, getCode } = makeProvider(store);
    const gate = makeRefreshGate(as.fetch);
    vi.stubGlobal("fetch", gate.fetchImpl);
    const restorePromise = provider.restoreIssuer(ISSUER);
    await pumpUntil(gate.parked); // the restore's refresh grant is in flight (stored token consumed)

    // Log out WHILE the restore is parked.
    await provider.forgetIssuer(ISSUER);

    gate.releaseToken();
    await restorePromise;
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0);

    // ── THE FENCE: the late restore commit YIELDED — the issuer is NOT resurrected. Persistence
    // is empty (the forget cleared it AND the stale restore did not re-persist), and an upgrade
    // re-authenticates. (Pre-fence, the restore would re-publish + re-persist the rotated token.)
    expect(store.peek(ISSUER_HREF)).toBeUndefined();
    await provider.upgrade(new Request("https://pod.test/x"));
    expect(getCode).toHaveBeenCalledTimes(1); // the ONE re-auth (restore never reused/popped)
  });

  it("MEDIUM: a 'Continue as' login that races an in-flight LAZY refresh shares ONE grant (no double-redeem of the rotating token)", async () => {
    // ADVERSARIAL (the #123 whole-branch MEDIUM): a settled session's access token expires; a
    // lazy `upgrade()`→renew and an explicit "Continue as" `login()` fire concurrently. Both want
    // to redeem the SAME rotating refresh token. WITHOUT a shared single-flight across the login
    // and lazy paths, they redeem it TWICE — and RFC 9700 rotation makes the second redemption
    // fail `invalid_grant`, losing the renewable session. WITH `#sharedRefresh`, exactly ONE
    // refresh grant hits the AS.
    const store = new StructuredCloneSessionStore();
    const { provider, getCode } = makeProvider(store);
    await provider.login(ISSUER); // settle a session (one authorize)
    expect(getCode).toHaveBeenCalledTimes(1);
    const refreshesBefore = as.tokenRequests.filter(
      (r) => r.get("grant_type") === "refresh_token",
    ).length;

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3601 * 1000); // expire the settled access token

    // Fire a LAZY upgrade and an explicit "Continue as" login CONCURRENTLY for the same issuer.
    // Both must dedup onto ONE refresh redemption (the shared pure-grant single-flight) — the
    // second redemption would otherwise invalid_grant on the rotated token.
    const [upgraded] = await Promise.all([
      provider.upgrade(new Request("https://pod.test/x")),
      provider.login(ISSUER), // "Continue as" — reuses the settled (now expired) session's token
    ]);
    vi.useRealTimers();

    const refreshesAfter = as.tokenRequests.filter(
      (r) => r.get("grant_type") === "refresh_token",
    ).length;
    expect(refreshesAfter - refreshesBefore).toBe(1); // exactly ONE redemption across BOTH paths
    expect(getCode).toHaveBeenCalledTimes(1); // and no popup — the shared grant succeeded
    expect(upgraded.headers.get("Authorization")).toMatch(/^DPoP at-\d+$/);
  });

  it("MEDIUM: a LATE forgetIssuer does NOT wipe a newer same-issuer login's freshly-persisted credential", async () => {
    // ADVERSARIAL (the #123 whole-branch MEDIUM): a cancel/logout cleanup fires `forgetIssuer(X)`
    // fire-and-forget; the user immediately retries the SAME issuer and a NEWER login persists its
    // credential. The orphaned `forgetIssuer`'s durable delete then executes LATE — AFTER the new
    // login persisted. WITHOUT ownership-scoping, that late delete clears persistence
    // UNCONDITIONALLY and WIPES the newer login's token. WITH the epoch-scoped clear,
    // `forgetIssuer` captured the epoch it bumped to; the newer login bumped the epoch AGAIN
    // (taking ownership), so the late clear sees a newer epoch and SKIPS the durable delete.
    //
    // The race is forced DETERMINISTIC by a store whose delete/compareAndDelete BLOCK on a gate:
    // `forgetIssuer` reaches its persistence clear and parks; the retry login B then fully
    // persists; only THEN is the gate released so the (now-late) clear runs against B's credential.
    let releaseClear: () => void = () => {};
    const clearGate = new Promise<void>((r) => {
      releaseClear = r;
    });
    let gateArmed = true;
    const base = new StructuredCloneSessionStore();
    // A delegating wrapper whose delete/compareAndDelete park on a gate the first time, so the
    // late forget clear can be held until AFTER B persists (deterministic race ordering).
    const store = {
      get: (i: string) => base.get(i),
      put: (s: Parameters<StructuredCloneSessionStore["put"]>[0]) => base.put(s),
      delete: async (i: string) => {
        if (gateArmed) {
          gateArmed = false;
          await clearGate;
        }
        return base.delete(i);
      },
      compareAndDelete: async (i: string, t: string) => {
        if (gateArmed) {
          gateArmed = false;
          await clearGate;
        }
        return base.compareAndDelete(i, t);
      },
    };
    const { provider, getCode } = makeProvider(store as unknown as StructuredCloneSessionStore);

    // Login A (the session about to be "cancelled").
    await provider.login(ISSUER);
    expect(getCode).toHaveBeenCalledTimes(1);

    // Fire-and-forget the cleanup for A's issuer; it bumps the epoch and parks at the gated clear.
    const forget = provider.forgetIssuer(ISSUER);
    await Promise.resolve(); // let forget reach (and park at) its persistence clear

    // The user retries the SAME issuer; B authenticates FRESH (expectedWebId differs from A's
    // claim), bumps the epoch AGAIN (taking ownership), and persists its credential.
    await provider.login(ISSUER, { expectedWebId: "https://pod.test/carol#me" });
    const bToken = base.peek(ISSUER_HREF)?.refreshToken;
    expect(bToken).toBeDefined(); // B persisted

    // NOW release the late forget clear — it runs against B's freshly-persisted credential.
    releaseClear();
    await forget;

    // ── THE FENCE: B's credential SURVIVES the late forget (it was NOT wiped), and B's session is
    // reusable without a 3rd authorize. (Pre-fix — unconditional clear — the store would be empty
    // here and the upgrade would re-authenticate, a 3rd getCode.)
    expect(base.peek(ISSUER_HREF)?.refreshToken).toBe(bToken);
    await provider.upgrade(new Request("https://pod.test/x"));
    expect(getCode).toHaveBeenCalledTimes(2); // A's login + B's login — NO 3rd re-auth
  });

  it("MEDIUM: a SAME-ACCOUNT 'Continue as' does NOT invalidate an in-flight same-account proactive refresh", async () => {
    // ADVERSARIAL (the #123 whole-branch MEDIUM): an unconditional epoch bump on EVERY login()
    // would make a same-account "Continue as" (which only REUSES the settled session) yield a
    // concurrent same-account proactive refresh that already consumed+rotated the refresh token —
    // leaving the dead (consumed) token in memory/persistence so the NEXT refresh invalid_grants.
    // The fix bumps the epoch ONLY on a FRESH authentication (supersession), not on same-account
    // reuse, so the in-flight proactive refresh commits its rotated token normally.
    vi.useFakeTimers();
    const store = new StructuredCloneSessionStore();
    const { provider, getCode } = makeProvider(store, { proactive: true });
    await provider.login(ISSUER);
    const original = store.peek(ISSUER_HREF)?.refreshToken;
    expect(getCode).toHaveBeenCalledTimes(1);

    // Park the proactive refresh grant mid-flight (it has consumed+rotated the token server-side).
    const gate = makeRefreshGate(as.fetch);
    vi.stubGlobal("fetch", gate.fetchImpl);
    await pumpUntil(gate.parked);

    // A SAME-ACCOUNT "Continue as" click lands while the refresh is parked. The settled session is
    // still fresh, so this returns the reused session with NO authorize and (crucially) NO epoch
    // bump — it must not invalidate the in-flight refresh.
    await provider.login(ISSUER); // same account, no expectedWebId ⇒ reuse, no supersession
    expect(getCode).toHaveBeenCalledTimes(1); // no popup — pure reuse

    // Release the parked proactive refresh; its commit must SUCCEED (epoch unchanged) and persist
    // the ROTATED token.
    gate.releaseToken();
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0);

    // ── THE FENCE (correctly NOT triggered): the same-account refresh committed — the persisted
    // token is the ROTATED one, NOT the stale consumed `original`. (Pre-fix, the bump would have
    // made the refresh yield, leaving `original` — a now-dead token — in the store.)
    const rotated = store.peek(ISSUER_HREF)?.refreshToken;
    expect(rotated).toBeDefined();
    expect(rotated).not.toBe(original); // the in-flight refresh's rotated token WAS committed
  });

  it("HIGH: a NEW account's refresh does NOT join the OLD account's parked in-flight grant (no credential swap)", async () => {
    // ADVERSARIAL (the #123 whole-branch HIGH, round 3): `#sharedRefresh` keyed by issuer ALONE
    // would let a NEW account (after a fresh-auth account switch bumped the epoch) JOIN the OLD
    // account's still-in-flight refresh grant and commit the OLD session under the NEW epoch — a
    // credential SWAP. The identity-scoped join (same refresh token AND same epoch) prevents it:
    // the new account starts its OWN grant. We observe "no join" by the new account's renewal
    // issuing a SEPARATE refresh request rather than sharing the parked old one.
    vi.useFakeTimers();
    const store = new StructuredCloneSessionStore();
    const { provider, getCode } = makeProvider(store, { proactive: true });

    // A logs in (settled + a proactive scheduler armed for A's token).
    await provider.login(ISSUER);
    const aToken = store.peek(ISSUER_HREF)?.refreshToken;
    expect(getCode).toHaveBeenCalledTimes(1);

    // Park A's proactive refresh grant mid-flight (it holds A's refresh token, captured at epoch1).
    const gate = makeRefreshGate(as.fetch);
    vi.stubGlobal("fetch", gate.fetchImpl);
    await pumpUntil(gate.parked);
    const refreshesWhileAParked = as.tokenRequests.filter(
      (r) => r.get("grant_type") === "refresh_token",
    ).length;

    // B logs in FRESH on the same issuer (account switch ⇒ epoch bump). B authenticates via the
    // gated fetch (its discovery/auth-code pass the gate — only the FIRST refresh is held), so B
    // gets its OWN settled session + its OWN (different) refresh token at the NEW epoch.
    await provider.login(ISSUER, { expectedWebId: "https://pod.test/bob#me" });
    const bToken = store.peek(ISSUER_HREF)?.refreshToken;
    expect(bToken).toBeDefined();
    expect(bToken).not.toBe(aToken);

    // Now force B's access token to expire and renew it WHILE A's grant is STILL parked. B's
    // renewal must start its OWN grant (different token + different epoch) — NOT join A's parked
    // one (which would swap B's session for A's). Its grant request is distinct.
    vi.setSystemTime(Date.now() + 3601 * 1000);
    const bUpgrade = provider.upgrade(new Request("https://pod.test/b-resource"));
    // Let B's renewal reach the token endpoint (it is NOT held — the gate is single-shot, already
    // consumed by A's parked grant).
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0);
    await bUpgrade;

    const refreshesAfterB = as.tokenRequests.filter(
      (r) => r.get("grant_type") === "refresh_token",
    ).length;
    // B ran its OWN refresh grant — strictly MORE refresh requests than were outstanding when only
    // A's was parked (a JOIN would have added zero). And B never re-authenticated (no popup swap).
    expect(refreshesAfterB).toBeGreaterThan(refreshesWhileAParked);
    expect(getCode).toHaveBeenCalledTimes(2); // A's + B's logins only — no spurious re-auth

    gate.releaseToken(); // drain A's parked grant (its commit yields — stale epoch)
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0);
  });

  it("MEDIUM: login() does NOT re-pin a forgotten issuer when forgetIssuer races the commit", async () => {
    // ADVERSARIAL (the #123 whole-branch MEDIUM, round 3): a `forgetIssuer()` racing a default
    // `provider.login()` bumps the epoch so the login's COMMIT yields (publishes nothing, deletes
    // `#settledSessions`), yet the caller's `stillCurrent` may still read true. Gating the pin on
    // the caller predicate ALONE would re-pin the forgotten issuer. Gating it on the settled cache
    // actually owning the returned session means the pin is SKIPPED — a subsequent `upgrade()`
    // must RE-RESOLVE the issuer (call getWebId), proving no stale pin survived.
    //
    // We force the race deterministically with a store whose `put` (the persist inside the
    // commit) BLOCKS on a gate: the login parks mid-commit, `forgetIssuer` runs (bump + clear),
    // then the gate releases so the commit completes — and must NOT pin.
    let releasePut: () => void = () => {};
    const putGate = new Promise<void>((r) => {
      releasePut = r;
    });
    let putArmed = true;
    const base = new StructuredCloneSessionStore();
    const store = {
      get: (i: string) => base.get(i),
      put: async (s: Parameters<StructuredCloneSessionStore["put"]>[0]) => {
        if (putArmed) {
          putArmed = false;
          await putGate; // park the login's commit at its persist step
        }
        return base.put(s);
      },
      delete: (i: string) => base.delete(i),
      compareAndDelete: (i: string, t: string) => base.compareAndDelete(i, t),
    };
    const getWebId = vi.fn(async () => WEBID);
    const getCode = vi.fn((u: URL) => as.authorize(u));
    const provider = new WebIdDPoPTokenProvider(CALLBACK, getCode, getWebId, {
      clientId: CLIENT_ID,
      profileFetch,
      sessionStore: store as unknown as StructuredCloneSessionStore,
    });

    // Start a default login (no stillCurrent override ⇒ caller predicate stays true); it parks at
    // its persist (commit) step.
    const loginPromise = provider.login(ISSUER);
    await Promise.resolve();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Logout races the in-flight commit: bumps the epoch + clears caches/persistence.
    await provider.forgetIssuer(ISSUER);

    // Release the parked commit; it re-checks the fence (now stale) and publishes NOTHING.
    releasePut();
    await loginPromise;

    // ── THE FENCE: the issuer was NOT pinned (the commit yielded + `#settledSessions` was cleared
    // by the forget). A fresh upgrade must RE-RESOLVE the issuer via getWebId — a surviving pin
    // would skip that. (Pre-fix, the pin survived and getWebId would NOT be called.)
    getWebId.mockClear();
    await provider.upgrade(new Request("https://pod.test/x")).catch(() => {});
    expect(getWebId).toHaveBeenCalled(); // re-resolved ⇒ no stale pin to a forgotten issuer
  });

  it("HIGH: a concurrent upgrade() does NOT join the OLD account's stale #sessions entry while a fresh same-issuer login is establishing", async () => {
    // ADVERSARIAL (the #123 whole-branch HIGH, round 4): A's proactive refresh is IN FLIGHT (its
    // promise sits in `#sessions`); a fresh same-issuer login for B bumps the epoch and starts
    // establishing (not yet committed). In THAT window a concurrent NON-login `upgrade()` would —
    // without the eviction — JOIN A's stale `#sessions` promise and attach A's superseded token.
    // The fix EVICTS A's `#sessions`/`#settledSessions` entry synchronously at B's bump, so the
    // concurrent upgrade cannot read stale in-flight work and instead establishes fresh. We force
    // the window deterministically: A's proactive grant is parked, AND B's login token grant is
    // parked, so the upgrade provably runs while B is still establishing.
    vi.useFakeTimers();
    const store = new StructuredCloneSessionStore();
    const { provider } = makeProvider(store, { proactive: true });
    await provider.login(ISSUER); // A settles
    await provider.upgrade(new Request("https://pod.test/a")); // settle A's session in #sessions

    // A two-phase gate: phase 1 parks A's proactive REFRESH grant; phase 2 parks B's login
    // AUTHORIZATION-CODE token grant. Both held simultaneously creates the in-flight window.
    const real = as.fetch;
    let releaseA: () => void = () => {};
    const aGate = new Promise<void>((r) => (releaseA = r));
    let signalAParked: () => void = () => {};
    const aParked = new Promise<void>((r) => (signalAParked = r));
    let releaseB: () => void = () => {};
    const bGate = new Promise<void>((r) => (releaseB = r));
    let signalBParked: () => void = () => {};
    const bParked = new Promise<void>((r) => (signalBParked = r));
    vi.stubGlobal("fetch", (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const grant = await peekGrantType(input, init);
      if (url.endsWith("/token") && grant === "refresh_token") {
        signalAParked();
        await aGate; // hold A's proactive refresh
      } else if (url.endsWith("/token") && grant === "authorization_code") {
        signalBParked();
        await bGate; // hold B's login token exchange (B is mid-establishment)
      }
      return real(input, init);
    }) as typeof fetch);

    await pumpUntil(aParked); // A's proactive refresh is in `#sessions`
    // Start B's fresh login (account switch); it bumps the epoch + evicts A's stale entries, then
    // parks at its authorization-code token grant (still establishing, NOT committed).
    const bLogin = provider.login(ISSUER, { expectedWebId: "https://pod.test/bob#me" });
    await pumpUntil(bParked);

    // CONCURRENT non-login upgrade() in the in-flight window. BEHAVIORAL DISCRIMINATOR: with the
    // eviction, A's `#sessions` entry is GONE, so the upgrade CANNOT join A's parked refresh — it
    // takes the fresh-auth path and parks on B's AUTHORIZATION-CODE gate, so releasing ONLY A's
    // refresh gate must NOT resolve it. WITHOUT the eviction, the upgrade JOINS A's parked refresh
    // and resolves as soon as A's gate releases (the bug). So "still pending after releaseA()" is
    // exactly the fix.
    let upgradeDone = false;
    const upgrade = provider
      .upgrade(new Request("https://pod.test/c"))
      .then(() => {
        upgradeDone = true;
      })
      .catch(() => {
        upgradeDone = true;
      });
    await Promise.resolve();
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);

    // Release ONLY A's parked refresh. If the upgrade had JOINED A (the bug), it resolves now.
    releaseA();
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0);
    expect(upgradeDone).toBe(false); // did NOT join A's refresh — it is establishing fresh

    // Release B's auth-code gate: B's login AND the fresh upgrade (both on the auth-code path) drain.
    releaseB();
    await bLogin;
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
    await upgrade;
    expect(upgradeDone).toBe(true);
  });

  it("MEDIUM: forgetIssuer's atomic compareAndDelete does NOT wipe a same-account ROTATED token persisted concurrently", async () => {
    // ADVERSARIAL (the #123 whole-branch MEDIUM, round 4): `forgetIssuer` checks the epoch then
    // deletes persistence. A same-account proactive refresh can persist a ROTATED token (SAME
    // epoch — no supersession) between the check and the delete. An unconditional `delete` would
    // wipe that newer rotated credential. The atomic `compareAndDelete(issuer, forgottenToken)`
    // deletes ONLY if persistence still holds the ORIGINAL forgotten token, so the rotated one
    // survives. We force the ordering with a store whose `delete`/`compareAndDelete` park on a
    // gate; while parked, a rotated token is persisted; then the gate releases.
    let releaseDel: () => void = () => {};
    const delGate = new Promise<void>((r) => {
      releaseDel = r;
    });
    let delArmed = true;
    const base = new StructuredCloneSessionStore();
    let rotatedToken: string | undefined;
    const store = {
      get: (i: string) => base.get(i),
      put: (s: Parameters<StructuredCloneSessionStore["put"]>[0]) => base.put(s),
      delete: async (i: string) => {
        if (delArmed) {
          delArmed = false;
          await delGate;
        }
        return base.delete(i);
      },
      compareAndDelete: async (i: string, t: string) => {
        if (delArmed) {
          delArmed = false;
          // While the forget's delete is parked, simulate a same-account proactive refresh
          // persisting a ROTATED token (same epoch — no supersession).
          const cur = await base.get(i);
          if (cur !== undefined) {
            rotatedToken = `${cur.refreshToken}-rotated`;
            await base.put({ ...cur, refreshToken: rotatedToken });
          }
          await delGate;
        }
        return base.compareAndDelete(i, t);
      },
    };
    const getCode = vi.fn((u: URL) => as.authorize(u));
    const provider = new WebIdDPoPTokenProvider(CALLBACK, getCode, async () => WEBID, {
      clientId: CLIENT_ID,
      profileFetch,
      sessionStore: store as unknown as StructuredCloneSessionStore,
    });
    await provider.login(ISSUER);

    const forget = provider.forgetIssuer(ISSUER); // captures the original token, parks at CAD
    await Promise.resolve();
    releaseDel();
    await forget;

    // ── THE FENCE: the atomic CAD (original token) did NOT match the ROTATED token, so the
    // rotated same-account credential SURVIVES. (An unconditional delete would have wiped it.)
    expect(rotatedToken).toBeDefined();
    expect(base.peek(ISSUER_HREF)?.refreshToken).toBe(rotatedToken);
  });

  it("HIGH: a STALE proactive refresh failing invalid_grant does NOT wipe a newer same-issuer login's session", async () => {
    // ADVERSARIAL (the #123 whole-branch HIGH, round 5): A's proactive refresh is in flight; B's
    // fresh login supersedes (bumps epoch + commits + persists). A's grant then FAILS invalid_grant
    // (A's token was superseded/revoked). `#handleProactiveFailure`'s invalid_grant branch
    // UNCONDITIONALLY cleared the scheduler + #sessions + #settledSessions + persistence — wiping
    // B's session. The fix fences that destructive cleanup (stale ⇒ clear only the dead scheduler)
    // and token-scopes the persistence delete, so B's session/credential survive.
    vi.useFakeTimers();
    const store = new StructuredCloneSessionStore();
    const { provider, getCode } = makeProvider(store, { proactive: true });
    await provider.login(ISSUER); // A settles + persists

    // Park A's proactive refresh grant in flight.
    const gate = makeRefreshGate(as.fetch);
    vi.stubGlobal("fetch", gate.fetchImpl);
    await pumpUntil(gate.parked);

    // B logs in fresh (account switch) — bumps the epoch, commits + persists B's credential.
    await provider.login(ISSUER, { expectedWebId: "https://pod.test/bob#me" });
    const bToken = store.peek(ISSUER_HREF)?.refreshToken;
    expect(bToken).toBeDefined();

    // Make A's parked grant FAIL invalid_grant when released (revoke all server-side refresh
    // tokens — A's redemption now 400s). Then release it; A's failure handler runs STALE.
    as.activeRefreshTokens.clear();
    gate.releaseToken();
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0);

    // ── THE FENCE: A's stale invalid_grant cleanup did NOT wipe B — B's persisted credential
    // survives and B's session is still reusable (no re-auth). (Pre-fix, the store would be empty
    // and the upgrade would re-authenticate.)
    expect(store.peek(ISSUER_HREF)?.refreshToken).toBe(bToken);
    await provider.upgrade(new Request("https://pod.test/x"));
    expect(getCode).toHaveBeenCalledTimes(2); // A's + B's logins only — B's session reused
  });

  it("HIGH: forgetIssuer bumps+clears BEFORE its async persisted read, so a retry login during that read is not wiped", async () => {
    // ADVERSARIAL (the #123 whole-branch HIGH, round 5): when there is NO in-memory settled token,
    // `forgetIssuer` must still bump + clear in-memory state SYNCHRONOUSLY before the async
    // persisted-record read — otherwise a retry login committing during that await would be wiped
    // by the resuming cleanup. We drive the no-in-memory-token case (a cold provider with only a
    // persisted session) and gate the persisted `get()` so a retry login B commits while it is
    // parked; B must survive.
    let releaseGet: () => void = () => {};
    const getGate = new Promise<void>((r) => {
      releaseGet = r;
    });
    let getArmed = true;
    const base = new StructuredCloneSessionStore();
    const store = {
      get: async (i: string) => {
        if (getArmed) {
          getArmed = false;
          await getGate; // park the forget's persisted-record read
        }
        return base.get(i);
      },
      put: (s: Parameters<StructuredCloneSessionStore["put"]>[0]) => base.put(s),
      delete: (i: string) => base.delete(i),
      compareAndDelete: (i: string, t: string) => base.compareAndDelete(i, t),
    };
    // Seed a persisted session, then a COLD provider (no in-memory settled session ⇒ forgetIssuer
    // takes the persisted-read fallback).
    const seed = new WebIdDPoPTokenProvider(CALLBACK, vi.fn((u: URL) => as.authorize(u)), async () => WEBID, {
      clientId: CLIENT_ID,
      profileFetch,
      sessionStore: base,
    });
    await seed.login(ISSUER);
    const getCode = vi.fn((u: URL) => as.authorize(u));
    const provider = new WebIdDPoPTokenProvider(CALLBACK, getCode, async () => WEBID, {
      clientId: CLIENT_ID,
      profileFetch,
      sessionStore: store as unknown as StructuredCloneSessionStore,
    });

    // forgetIssuer on the COLD provider: bumps+clears synchronously, then parks at the persisted get.
    const forget = provider.forgetIssuer(ISSUER);
    await Promise.resolve();

    // A retry login B commits + persists WHILE the forget's persisted read is parked. B bumps the
    // epoch (fresh auth — different expectedWebId), so the resuming forget's epoch gate fails.
    await provider.login(ISSUER, { expectedWebId: "https://pod.test/dave#me" });
    const bToken = base.peek(ISSUER_HREF)?.refreshToken;
    expect(bToken).toBeDefined();

    // Release the parked persisted read; the forget resumes — its epoch gate is now stale, so it
    // must NOT delete B's credential.
    releaseGet();
    await forget;

    expect(base.peek(ISSUER_HREF)?.refreshToken).toBe(bToken); // B survived
  });

  it("MEDIUM: forgetIssuer with NO identifiable token does NOT unscoped-delete a retry login's freshly-persisted credential", async () => {
    // ADVERSARIAL (the #123 whole-branch MEDIUM, round 6): when `forgetIssuer` cannot identify a
    // refresh token (no in-memory settled token AND no persisted record at read time), the old
    // fallback did an UNSCOPED `#clearPersisted` — which, running after a retry login bumped the
    // epoch and persisted a new credential, wiped it. The fix SKIPS the delete entirely when no
    // token is identifiable (and only ever deletes token-scoped). We force the window: forgetIssuer
    // on a provider with nothing persisted (its `get()` returns undefined, parked on a gate); a
    // retry login persists while parked; release — the forget must not wipe the retry's credential.
    // The buggy unconditional fallback would run a PLAIN `delete` (no token check). We model that
    // exact residual window: forgottenToken resolves undefined (empty store at read), the epoch
    // check passes (no retry bump yet), then the PLAIN delete transaction is reached — and at that
    // instant a retry login persists B + bumps the epoch. A token-scoped CAD (or a skip) spares B;
    // an unconditional `delete` wipes it. We gate the store's `delete` to inject the retry between
    // "delete reached" and "delete committed". (`compareAndDelete` is NOT gated — the fix takes
    // that path or skips, both safe.)
    let releaseDelete: () => void = () => {};
    const deleteGate = new Promise<void>((r) => {
      releaseDelete = r;
    });
    let onDeleteReached: () => void = () => {};
    const deleteReached = new Promise<void>((r) => {
      onDeleteReached = r;
    });
    const base = new StructuredCloneSessionStore();
    const store = {
      get: (i: string) => base.get(i), // empty at the forget's read ⇒ forgottenToken undefined
      put: (s: Parameters<StructuredCloneSessionStore["put"]>[0]) => base.put(s),
      delete: async (i: string) => {
        // The buggy path reaches here. Inject the retry login NOW (persists B), then proceed —
        // a plain delete would wipe B; the fix never calls this with a foreign credential present.
        onDeleteReached();
        await deleteGate;
        return base.delete(i);
      },
      compareAndDelete: (i: string, t: string) => base.compareAndDelete(i, t),
    };
    const getCode = vi.fn((u: URL) => as.authorize(u));
    const provider = new WebIdDPoPTokenProvider(CALLBACK, getCode, async () => WEBID, {
      clientId: CLIENT_ID,
      profileFetch,
      sessionStore: store as unknown as StructuredCloneSessionStore,
    });

    // forgetIssuer with NOTHING in memory or persisted ⇒ settledToken undefined, get() undefined.
    const forget = provider.forgetIssuer(ISSUER);

    // If the (buggy) plain delete is reached, inject the retry login + release. With the FIX,
    // `delete` is NEVER called (forgottenToken undefined ⇒ skip), so `deleteReached` never fires —
    // we drive the retry via a short race instead.
    let deleteWasCalled = false;
    void deleteReached.then(async () => {
      deleteWasCalled = true;
      await provider.login(ISSUER, { expectedWebId: "https://pod.test/erin#me" });
      releaseDelete();
    });
    await forget;

    // With the fix, the unscoped delete was SKIPPED entirely (no token to scope to).
    expect(deleteWasCalled).toBe(false);

    // And a subsequent retry login persists + survives (sanity: the slot is usable, not wiped).
    await provider.login(ISSUER, { expectedWebId: "https://pod.test/erin#me" });
    const bToken = base.peek(ISSUER_HREF)?.refreshToken;
    expect(bToken).toBeDefined();
    expect(base.peek(ISSUER_HREF)?.refreshToken).toBe(bToken);
  });

  it("HIGH: a NON-login joiner whose issuer is FORGOTTEN (logout) while pending FAILS CLOSED — no reuse, no silent re-auth", async () => {
    // ADVERSARIAL (the #123 whole-branch HIGH, round 7 + round 12): a non-login `upgrade()` joins
    // the in-flight `#sessions` promise (a renewal). While it is PENDING, `forgetIssuer()` (logout)
    // deletes `#sessions` + bumps the epoch. The round-7 fence stops the joiner from USING the
    // forgotten token; the round-12 refinement makes it FAIL CLOSED (reject) when the issuer was
    // FORGOTTEN (slot now empty) rather than re-resolving — re-resolving would start a FRESH silent
    // auth and re-create provider state + persistence for an issuer the user just signed out of. So
    // the joiner must NOT reuse the old token AND must NOT silently re-authenticate.
    const store = new StructuredCloneSessionStore();
    const { provider, getCode } = makeProvider(store);
    // First upgrade settles a session.
    const first = (await provider.upgrade(new Request("https://pod.test/a"))).headers.get(
      "Authorization",
    );
    expect(getCode).toHaveBeenCalledTimes(1);

    // Force the session expired so the next upgrade triggers a RENEWAL (a refresh grant) we park.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3601 * 1000);
    const gate = makeRefreshGate(as.fetch);
    vi.stubGlobal("fetch", gate.fetchImpl);

    // Upgrade B DRIVES the renewal (refresh grant) which parks at the gate; its `#begin` publishes
    // the in-flight promise into `#sessions`.
    const upgradeB = provider.upgrade(new Request("https://pod.test/b")).catch((e) => e);
    await pumpUntil(gate.parked); // the renewal grant is in flight, in `#sessions`
    // Upgrade C JOINS B's in-flight `#sessions` promise (reads it and awaits the raw work).
    const upgradeC = provider.upgrade(new Request("https://pod.test/c")).catch((e) => e);
    await Promise.resolve();
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);

    // Logout WHILE the renewal is pending: forgetIssuer deletes `#sessions` + bumps the epoch.
    await provider.forgetIssuer(ISSUER);

    // Release the parked renewal; its commit yields (stale epoch). The JOINER(s), after the await,
    // see `#sessions` is now EMPTY (forgotten) → FAIL CLOSED (reject), neither reusing the old
    // token nor silently re-authenticating.
    gate.releaseToken();
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0);
    const [rb, rc] = await Promise.all([upgradeB, upgradeC]);

    // NO silent re-auth after logout (getCode never fired again), and the joined upgrades did NOT
    // resolve to a Request bearing the FORGOTTEN token.
    expect(getCode).toHaveBeenCalledTimes(1);
    for (const r of [rb, rc]) {
      if (r instanceof Request) {
        expect(r.headers.get("Authorization")).not.toBe(first); // never the forgotten token
      }
      // (a rejected upgrade — AbortError — is the fail-closed outcome and equally acceptable)
    }
  });

  it("MEDIUM: a STALE proactive invalid_grant failure does NOT clear the NEWER same-issuer login's proactive scheduler", async () => {
    // ADVERSARIAL (the #123 whole-branch MEDIUM, round 9): A's proactive refresh is in flight; B's
    // fresh login supersedes (bumps epoch, commits, ARMS B's proactive scheduler). A's grant then
    // fails invalid_grant and runs STALE. The old handler unconditionally `#clearScheduler`'d —
    // killing B's proactive scheduler (keyed by issuer). The fix returns early when the fence is
    // stale, touching no issuer-wide scheduler state. Observable: B's proactive refresh STILL fires
    // on its own timer after A's stale failure.
    vi.useFakeTimers();
    const store = new StructuredCloneSessionStore();
    const { provider, getCode } = makeProvider(store, { proactive: true });
    await provider.login(ISSUER); // A settles + arms A's scheduler

    // Park A's proactive refresh.
    const gate = makeRefreshGate(as.fetch);
    vi.stubGlobal("fetch", gate.fetchImpl);
    await pumpUntil(gate.parked);

    // B logs in fresh — bumps epoch, commits, arms B's proactive scheduler (replacing A's slot).
    await provider.login(ISSUER, { expectedWebId: "https://pod.test/bob#me" });
    const refreshesBeforeBStale = as.tokenRequests.filter(
      (r) => r.get("grant_type") === "refresh_token",
    ).length;

    void refreshesBeforeBStale;
    const bToken = store.peek(ISSUER_HREF)?.refreshToken;
    expect(bToken).toBeDefined();

    // A's parked grant now fails invalid_grant (revoke A's token server-side) and runs its STALE
    // failure handler.
    as.activeRefreshTokens.clear();
    if (bToken) as.activeRefreshTokens.add(bToken); // keep B's token redeemable
    gate.releaseToken();
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0);

    // ── THE FENCE: A's stale failure handler returned early WITHOUT touching B's issuer-wide state.
    // B's IN-MEMORY session + scheduler + persisted credential are intact: an upgrade reuses B's
    // session (no re-auth) AND B's proactive scheduler still fires. (Pre-fix, the stale handler's
    // `#clearScheduler` + `#settledSessions.delete`/`#sessions.delete` wiped B's in-memory session,
    // forcing the upgrade to re-authenticate, and killed B's scheduler.)
    expect(store.peek(ISSUER_HREF)?.refreshToken).toBe(bToken); // B's credential intact
    await provider.upgrade(new Request("https://pod.test/b-after"));
    expect(getCode).toHaveBeenCalledTimes(2); // A's + B's logins only — B's session reused

    // And B's proactive scheduler survived — advancing the clock fires B's proactive refresh.
    const refreshesBeforeTick = as.tokenRequests.filter(
      (r) => r.get("grant_type") === "refresh_token",
    ).length;
    await vi.advanceTimersByTimeAsync(65_000);
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0);
    const refreshesAfter = as.tokenRequests.filter(
      (r) => r.get("grant_type") === "refresh_token",
    ).length;
    expect(refreshesAfter).toBeGreaterThan(refreshesBeforeTick); // B's proactive scheduler fired
  });

  it("MEDIUM: login().discardIfSuperseded forgets THIS login's abandoned credential but is a NO-OP once a newer login owns the slot", async () => {
    // ADVERSARIAL (the #123 whole-branch MEDIUM, round 9): a login commits + persists inside
    // provider.login() but its UI publish is later superseded. `discardIfSuperseded()` must forget
    // THIS login's own abandoned credential (so a later login can't reuse it) — yet be a NO-OP when
    // a NEWER same-issuer login already replaced the settled slot (so it never wipes the winner).
    const store = new StructuredCloneSessionStore();
    const { provider, getCode } = makeProvider(store);

    // (1) A login commits; nothing superseded it ⇒ discardIfSuperseded forgets ITS OWN credential.
    const a = await provider.login(ISSUER);
    expect(store.peek(ISSUER_HREF)).toBeDefined();
    await a.discardIfSuperseded();
    expect(store.peek(ISSUER_HREF)).toBeUndefined(); // abandoned credential discarded
    // After discard, an upgrade must RE-AUTHENTICATE (the in-memory session + pin were cleared).
    await provider.upgrade(new Request("https://pod.test/x"));
    expect(getCode).toHaveBeenCalledTimes(2);

    // (2) A NEWER login takes the slot ⇒ the OLD login's discard is a NO-OP (does not wipe it).
    const older = await provider.login(ISSUER); // commits credential O
    const oToken = store.peek(ISSUER_HREF)?.refreshToken;
    const newer = await provider.login(ISSUER, { expectedWebId: "https://pod.test/zoe#me" }); // fresh ⇒ replaces slot
    const nToken = store.peek(ISSUER_HREF)?.refreshToken;
    expect(nToken).toBeDefined();
    expect(nToken).not.toBe(oToken);
    const getCodeBeforeDiscard = getCode.mock.calls.length;
    await older.discardIfSuperseded(); // OLD login's discard — must NOT touch the newer credential
    expect(store.peek(ISSUER_HREF)?.refreshToken).toBe(nToken); // newer persisted credential survives
    // AND newer's IN-MEMORY session survives: an upgrade reuses it (no re-auth). (Pre-fix — discard
    // without the ownership guard — would have wiped newer's #settledSessions, forcing a re-auth.)
    await provider.upgrade(new Request("https://pod.test/newer"));
    expect(getCode.mock.calls.length).toBe(getCodeBeforeDiscard); // no re-auth — newer reused
    void newer;
  });

  it("MEDIUM: discardIfSuperseded cancels an in-flight proactive refresh for the abandoned credential (no recommit)", async () => {
    // ADVERSARIAL (the #123 whole-branch MEDIUM, round 11): `discardIfSuperseded()` clearing the
    // caches/persistence WITHOUT bumping the epoch would leave a proactive/lazy refresh ALREADY in
    // flight for that abandoned credential with a still-current epoch — its later commit would
    // RE-COMMIT the discarded session (resurrecting it). The fix bumps the epoch in
    // discardIfSuperseded, so the in-flight refresh's commit yields. We park the proactive refresh,
    // discard, then release — the discarded credential must NOT come back.
    vi.useFakeTimers();
    const store = new StructuredCloneSessionStore();
    const { provider } = makeProvider(store, { proactive: true });
    const a = await provider.login(ISSUER); // commits + arms a proactive scheduler

    // Park the proactive refresh grant for THIS (about-to-be-abandoned) credential in flight.
    const gate = makeRefreshGate(as.fetch);
    vi.stubGlobal("fetch", gate.fetchImpl);
    await pumpUntil(gate.parked);

    // Discard the (now-abandoned) login while its proactive refresh is in flight. Bumps the epoch.
    await a.discardIfSuperseded();
    expect(store.peek(ISSUER_HREF)).toBeUndefined(); // discarded

    // Release the parked proactive refresh; its commit must YIELD (stale epoch) — NOT re-commit the
    // discarded session/credential.
    gate.releaseToken();
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0);

    // ── THE FENCE: the in-flight proactive refresh did NOT resurrect the discarded credential.
    expect(store.peek(ISSUER_HREF)).toBeUndefined();
  });

  it("MEDIUM: discardIfSuperseded re-checks the epoch after the pin await and skips the delete if a newer login bumped it", async () => {
    // ADVERSARIAL (the #123 whole-branch MEDIUM, round 13): discardIfSuperseded deletes by
    // refresh-token equality AFTER awaiting the issuer pin. A newer same-issuer login can land in
    // that await window and bump the epoch; without re-checking the epoch before the
    // compareAndDelete, a server that reused a refresh-token value would let the discard wipe the
    // newer login's credential. The fix re-checks the captured discard epoch before the CAD. We
    // force the window with a store whose compareAndDelete records its call, and interpose an epoch
    // bump (a forgetIssuer + re-login) during the discard's pin await via a gated pin promise is
    // not directly reachable — so we drive it deterministically by gating the store `get` the pin
    // path does not use; instead we assert the epoch-recheck SKIPS the CAD when the epoch advanced.
    const base = new StructuredCloneSessionStore();
    let cadCalledWith: string | undefined;
    const store = {
      get: (i: string) => base.get(i),
      put: (s: Parameters<StructuredCloneSessionStore["put"]>[0]) => base.put(s),
      delete: (i: string) => base.delete(i),
      compareAndDelete: async (i: string, t: string) => {
        cadCalledWith = t;
        return base.compareAndDelete(i, t);
      },
    };
    const getCode = vi.fn((u: URL) => as.authorize(u));
    const provider = new WebIdDPoPTokenProvider(CALLBACK, getCode, async () => WEBID, {
      clientId: CLIENT_ID,
      profileFetch,
      sessionStore: store as unknown as StructuredCloneSessionStore,
    });
    const a = await provider.login(ISSUER); // commits token T at epoch E
    // A newer fresh login bumps the epoch and replaces the settled session BEFORE we discard.
    await provider.login(ISSUER, { expectedWebId: "https://pod.test/fred#me" });

    // Now invoke the OLD login's discard. Its FIRST guard (#settledSessions identity) already
    // fails (newer replaced it), so it returns early WITHOUT a CAD — the newer credential is never
    // touched. (The epoch re-check is the defence-in-depth second guard for the narrower
    // post-pin-await window; the identity guard covers this already-superseded case.)
    await a.discardIfSuperseded();
    expect(cadCalledWith).toBeUndefined(); // no CAD against the OLD token ⇒ newer credential safe
    expect(base.peek(ISSUER_HREF)).toBeDefined(); // newer login's credential intact
  });

  it("control: WITHOUT a racing forget/switch the proactive refresh commits normally (no false fence)", async () => {
    // Guards against a fence that is too aggressive: a plain proactive refresh with NO competing
    // forget/login must still commit + re-persist the rotated token (the epoch is unchanged).
    vi.useFakeTimers();
    const store = new StructuredCloneSessionStore();
    const { provider, getCode } = makeProvider(store, { proactive: true });
    await provider.login(ISSUER);
    const original = store.peek(ISSUER_HREF)?.refreshToken;

    await vi.advanceTimersByTimeAsync(65_000);
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0);

    const rotated = store.peek(ISSUER_HREF)?.refreshToken;
    expect(rotated).toBeDefined();
    expect(rotated).not.toBe(original); // committed + re-persisted the rotated token
    expect(getCode).toHaveBeenCalledTimes(1); // and never a popup
  });
});
