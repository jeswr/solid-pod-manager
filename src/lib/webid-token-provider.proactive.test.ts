/**
 * PROACTIVE background refresh of the local `WebIdDPoPTokenProvider` port.
 *
 * The lazy paths renew only after a token is already stale (upgrade()-on-expiry,
 * renew-on-rejected-401). Proactive refresh runs the refresh-token grant in the
 * BACKGROUND before expiry so a long import / idle→active session never hits an
 * expired token mid-flow. These tests drive it with vitest fake timers and an
 * injected visibility lifecycle, asserting:
 *   - a refresh fires before expiry with NO upgrade()/401 (grant_type=refresh_token,
 *     getCode never called), and reschedules from the ROTATED token;
 *   - a hidden tab does NOT fire the timer; visibility→visible near/after expiry
 *     refreshes immediately;
 *   - logout + teardown clear timers (no refresh after);
 *   - invalid_grant stops scheduling and opens NO window;
 *   - transient failure retries with bounded backoff;
 *   - a no-refresh-token issuer schedules nothing.
 *
 * MIRRORS-CANDIDATE: this is the upstream-port test surface for the proactive
 * scheduler described in webid-token-provider.ts.
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

const WEBID = "https://pod.test/profile/card#me";
const CALLBACK = "https://app.test/callback.html";
const CLIENT_ID = "https://app.test/clientid.jsonld";
const ISSUER = new URL("https://as.test");

const profileTurtle = `<${WEBID}> <http://www.w3.org/ns/solid/terms#oidcIssuer> <https://as.test> .`;
const profileFetch: typeof fetch = async () =>
  new Response(profileTurtle, {
    status: 200,
    headers: { "content-type": "text/turtle" },
  });

let as: FakeAuthorizationServer;

/**
 * Count of token-endpoint fetches CURRENTLY IN FLIGHT (issued, not yet settled).
 * `as.tokenRequests` only grows once a request reaches the endpoint and is
 * recorded, and `refreshGrants()` only counts COMPLETED grants — so neither sees
 * a refresh whose fetch is mid-flight. This counter does, so a NEGATIVE assertion
 * ("no refresh fired") can wait until no token fetch is in flight before
 * asserting. Installed by the default `beforeEach` fetch wrapper and by every
 * per-test re-stub (via {@link trackTokenFetches}).
 */
let tokenFetchesInFlight = 0;

/**
 * Count of `crypto.subtle.sign` operations CURRENTLY IN FLIGHT. This closes the
 * one window the fetch counter cannot see: a fired refresh timer doing its DPoP
 * proof generation (an ES256 `crypto.subtle.sign` on the libuv thread pool) is
 * busy BEFORE it issues the token fetch. Tracking signs-in-flight gives a NEGATIVE
 * drain a "refresh job is doing crypto right now" signal that precedes the fetch,
 * so it cannot conclude idle while an unwanted refresh is still in its pre-fetch
 * crypto. Installed by a `crypto.subtle.sign` wrapper in `beforeEach` (restored in
 * `afterEach`). NOTE this also counts the fake AS's server-side ID-token signing,
 * which is fine — it only ever makes a drain wait slightly longer, never shorter.
 */
let cryptoSignsInFlight = 0;
/** The original `crypto.subtle.sign`, captured so `afterEach` can restore it. */
const realCryptoSign = crypto.subtle.sign.bind(crypto.subtle);

/** A controllable Page Visibility surface; tests flip visibility and emit. */
class FakeVisibility implements VisibilityLifecycle {
  visible = true;
  #resume = new Set<() => void>();
  #hide = new Set<() => void>();

