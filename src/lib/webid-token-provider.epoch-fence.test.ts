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