  isVisible(): boolean {
    return this.visible;
  }
  onResume(listener: () => void): () => void {
    this.#resume.add(listener);
    return () => this.#resume.delete(listener);
  }
  onHide(listener: () => void): () => void {
    this.#hide.add(listener);
    return () => this.#hide.delete(listener);
  }
  /** Listener counts so a test can assert teardown released them. */
  get listenerCount(): number {
    return this.#resume.size + this.#hide.size;
  }
  hide(): void {
    this.visible = false;
    for (const l of [...this.#hide]) l();
  }
  show(): void {
    this.visible = true;
    for (const l of [...this.#resume]) l();
  }
}

interface Harness {
  provider: WebIdDPoPTokenProvider;
  getCode: ReturnType<typeof vi.fn>;
  visibility: FakeVisibility;
}

/**
 * Build a proactive-enabled provider. `setTimeoutFn`/`clearTimeoutFn` bind to
 * the (faked) globals so vitest's `advanceTimersByTime` drives the scheduler.
 */
function makeProvider(visibility = new FakeVisibility()): Harness {
  const getCode = vi.fn((url: URL) => as.authorize(url));
  const provider = new WebIdDPoPTokenProvider(CALLBACK, getCode, async () => WEBID, {
    clientId: CLIENT_ID,
    profileFetch,
    proactiveRefresh: true,
    visibilityLifecycle: visibility,
    setTimeoutFn: (h, ms) => setTimeout(h, ms),
    clearTimeoutFn: (t) => clearTimeout(t),
  });
  return { provider, getCode, visibility };
}

/** Short-lived tokens so the proactive timer fires within the fake clock. */
async function shortLivedAs(expiresIn = 120): Promise<FakeAuthorizationServer> {
  return createFakeAuthorizationServer({
    expiresIn,
    issueRefreshTokens: true,
    scopesSupported: ["openid", "webid", "offline_access"],
    grantTypesSupported: ["authorization_code", "refresh_token"],
    webIdClaim: WEBID,
  });
}

const refreshGrants = () =>
  as.tokenRequests.filter((r) => r.get("grant_type") === "refresh_token");

/** The URL of any valid `fetch` input (string | URL | Request) — never throws. */
function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

/**
 * Wrap any `fetch` implementation so token-endpoint calls increment
 * {@link tokenFetchesInFlight} for the duration of the request, regardless of
 * the underlying behaviour (success, rejection, a held gate). EVERY stub used by
 * a test that asserts negatively via {@link tickQuiet} must be installed through
 * this — including per-test re-stubs (the retry/failure doubles) — so the
 * in-flight observable covers their refresh paths too, not just the default one.
 */
function trackTokenFetches(impl: typeof fetch): typeof fetch {
  return (input, init) => {
    if (!urlOf(input).endsWith("/token")) return impl(input, init);
    tokenFetchesInFlight++;
    // `impl` may throw SYNCHRONOUSLY (a stub that does so) — decrement before
    // rethrowing so a sync error can't leave the counter stuck > 0 (which would
    // make `waitForIdle` never see idle). The async path decrements in `finally`.
    let pending: ReturnType<typeof fetch>;
    try {
      pending = Promise.resolve(impl(input, init));
    } catch (e) {
      tokenFetchesInFlight--;
      throw e;
    }
    return pending.finally(() => {
      tokenFetchesInFlight--;
    });
  };
}

/**
 * The REAL `setTimeout`, captured at module load BEFORE any `vi.useFakeTimers()`
 * patches the global. The drain below needs a genuine event-loop yield, and once
 * fake timers are installed `globalThis.setTimeout` is the fake one (it never
 * actually fires on its own). Binding to `globalThis` keeps the correct `this`.
 */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

/** Yield one REAL macrotask — lets libuv thread-pool work (ES256/DPoP signing) land. */
const realYield = (): Promise<void> =>
  new Promise((resolve) => realSetTimeout(resolve, 0));

/** The REAL `Date.now`, captured before any `vi.useFakeTimers()` fakes the clock. */
const realNow = Date.now.bind(Date);
/**
 * Hard REAL-TIME deadline for a single drain helper. Exceeding it means the
 * expected outcome never arrived / the drain never quiesced (a genuine hang or
 * unbounded scheduling bug, not load): the helper THROWS a diagnostic rather
 * than returning silently and letting a later assertion fail with a misleading
 * message. Comfortably above any real drain (tens of ms) yet below vitest's 5s
 * per-test timeout.
 */
const DRAIN_DEADLINE_MS = 4_000;
/**
 * The real-time window over which ALL FOUR idleness observables (completed-grant
 * count, pending fake-timer count, in-flight token fetches, and in-flight
 * `crypto.subtle.sign`) must stay quiet before a drain concludes nothing more is
 * happening (see {@link waitForIdle}).
 *
 * With the crypto-in-flight counter, the previously un-observable window — a
 * fired timer doing its DPoP-proof signing BEFORE issuing a fetch — is now
 * directly observed (that signing increments `cryptoSignsInFlight`), so the
 * window no longer has to be long enough to "outwait" unbounded crypto; it just
 * needs to bridge the sub-millisecond synchronous gaps BETWEEN consecutive
 * observable operations (e.g. crypto settles → microtask → fetch issues). A
 * modest 50ms is ample for that and keeps the file fast. Negative tests advance
 * the fake clock far past any fire point first, so the window adds only this
 * little real time once truly idle.
 */
const QUIET_WINDOW_MS = 50;

/**
 * Why a generic time/turn-based drain is the wrong primitive for the POSITIVE
 * cases (and was the flake): the proactive refresh chain a fired timer kicks off
 * contains genuinely-async work that is NOT a microtask — `crypto.subtle.sign`
 * for the DPoP proof + the ES256 ID-token verify resolve on the libuv THREAD
 * POOL (a macrotask). `vi.advanceTimersByTimeAsync` only runs due fake timers and
 * flushes microtasks; a thread-pool result that has not yet landed is invisible
 * to it. Under the FULL parallel `vitest run`, other workers contend for the pool
 * so the crypto can take an UNBOUNDED amount of wall-clock to resolve — neither a
 * fixed round count nor a fixed quiet window is a sound bound on it. So the
 * positive helpers below are CONDITION-DRIVEN: they drain (real macrotask yield +
 * zero-advance fake-timer flush) until the EXACT asserted observable state is
 * reached, and so cannot return before the refresh grant has actually landed.
 */

/** One drain round: let thread-pool crypto land, then fire any timer due at t=0. */
async function drainRound(): Promise<void> {
  await realYield(); // real macrotask — thread-pool crypto (DPoP/ES256) resolves
  await vi.advanceTimersByTimeAsync(0); // fire any timer scheduled at t=0
}

/**
 * Drain (no clock advance) until the refresh path is fully PROCESSED, not merely
 * reached: a real-time window in which FOUR observables — completed-grant count,
 * pending fake-timer count, token fetches in flight, AND `crypto.subtle.sign`
 * operations in flight — are simultaneously stable. The first three catch a
 * refresh once it has reached (or is racing toward) the token endpoint; the
 * crypto counter catches the PRE-FETCH step (DPoP-proof signing), so even a fired
 * refresh that has not yet issued its fetch is observed and keeps the drain busy.
 * Together they make "no refresh job is active" directly observable rather than
 * inferred from elapsed time. `refreshGrants()` is derived from `as.tokenRequests`
 * (endpoint REACHED, not response handled), so requiring the in-flight fetch to
 * SETTLE and the timer queue to STABILISE (reschedule armed, or scheduler stopped)
 * additionally means a follow-up assertion sees the post-refresh state.
 */
async function waitForIdle(start: number): Promise<void> {
  let lastGrants = refreshGrants().length;
  let lastTimers = vi.getTimerCount();
  let idleSince = realNow();
  for (;;) {
    await drainRound();
    const grants = refreshGrants().length;
    const timers = vi.getTimerCount();
    const now = realNow();
    const busy =
      grants !== lastGrants ||
      timers !== lastTimers ||
      tokenFetchesInFlight > 0 ||
      cryptoSignsInFlight > 0;
    if (busy) {
      lastGrants = grants;
      lastTimers = timers;
      idleSince = now;
    } else if (now - idleSince >= QUIET_WINDOW_MS) {
      return;
    }
    if (now - start >= DRAIN_DEADLINE_MS) {
      throw new Error(
        `drain did not reach idle within ${DRAIN_DEADLINE_MS}ms ` +
          `(refresh grants=${grants}, pending timers=${timers}, ` +
          `token fetches in flight=${tokenFetchesInFlight}, ` +
          `crypto signs in flight=${cryptoSignsInFlight}).`,
      );
    }
  }
}

/**
 * Drain (without advancing the fake clock) until `refreshGrants().length >= n`,
 * THEN until the refresh is fully processed ({@link waitForIdle}). The first
 * condition IS the positive assertion, so the helper cannot return before the
 * grant lands (the flake); the second ensures the provider has finished handling
 * the response and (re)scheduled, so a follow-up assertion sees a settled state
 * rather than mid-flight refresh handling. Throws on the real-time deadline so a
 * genuine "the grant never fired" bug is a clear failure, not a hang/timeout.
 */
async function settleUntilGrants(n: number): Promise<void> {
  const start = realNow();
  while (refreshGrants().length < n) {
    await drainRound();
    if (realNow() - start >= DRAIN_DEADLINE_MS) {
      throw new Error(
        `expected >= ${n} refresh grant(s) within ${DRAIN_DEADLINE_MS}ms, ` +
          `saw ${refreshGrants().length} (pending timers=${vi.getTimerCount()}) — ` +
          `the proactive refresh never reached the token endpoint.`,
      );
    }
  }
  // The n-th request reached the endpoint; now let its handling settle.
  await waitForIdle(start);
}

/** Advance the fake clock by `ms`, then wait for the n-th refresh grant to land + settle. */
async function tickUntilGrants(ms: number, n: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settleUntilGrants(n);
}

/**
 * Advance the fake clock by `ms` (far past any fire point) and drain to TRUE
 * idleness, for NEGATIVE assertions (the grant count must stay at its floor —
 * "no refresh fired"). Idleness is the four-observable {@link waitForIdle}
 * check: an unwanted refresh would show up as an in-flight crypto sign (its
 * pre-fetch DPoP proof) or an in-flight token fetch (or a grant / timer change)
 * and reset the window, so a stable window means nothing fired. Throws on the
 * hard deadline (a genuine hang).
 */
async function tickQuiet(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await waitForIdle(realNow());
}

beforeEach(async () => {
  as = await shortLivedAs();
  tokenFetchesInFlight = 0;
  cryptoSignsInFlight = 0;
  // Track IN-FLIGHT token-endpoint calls (see `tokenFetchesInFlight`) so a
  // negative-assertion drain (`tickQuiet`) waits until none is outstanding.
  vi.stubGlobal("fetch", trackTokenFetches(as.fetch));
  // Track IN-FLIGHT `crypto.subtle.sign` (see `cryptoSignsInFlight`) so a drain
  // also observes the pre-fetch DPoP-proof crypto a fired refresh does before it
  // issues a token fetch — the one window the fetch counter cannot see.
  crypto.subtle.sign = ((...args: Parameters<SubtleCrypto["sign"]>) => {
    cryptoSignsInFlight++;
    return realCryptoSign(...args).finally(() => {
      cryptoSignsInFlight--;
    });
  }) as SubtleCrypto["sign"];
});

afterEach(() => {
  // Order matters: clear any still-pending fake timer BEFORE restoring real
  // timers (so a leftover timer cannot fire against real time in a later file),
  // then un-fake and un-stub so no fake clock / stubbed fetch bleeds across
  // tests or workers. Restore the real `crypto.subtle.sign` last.
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  crypto.subtle.sign = realCryptoSign;
});

describe("proactive refresh: scheduling", () => {
  it("refreshes BEFORE expiry with no upgrade()/401 — getCode never re-fires, grant is refresh_token", async () => {
    vi.useFakeTimers();
    const { provider, getCode } = makeProvider();

    await provider.login(ISSUER);
    expect(getCode).toHaveBeenCalledTimes(1);
    expect(refreshGrants()).toHaveLength(0);

    // Lifetime 120s, skew 30s → expiresAt 90s out; schedule fires at lead 30s
    // (≈60s). Advance past it WITHOUT any upgrade()/invalidate(), then wait for
    // the proactive grant to actually land.
    await tickUntilGrants(65_000, 1);

    // A proactive refresh ran purely from the timer.
    expect(getCode).toHaveBeenCalledTimes(1); // no popup/authorize
    expect(refreshGrants()).toHaveLength(1);
    expect(as.tokenRequests.at(-1)?.get("grant_type")).toBe("refresh_token");
  });

  it("reschedules from the ROTATED token — a second cycle fires with a new refresh_token", async () => {
    vi.useFakeTimers();
    const { provider, getCode } = makeProvider();
    await provider.login(ISSUER);

    await tickUntilGrants(65_000, 1); // cycle 1
    expect(refreshGrants()).toHaveLength(1);

    await tickUntilGrants(65_000, 2); // cycle 2 (from rotated token)
    const grants = refreshGrants();
    expect(grants).toHaveLength(2);
    expect(grants[1]?.get("refresh_token")).not.toBe(grants[0]?.get("refresh_token"));
    expect(getCode).toHaveBeenCalledTimes(1); // still never a popup
  });

  it("a proactive refresh in flight satisfies a concurrent upgrade() (single-flight, no stampede)", async () => {
    vi.useFakeTimers();
    const { provider } = makeProvider();
    await provider.login(ISSUER);

    await tickUntilGrants(65_000, 1);
    const grantsAfterProactive = refreshGrants().length;
    expect(grantsAfterProactive).toBe(1);

    // The session is fresh again; an upgrade() now must NOT trigger another grant.
    const upgraded = await provider.upgrade(new Request("https://pod.test/x"));
    expect(upgraded.headers.get("Authorization")).toMatch(/^DPoP at-\d+$/);
    expect(refreshGrants()).toHaveLength(grantsAfterProactive);
  });

  it("a proactive fire that races an IN-FLIGHT lazy renewal joins it — exactly one grant", async () => {
    // Gate the token endpoint to hold a lazy renewal in-flight, then fire the
    // proactive timer into the same window: the two MUST share the single
    // refresh grant (single-flight, no stampede). The gate's "parked" promise
    // pins the ordering (the lazy grant is provably in #sessions before the
    // proactive timer runs), so this is deterministic regardless of run order.
    vi.useFakeTimers();
    const { provider, getCode } = makeProvider();
    await provider.login(ISSUER);
    expect(refreshGrants()).toHaveLength(0);

    const realFetch = as.fetch;
    let releaseToken: () => void = () => {};
    const tokenGate = new Promise<void>((r) => {
      releaseToken = r;
    });
    let signalParked: () => void = () => {};
    const parked = new Promise<void>((r) => {
      signalParked = r;
    });
    let gated = true;
    vi.stubGlobal("fetch", trackTokenFetches((async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      if (gated && urlOf(input).endsWith("/token")) {
        gated = false;
        signalParked(); // a refresh grant has reached the endpoint and is held
        await tokenGate;
      }
      return realFetch(input, init);
    }) as typeof fetch));

    // Force the cached session stale and start a LAZY renewal; it reaches the
    // token endpoint and PARKS on the gate. `await parked` guarantees its
    // #begin has populated #sessions before the proactive timer fires below.
    await provider.invalidate(
      await provider.upgrade(new Request("https://pod.test/x")),
    );
    const lazy = provider.upgrade(new Request("https://pod.test/y"));
    await parked;

    // Fire the proactive timer NOW, with the lazy grant provably in flight. It
    // reads the in-flight #sessions entry and must JOIN it — not start a 2nd.
    await vi.advanceTimersByTimeAsync(65_000);

    releaseToken(); // release the single in-flight grant
    await lazy;
    await settleUntilGrants(1); // confirm the shared grant landed (joined, not doubled)

    expect(refreshGrants()).toHaveLength(1); // ONE grant shared by both paths
    expect(getCode).toHaveBeenCalledTimes(1); // and never a popup
  });

  it("schedules nothing for an issuer that got no refresh token (N/A — lazy path only)", async () => {
    as = await createFakeAuthorizationServer({
      expiresIn: 120,
      scopesSupported: ["openid", "webid"], // no offline_access → no refresh token
      webIdClaim: WEBID,
    });
    vi.stubGlobal("fetch", trackTokenFetches(as.fetch));
    vi.useFakeTimers();
    const { provider, getCode } = makeProvider();

    await provider.login(ISSUER);
    await tickQuiet(10 * 60_000);

    expect(refreshGrants()).toHaveLength(0); // nothing scheduled
    expect(getCode).toHaveBeenCalledTimes(1);
  });
});

describe("proactive refresh: visibility lifecycle", () => {
  it("a hidden tab does NOT fire the timer", async () => {
    vi.useFakeTimers();
    const visibility = new FakeVisibility();
    const { provider } = makeProvider(visibility);
    await provider.login(ISSUER);

    visibility.hide(); // backgrounded before the timer would fire
    await tickQuiet(10 * 60_000); // well past any fire point

    expect(refreshGrants()).toHaveLength(0); // no churn while hidden
  });

  it("visibility→visible while past the refresh window refreshes IMMEDIATELY", async () => {
    vi.useFakeTimers();
    const visibility = new FakeVisibility();
    const { provider, getCode } = makeProvider(visibility);
    await provider.login(ISSUER);

    visibility.hide();
    await tickQuiet(10 * 60_000); // timer dropped while hidden
    expect(refreshGrants()).toHaveLength(0);

    // Returning to the tab: ALWAYS re-evaluate expiry (don't trust the timer).
    visibility.show();
    await tickUntilGrants(0, 1); // the immediate resume refresh lands
    expect(refreshGrants()).toHaveLength(1);
    expect(getCode).toHaveBeenCalledTimes(1); // no popup on resume
  });

  it("visibility→visible BEFORE the window re-arms a timer rather than refreshing now", async () => {
    vi.useFakeTimers();
    const visibility = new FakeVisibility();
    const { provider } = makeProvider(visibility);
    await provider.login(ISSUER);

    visibility.hide();
    await tickQuiet(5_000); // still far from the fire point
    visibility.show();
    await tickQuiet(0);
    expect(refreshGrants()).toHaveLength(0); // not yet — re-armed, not fired

    await tickUntilGrants(60_000, 1); // now reach the window → the refresh lands
    expect(refreshGrants()).toHaveLength(1);
  });
});

describe("proactive refresh: teardown & logout", () => {
  it("teardown() clears timers AND releases the visibility listeners (no refresh after)", async () => {
    vi.useFakeTimers();
    const visibility = new FakeVisibility();
    const { provider } = makeProvider(visibility);
    await provider.login(ISSUER);
    expect(visibility.listenerCount).toBeGreaterThan(0);

    provider.teardown();
    expect(visibility.listenerCount).toBe(0);

    await tickQuiet(10 * 60_000);
    expect(refreshGrants()).toHaveLength(0); // no refresh after teardown
  });

  it("forgetPersisted() (logout) stops scheduling — no refresh after logout", async () => {
    vi.useFakeTimers();
    const { provider } = makeProvider();
    await provider.login(ISSUER);

    await provider.forgetPersisted(ISSUER); // logout
    await tickQuiet(10 * 60_000);

    expect(refreshGrants()).toHaveLength(0);
  });

  it("stopProactiveRefresh() halts an issuer's cycle without touching the session", async () => {
    vi.useFakeTimers();
    const { provider } = makeProvider();
    await provider.login(ISSUER);

    provider.stopProactiveRefresh(ISSUER);
    await tickQuiet(10 * 60_000);
    expect(refreshGrants()).toHaveLength(0);
  });
});

describe("proactive refresh: failure handling", () => {
  it("invalid_grant stops scheduling and opens NO window", async () => {
    vi.useFakeTimers();
    const { provider, getCode } = makeProvider();
    await provider.login(ISSUER);

    as.activeRefreshTokens.clear(); // revoked → invalid_grant on the proactive grant

    await tickUntilGrants(65_000, 1); // the proactive refresh fires (& then fails)
    const grantsAfterFail = refreshGrants().length;
    expect(grantsAfterFail).toBe(1); // it tried once
    expect(getCode).toHaveBeenCalledTimes(1); // and crucially NO popup/authorize

    // Scheduling STOPPED: no further attempts no matter how long we wait.
    await tickQuiet(10 * 60_000);
    expect(refreshGrants()).toHaveLength(grantsAfterFail);
    expect(getCode).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure with bounded backoff, still no popup", async () => {
    vi.useFakeTimers();
    const { provider, getCode } = makeProvider();
    await provider.login(ISSUER);

    // Make the NEXT few token-endpoint calls fail with a network error, then heal.
    // Composed through `trackTokenFetches` so the two failing attempts drained by
    // `tickQuiet` below are observed in-flight (else the negative drain could
    // conclude "idle" before a failing attempt has even left the endpoint).
    const realFetch = as.fetch;
    let failures = 2; // two transient failures, then success
    vi.stubGlobal(
      "fetch",
      trackTokenFetches(((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (failures > 0 && urlOf(input).endsWith("/token")) {
          failures--;
          return Promise.reject(new TypeError("network down"));
        }
        return realFetch(input, init);
      }) as typeof fetch),
    );

    await tickQuiet(65_000); // first proactive attempt → fails (retry armed at +2s)
    // Backoff base 2s, then 4s — advance through both retries; the 3rd succeeds.
    await tickQuiet(2_000); // second attempt → fails (retry armed at +4s)
    await tickUntilGrants(4_000, 1); // third attempt succeeds → the grant lands

    // It eventually succeeded after the bounded retries — no popup throughout.
    expect(refreshGrants().length).toBeGreaterThanOrEqual(1);
    expect(getCode).toHaveBeenCalledTimes(1);
  });

  it("gives up after the bounded retry budget (no infinite loop, no popup)", async () => {
    vi.useFakeTimers();
    const { provider, getCode } = makeProvider();
    await provider.login(ISSUER);

    // Permanently transient: every token call rejects. Composed through
    // `trackTokenFetches` so `tickQuiet` still observes each in-flight attempt
    // (the rejected fetch is in flight until it settles) — the negative
    // assertion below can't conclude "idle" mid-attempt.
    const realFetch = as.fetch;
    vi.stubGlobal(
      "fetch",
      trackTokenFetches(((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (urlOf(input).endsWith("/token")) return Promise.reject(new TypeError("network down"));
        return realFetch(input, init);
      }) as typeof fetch),
    );

    await tickQuiet(65_000); // attempt 1
    await tickQuiet(60_000); // burn all backoff windows
    const attempts = refreshGrants().length;

    await tickQuiet(10 * 60_000); // long after the budget
    expect(refreshGrants().length).toBe(attempts); // stopped — bounded
    expect(getCode).toHaveBeenCalledTimes(1); // never a popup
  });
});
