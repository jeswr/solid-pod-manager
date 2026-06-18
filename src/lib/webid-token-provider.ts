/**
 * webid-token-provider.ts — a custom @solid/reactive-authentication `TokenProvider`
 * whose OIDC issuer is resolved from the user's WebID profile (via callbacks),
 * instead of the published `DPoPTokenProvider`'s hard-coded host map.
 *
 * Ported from the published `DPoPTokenProvider` (v0.1.2), preserving its
 * authorization-code + PKCE + DPoP flow and its `prompt=none` silent-retry
 * behaviour. The ONE structural change: `#resolveIssuer()` dereferences the
 * WebID and reads `solid:oidcIssuer`, then asks `chooseIssuer` when several are
 * advertised — never silently the first.
 *
 * APP-SPECIFIC divergence (candidate for upstream): {@link WebIdDPoPTokenProvider.login}
 * goes INTERACTIVE-FIRST by default. An app-initiated login is explicit user
 * intent with (usually) no IdP session, so the upstream silent-first pattern
 * (PR #13) makes the user watch the popup bounce authorize →
 * callback.html?error=login_required → authorize before the login page.
 * Background paths (401 upgrade/renewal) keep silent-first: there the IdP
 * cookie usually lives and `prompt=none` succeeds without bothering the user.
 *
 * A second APP-SPECIFIC divergence (also a candidate for upstream):
 * {@link WebIdDPoPTokenProvider.canRenewWithoutInteraction} — a SYNCHRONOUS
 * probe the click handler consults BEFORE `window.open`, so no popup flashes
 * open when a cached session (or its refresh token) can complete the login
 * with fetches alone.
 *
 * Two app-supplied callbacks drive identity:
 *  - `getWebId()`   — how the app states whose WebID a 401-upgrade is for
 *                     (the Pod Manager seeds it from its login/restore state).
 *  - `getCode(uri)` — drives the user through the authorization endpoint
 *                     (the app-owned popup in `src/lib/popup-login.ts`).
 *
 * App-initiated logins with a KNOWN issuer (provider picker, bare-issuer
 * input) skip both via {@link WebIdDPoPTokenProvider.login}.
 *
 * `allowInsecureLoopback` is what makes LOCAL CSS work: it flips oauth4webapi's
 * `allowInsecureRequests` ONLY for `localhost`/`127.0.0.1` issuers, so the HTTP
 * issuer of a dev CSS is accepted while remote HTTPS issuers stay strict.
 */
import * as oauth from "oauth4webapi";
import * as DPoP from "dpop";
import type { GetCodeCallback } from "@solid/reactive-authentication";
import { freshRdf } from "./rdf-read.js";
import { resolveIssuers, validateWebId } from "./login-ux.js";
import type { PersistedSession, SessionStore } from "./session-persistence.js";

/**
 * The library's TokenProvider interface. @solid/reactive-authentication 0.1.2
 * does NOT re-export the `TokenProvider` type from its package entrypoint (only
 * the concrete providers), so we restate the (tiny, stable) structural contract
 * here. `ReactiveFetchManager` accepts any `Iterable<TokenProvider>`, and
 * matches structurally — this is the exact shape from the package's
 * `TokenProvider.d.ts`.
 */
export interface TokenProvider {
  matches(request: Request): Promise<boolean>;
  upgrade(request: Request): Promise<Request>;
  /**
   * Optional (upstream PR #14): called by `ReactiveFetchManager` when a request
   * this provider upgraded was STILL rejected with 401, so cached credentials
   * can be marked stale before the manager's single retry.
   */
  invalidate?(request: Request): Promise<void>;
}

/** Ask the user for their WebID. Resolves to the WebID string, or rejects/cancels. */
export type GetWebIdCallback = () => Promise<string>;

/**
 * Choose one issuer from several advertised on the profile. The default policy
 * is: a single issuer is used directly; more than one is an error (no callback =
 * no UI to choose, and silently picking the first is wrong). Apps that surface a
 * picker pass their own `chooseIssuer`.
 */
export type ChooseIssuerCallback = (issuers: string[]) => Promise<string>;

export interface WebIdDPoPTokenProviderOptions {
  /**
   * A **Solid-OIDC Client Identifier Document** URL. When set, the provider
   * SKIPS dynamic client registration and authenticates as a public client whose
   * `client_id` IS this URL (the spec's "Client Identifier" — a dereferenceable
   * JSON-LD document; see https://solidproject.org/TR/oidc#clientids). The OP
   * dereferences the URL and matches the redirect_uri against the document's
   * `redirect_uris`, so the document MUST list the {@link callbackUri} passed to
   * the constructor. With `none` token-endpoint auth (a public browser client),
   * no client secret is involved.
   *
   * The URL string MUST equal the document's `client_id` field byte-for-byte;
   * a trailing-slash or scheme/port mismatch makes the OP reject it.
   *
   * When ABSENT (default), the provider falls back to **dynamic client
   * registration** — convenient for local dev, but yields a throwaway client
   * with no stable name on the consent screen.
   */
  clientId?: string;
  /**
   * Pick one issuer when the profile advertises several. Defaults to a policy
   * that throws on ambiguity (see {@link AmbiguousIssuerError}). It is always
   * called with ≥ 1 issuer; with exactly one, the default returns it.
   */
  chooseIssuer?: ChooseIssuerCallback;
  /**
   * Enable oauth4webapi's `allowInsecureRequests` for `localhost` / `127.0.0.1`
   * issuers only (dev CSS over HTTP). Remote HTTPS issuers are unaffected, and
   * non-loopback HTTP issuers are never allowed. Default `false`.
   */
  allowInsecureLoopback?: boolean;
  /**
   * Override the fetch used to dereference the public WebID profile. Defaults to
   * the `globalThis.fetch` captured at CONSTRUCTION time (before
   * {@link https://github.com/solid-contrib/reactive-authentication ReactiveFetchManager}
   * patches the global) — see the recursion note in the class docs. Test-only.
   */
  profileFetch?: typeof fetch;
  /**
   * Durable store for the DPoP-bound refresh-token session (see
   * {@link ./session-persistence.ts}). When supplied, a successful login/refresh
   * PERSISTS its rotated refresh token + DPoP key, and {@link
   * WebIdDPoPTokenProvider.attemptRestore} can rebuild a returning user's session
   * via a `refresh_token` grant — a token-endpoint FETCH, no popup/iframe.
   * Absent (default): tokens stay in-memory only, the original behaviour.
   */
  sessionStore?: SessionStore;
  /**
   * Enable PROACTIVE background refresh: when a session carries `expires_in`,
   * schedule a refresh-token grant at a safe fraction of the lifetime (see
   * {@link proactiveRefreshAt}) so the cached session stays continuously fresh
   * and `upgrade()`/`fetch` never hits an expired token mid-flow. Off by default
   * — the lazy renew-on-401 / renew-on-expiry paths remain the only triggers.
   *
   * N/A without a refresh token (the server issued none): nothing is scheduled,
   * the lazy path stays in charge.
   */
  proactiveRefresh?: boolean;
  /**
   * Page-lifecycle surface for proactive scheduling (visibility + focus). Only
   * consulted when {@link proactiveRefresh} is on. Defaults to
   * {@link domVisibilityLifecycle} in a browser, and to a no-op (always-visible,
   * no events) under SSR/node — where there are no timers to leak anyway.
   * Injectable for tests.
   */
  visibilityLifecycle?: VisibilityLifecycle;
  /**
   * Timer surface for proactive scheduling. Defaults to `globalThis.setTimeout`/
   * `clearTimeout`. Injectable so tests can drive it with vitest fake timers
   * (which patch the globals — this just captures them) or a manual double.
   * @internal
   */
  setTimeoutFn?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** A {@link VisibilityLifecycle} that reports always-visible and never fires (SSR/node). */
const noopVisibilityLifecycle: VisibilityLifecycle = {
  isVisible: () => true,
  onResume: () => () => {},
  onHide: () => () => {},
};

/** A WebID advertises several issuers but no `chooseIssuer` was supplied. */
export class AmbiguousIssuerError extends Error {
  readonly webId: string;
  readonly issuers: string[];
  constructor(webId: string, issuers: string[]) {
    super(
      `This WebID advertises ${issuers.length} OIDC issuers — the app must supply ` +
        `a 'chooseIssuer' callback so the user can pick one (${webId}).`,
    );
    this.name = "AmbiguousIssuerError";
    this.webId = webId;
    this.issuers = issuers;
  }
}

/** The default issuer policy: single → it; several → throw (never pick silently). */
function defaultChooseIssuer(webId: string): ChooseIssuerCallback {
  return async (issuers: string[]) => {
    if (issuers.length === 1) return issuers[0];
    throw new AmbiguousIssuerError(webId, issuers);
  };
}

/** Per-issuer session state cached so repeat upgrades don't re-prompt. */
interface IssuerSession {
  authorizationServer: oauth.AuthorizationServer;
  clientRegistration: oauth.Client;
  dpopKey: CryptoKeyPair;
  /**
   * The oauth4webapi DPoP handle for token-endpoint requests. Reused for the
   * refresh grant so refreshed access tokens stay bound to the same key
   * (RFC 9449 §4.3) and server-provided DPoP nonces are remembered.
   */
  dpopHandle: oauth.DPoPHandle;
  accessToken: string;
  /**
   * The refresh token (RFC 6749 §6), when the server issued one. Replaced in
   * the renewed session whenever the server rotates it (RFC 9700 §4.14.2).
   */
  refreshToken: string | undefined;
  /**
   * Epoch ms after which the access token counts as expired (server-reported
   * `expires_in` minus a skew allowance), or undefined when none was reported.
   *
   * MIRRORS upstream reactive-authentication PR #11/#12 (session cache +
   * refresh tokens in `DPoPTokenProvider`) — delete this port when a release
   * containing them is published and this app moves back to the upstream
   * provider plus a `GetIssuerCallback`.
   */
  expiresAt: number | undefined;
  /**
   * The authenticated WebID, from the ID token's `webid` claim (Solid-OIDC
   * §5; `sub` accepted as a fallback when it is an http(s) URL, the NSS
   * convention). What lets an ISSUER-FIRST login (the user picked a provider,
   * no WebID typed) learn who just signed in. `undefined` when the ID token
   * carries neither.
   */
  webId: string | undefined;
}

/** Per-issuer proactive-refresh scheduler bookkeeping. */
interface IssuerScheduler {
  /** The pending refresh timer, or undefined when none is armed (hidden tab). */
  timer?: ReturnType<typeof setTimeout>;
  /** Consecutive transient-failure retries already spent for the current cycle. */
  retries: number;
  /**
   * The scheduled-for instant (epoch ms) the armed `timer` targets — so a
   * visibility resume can decide whether to refresh-now vs let the timer run.
   */
  fireAt?: number;
}

/**
 * Whether a code flow tries `prompt=none` before the interactive request.
 *
 * - `"silent-first"` — the upstream PR #13 pattern: try `prompt=none`; on
 *   `login_required` / `interaction_required` / `consent_required` retry
 *   interactively in the same popup. Right for BACKGROUND re-auth (the 401
 *   upgrade/renewal path), where the IdP cookie usually lives and the user
 *   should not see a login page they don't need.
 * - `"interactive"` — skip the doomed silent attempt and navigate the popup
 *   straight to the interactive authorize URL (still `prompt=consent` when
 *   opting into offline_access, OIDC Core §11). Right for EXPLICIT
 *   user-initiated logins, where there is (almost always) no IdP session and
 *   the silent hop is just a visible callback.html flash before the login page.
 */
type AuthorizeMode = "silent-first" | "interactive";

export interface LoginOptions {
  /**
   * Try `prompt=none` before the interactive request. Default `false`:
   * an app-initiated {@link WebIdDPoPTokenProvider.login} is explicit user
   * intent, so the popup goes straight to the login page. Pass `true` for
   * one-click re-login surfaces (e.g. a recent-account chip) where a live IdP
   * session is likely and silent success means zero typing.
   */
  silentFirst?: boolean;
  /**
   * The caller's "is THIS login still current?" generation re-check (the #123 fence),
   * evaluated AFTER the session settles to gate the provider-wide `#issuer` pin. Returns
   * false when a logout / a newer login superseded this login mid-flow, so the pin is
   * skipped and the newer actor's pin stands. Omitted → always pin (normal behaviour).
   */
  stillCurrent?: () => boolean;
  /**
   * The WebID the caller is logging in AS, when known up front (the #123 roborev MEDIUM). A
   * settled same-issuer session is REUSED (the no-popup path) ONLY when its `webId` matches this
   * — so a SAME-ISSUER ACCOUNT SWITCH (logged in as A, switching to B on the same issuer) does
   * NOT return A's cached session and then trip the caller's mismatch check; instead it forces a
   * FRESH interactive authentication for B. Omitted → reuse any settled session for the issuer
   * (the issuer-only login path, where no specific WebID was requested).
   */
  expectedWebId?: string;
}

/** Refresh this much before the reported expiry to absorb clock skew. */
const EXPIRY_SKEW_MS = 30_000;

function expiresAt(token: oauth.TokenEndpointResponse): number | undefined {
  return token.expires_in === undefined
    ? undefined
    : Date.now() + token.expires_in * 1000 - EXPIRY_SKEW_MS;
}

function hasExpired(session: IssuerSession): boolean {
  return session.expiresAt !== undefined && Date.now() >= session.expiresAt;
}

// ── Proactive-refresh scheduling policy ──────────────────────────────────────
//
// The lazy paths (upgrade()-on-expiry and renew-on-rejected-token) only renew
// AFTER a token is already stale, so a long import or an idle→active session
// can hit a momentary expired-token request before the lazy renewal completes.
// Proactive refresh keeps the cached session continuously fresh by running the
// refresh grant in the background BEFORE expiry.
//
// MIRRORS-CANDIDATE: this whole block is a strong upstream addition to
// reactive-authentication's DPoPTokenProvider (alongside the PR #11/#12 session
// cache + refresh tokens it builds on). Keep these comments when porting.

/**
 * Refresh at most this long before the (skew-adjusted) expiry, even for very
 * long-lived tokens — a multi-hour token still refreshes within a bounded
 * window of expiry rather than hours early (pointless churn).
 */
const PROACTIVE_MAX_LEAD_MS = 5 * 60_000;
/**
 * Refresh at least this long before expiry, even for very short-lived tokens,
 * so the grant's own round-trip completes with margin to spare.
 */
const PROACTIVE_MIN_LEAD_MS = 30_000;
/** Never schedule a timer shorter than this — coalesce near-immediate fires. */
const PROACTIVE_MIN_DELAY_MS = 1_000;
/** Bounded retries for transient/network refresh failures before giving up. */
const PROACTIVE_MAX_RETRIES = 3;
/** Base backoff between transient-failure retries (doubled each attempt). */
const PROACTIVE_RETRY_BASE_MS = 2_000;

/**
 * When (epoch ms) to PROACTIVELY refresh a session whose access token expires
 * at `expiresAt`. Policy: fire at ~75% of the lifetime elapsed, OR
 * `expiresAt - max(30s, 10% of lifetime)`, whichever is SOONER — then clamp the
 * lead time into [30s, 5min] so very short tokens still refresh early enough and
 * very long ones don't churn hours ahead. `expiresAt` here is the provider's
 * skew-adjusted expiry (already 30s before the server's), so the schedule sits a
 * little further still inside the real lifetime — exactly the safety we want.
 *
 * Returns `undefined` when the token has no reported lifetime (nothing to
 * schedule against) — the lazy path remains the only renewal trigger.
 */
function proactiveRefreshAt(
  session: IssuerSession,
  now: number = Date.now(),
): number | undefined {
  if (session.expiresAt === undefined) return undefined;
  const remaining = session.expiresAt - now;
  // The lifetime as the provider sees it (skew already removed in expiresAt()).
  const lifetime = Math.max(remaining, 0);
  // "75% elapsed" measured from NOW over the remaining window.
  const at75 = now + remaining * 0.75;
  // expiresAt - max(30s, 10% of lifetime).
  const leadFromTenth = Math.max(PROACTIVE_MIN_LEAD_MS, lifetime * 0.1);
  const atLead = session.expiresAt - leadFromTenth;
  // Whichever is SOONER.
  let fireAt = Math.min(at75, atLead);
  // Clamp the LEAD (expiresAt - fireAt) into [MIN, MAX].
  const lead = session.expiresAt - fireAt;
  if (lead < PROACTIVE_MIN_LEAD_MS) fireAt = session.expiresAt - PROACTIVE_MIN_LEAD_MS;
  else if (lead > PROACTIVE_MAX_LEAD_MS) fireAt = session.expiresAt - PROACTIVE_MAX_LEAD_MS;
  return fireAt;
}

/**
 * The page-lifecycle surface proactive scheduling consults — injectable so the
 * provider can be driven in node tests and degrade to a no-op under SSR. Models
 * just the slice we need of the Page Visibility API + window focus.
 *
 * Production wires {@link domVisibilityLifecycle} (document/window). When
 * `undefined` (SSR/node), scheduling treats the page as always-visible and skips
 * the visibility gating — fine for non-browser callers, which have no timers to
 * leak anyway.
 */
export interface VisibilityLifecycle {
  /** Is the page currently visible? (`document.visibilityState === "visible"`.) */
  isVisible(): boolean;
  /**
   * Subscribe to "page became visible OR window regained focus". Called when the
   * user returns to a backgrounded tab — the cue to re-evaluate expiry (timers
   * may have been throttled/dropped while hidden or during OS sleep). Returns an
   * unsubscribe function.
   */
  onResume(listener: () => void): () => void;
  /**
   * Subscribe to "page became hidden". Returns an unsubscribe function. Used to
   * stop firing timers in a backgrounded tab (battery + pointless token churn).
   */
  onHide(listener: () => void): () => void;
}

/**
 * The production {@link VisibilityLifecycle}: the Page Visibility API
 * (`visibilitychange`) plus a window `focus`/`blur` pair (focus catches the
 * alt-tab-back case some browsers report only as focus, not visibilitychange).
 * Construct only in the browser.
 */
export function domVisibilityLifecycle(
  doc: Document = document,
  win: Window = window,
): VisibilityLifecycle {
  return {
    isVisible: () => doc.visibilityState === "visible",
    onResume(listener) {
      const onVis = () => {
        if (doc.visibilityState === "visible") listener();
      };
      doc.addEventListener("visibilitychange", onVis);
      win.addEventListener("focus", listener);
      return () => {
        doc.removeEventListener("visibilitychange", onVis);
        win.removeEventListener("focus", listener);
      };
    },
    onHide(listener) {
      const onVis = () => {
        if (doc.visibilityState === "hidden") listener();
      };
      doc.addEventListener("visibilitychange", onVis);
      return () => doc.removeEventListener("visibilitychange", onVis);
    },
  };
}

const isLoopback = (host: string): boolean =>
  host === "localhost" || host === "127.0.0.1" || host === "[::1]";

export class WebIdDPoPTokenProvider implements TokenProvider {
  readonly #callbackUri: string;
  readonly #getCode: GetCodeCallback;
  readonly #getWebId: GetWebIdCallback;
  readonly #clientId?: string;
  readonly #chooseIssuer?: ChooseIssuerCallback;
  readonly #allowInsecureLoopback: boolean;
  /**
   * Durable refresh-token-session store, when persistence is enabled. The whole
   * raison d'être of {@link attemptRestore}: a returning user (in-memory state
   * gone) is restored from here via a refresh grant, no window. `undefined`
   * keeps the in-memory-only behaviour.
   */
  readonly #sessionStore?: SessionStore;
  /**
   * The profile is PUBLIC, so reading it needs no auth. We must not read it
   * through the patched global fetch in a way that recurses back into this
   * provider on a 401. We snapshot `globalThis.fetch` at construction — the
   * provider is built BEFORE `new ReactiveFetchManager([provider])` patches the
   * global, so this snapshot is the original, un-upgrading fetch. (A public
   * profile won't 401 anyway, but this keeps the read provably out of the
   * reactive loop regardless of access-control surprises.)
   */
  readonly #profileFetch: typeof fetch;
  /**
   * Memoised issuer resolution: the user is asked for their WebID ONCE per
   * provider instance, not on every 401 — and concurrent 401s share the same
   * in-flight prompt (single-flight). Cleared on failure so a cancelled or
   * failed prompt can be retried.
   */
  #issuer?: Promise<URL>;
  /** Single-flight session per issuer: parallel 401s share one login flow. */
  readonly #sessions = new Map<string, Promise<IssuerSession>>();
  /**
   * The last SETTLED session per issuer — a synchronous snapshot beside the
   * promise map above, kept solely so {@link canRenewWithoutInteraction} can
   * answer without awaiting anything (a click handler must decide whether to
   * `window.open` BEFORE its user activation is consumed by an await). Never
   * read on the auth path itself; `#sessions` stays the single-flight truth.
   */
  readonly #settledSessions = new Map<string, IssuerSession>();
  /**
   * Per-issuer COMMIT SERIALISATION (the #123 roborev MEDIUM): a chain of the in-flight
   * `#commitSession` promise per `issuer.href`, so two concurrent same-issuer establishes never
   * INTERLEAVE their durable `put`/`compareAndDelete` — an older superseded establish's stale
   * `put` can't land AFTER a newer login's `put` and overwrite the winning token (which the
   * older's compare-and-delete would then remove, leaving no credential). Commits for the same
   * issuer run strictly one-after-another; different issuers stay concurrent.
   */
  readonly #commitChains = new Map<string, Promise<unknown>>();
  /**
   * In-flight LOGIN-path refresh single-flight per issuer (the #123 roborev MEDIUM): unlike
   * `#sessions` (which also holds RESOLVED sessions, so it cannot tell pending from settled), this
   * holds ONLY a genuinely IN-FLIGHT login refresh promise, set synchronously and cleared on
   * settle. A concurrent same-issuer login JOINS it rather than redeeming the rotating refresh
   * token a second time (which would invalid_grant). Login-only: the lazy upgrade/proactive paths
   * keep their own `#sessions` single-flight.
   */
  readonly #inflightLoginRefreshes = new Map<string, Promise<IssuerSession>>();
  /**
   * PER-ISSUER EPOCH FENCE (the #123 whole-branch roborev HIGHs — proactive overwrite + late
   * forget resurrection). A monotonic generation counter per `issuer.href`, the SINGLE source of
   * truth a background/proactive/lazy commit consults before it may publish or persist for an
   * issuer. It is:
   *
   *  - CAPTURED at the start of every commit-producing path (explicit/fresh login establish,
   *    proactive `#fireProactive`, lazy renew/refresh, restore) via {@link #fenceFor};
   *  - RE-CHECKED before each `#sessions` / `#settledSessions` / `#issuer` / persist WRITE — a
   *    captured epoch that no longer equals the current one ⇒ the path YIELDS without writing
   *    (it is folded into the `stillCurrent` predicate, so `#commitSessionInner`'s existing
   *    pre-persist + post-persist + publish re-checks all honour it for free);
   *  - BUMPED, BEFORE any state is cleared, by {@link forgetIssuer} (logout / cancel) and by a
   *    SUPERSEDING fresh login (a same-issuer account switch), via {@link #bumpEpoch}.
   *
   * The two HIGHs this closes:
   *   1. A same-issuer account switch: an OLD account's in-flight proactive refresh (which still
   *      reads `#settledSessions`/`#sessions`, kept OUT of the in-flight join for the fresh login
   *      via `exposeInFlight: false`) can no longer finish AFTER the new login commits and
   *      OVERWRITE the caches/persistence with the old credential — the fresh login bumps the
   *      epoch at the start of its establishment, so the older refresh's captured epoch is stale
   *      and its commit yields.
   *   2. A `forgetIssuer()` (logout/cancel) bumps the epoch BEFORE clearing state, so a pending
   *      `#commitSession` (default always-current predicate) / proactive / lazy refresh that
   *      finishes AFTER the forget sees a stale epoch and publishes/persists NOTHING — it can no
   *      longer RESURRECT the just-forgotten issuer.
   *
   * Integrated with (not duplicating) the existing `stillCurrent`/`establishStillCurrent`
   * fencing: a caller's own `stillCurrent` (generation+WebID) is ANDed with the epoch check, so
   * a path is "still current" only when BOTH hold.
   */
  readonly #issuerEpoch = new Map<string, number>();
  /** Whether proactive background refresh is enabled (opt-in). */
  readonly #proactiveRefresh: boolean;
  /** Page-lifecycle surface (visibility/focus) for proactive scheduling. */
  readonly #visibility: VisibilityLifecycle;
  readonly #setTimeout: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly #clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  /**
   * Per-issuer proactive-refresh scheduler state. An entry exists only while an
   * issuer is being kept fresh; cleared on logout, teardown, dead refresh token,
   * or a no-refresh-token session. See {@link #scheduleProactive}.
   */
  readonly #schedulers = new Map<string, IssuerScheduler>();
  /** Unsubscribe handles for the (single, shared) visibility listeners. */
  #visibilityUnsub?: () => void;
  /** Set by {@link teardown}; stops all future scheduling permanently. */
  #destroyed = false;
  /**
   * Shared auth work (issuer resolution, login) is provider-owned: it must NOT
   * be tied to any single request's AbortSignal, or aborting one request would
   * cancel the login other concurrent 401 upgrades are waiting on. The user
   * cancels via the dialog/popup themselves, which rejects the shared promise.
   */
  readonly #authSignal = new AbortController().signal;

  constructor(
    callbackUri: string,
    getCode: GetCodeCallback,
    getWebId: GetWebIdCallback,
    options: WebIdDPoPTokenProviderOptions = {},
  ) {
    this.#callbackUri = callbackUri;
    this.#getCode = getCode;
    this.#getWebId = getWebId;
    this.#clientId = options.clientId;
    this.#chooseIssuer = options.chooseIssuer;
    this.#allowInsecureLoopback = options.allowInsecureLoopback ?? false;
    this.#profileFetch =
      options.profileFetch ?? globalThis.fetch.bind(globalThis);
    this.#sessionStore = options.sessionStore;
    this.#proactiveRefresh = options.proactiveRefresh ?? false;
    this.#visibility =
      options.visibilityLifecycle ??
      (this.#proactiveRefresh && typeof document !== "undefined"
        ? domVisibilityLifecycle()
        : noopVisibilityLifecycle);
    this.#setTimeout =
      options.setTimeoutFn ??
      ((handler, ms) => setTimeout(handler, ms));
    this.#clearTimeout = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  }

  /** oauth4webapi request options, enabling insecure loopback per the policy. */
  #httpOptions(
    issuer: URL,
    signal: AbortSignal,
  ): { signal: AbortSignal; [oauth.allowInsecureRequests]?: true } {
    if (this.#allowInsecureLoopback && isLoopback(issuer.hostname)) {
      return { signal, [oauth.allowInsecureRequests]: true };
    }
    return { signal };
  }

  /**
   * WebID-driven issuer resolution — the one structural change from the
   * published provider. Ask the app for a WebID, validate it, dereference its
   * public profile (out-of-loop fetch), read every `solid:oidcIssuer`, then let
   * the app choose when several are advertised.
   */
  async #resolveIssuer(signal: AbortSignal): Promise<URL> {
    const webId = validateWebId(await this.#getWebId());
    signal.throwIfAborted();
    const { dataset } = await freshRdf(webId, this.#profileFetch);
    const issuers = resolveIssuers(webId, dataset);
    const choose = this.#chooseIssuer ?? defaultChooseIssuer(webId);
    const chosen = await choose(issuers);
    return new URL(chosen);
  }

  async matches(): Promise<boolean> {
    return true;
  }

  /**
   * App-initiated login against a KNOWN issuer — the entry point for the
   * first-party login UI (provider picker / bare-issuer input), where the
   * app resolved the issuer itself and a WebID may not exist yet.
   *
   * Pins the provider's issuer (subsequent 401 upgrades reuse it without
   * prompting), drives the code flow through the cached-session machinery
   * (instant when a fresh session exists; popup otherwise), and reports the
   * authenticated WebID from the ID token when the server states one.
   *
   * INTERACTIVE-FIRST by default (app-specific divergence from the upstream
   * silent-first pattern; see the module docs): the silent `prompt=none`
   * attempt is skipped unless {@link LoginOptions.silentFirst} asks for it.
   *
   * SUPERSESSION-SAFE PIN (the #123 roborev HIGH): pinning `#issuer` is the provider-WIDE
   * mutation `upgrade()` reads to choose whose session to attach. `options.stillCurrent`
   * (the caller's generation re-check) is evaluated AFTER the session settles and gates the
   * pin: a login superseded mid-flow (a logout / a NEWER login won the race) leaves the
   * newer actor's pin intact rather than re-pinning to this abandoned login. The pin is
   * folded to AFTER `#getSession` (it scopes only FUTURE `upgrade()` calls, not the current
   * flow, which is passed `issuer` explicitly), so deferring it changes no in-flow behaviour.
   * Default (always pin) preserves the normal login behaviour. (The issuer-keyed session
   * cache + persistence are committed by `#getSession`/`#begin` keyed by `issuer.href`; a
   * same-issuer racing login's own commit overwrites them last-writer, and the SessionProvider
   * adds a fail-closed WebID-mismatch check so a joined stale session can never publish.)
   */
  async login(
    issuer: URL,
    options: LoginOptions = {},
  ): Promise<{ webId: string | undefined }> {
    const mode: AuthorizeMode =
      options.silentFirst === true ? "silent-first" : "interactive";
    const stillCurrent = options.stillCurrent ?? (() => true);
    // SUPERSEDE BACKGROUND WORK (the #123 whole-branch HIGH #1): an explicit user-initiated login
    // is a NEW actor for this issuer — BUMP the issuer epoch up front so any OLD account's
    // in-flight proactive/lazy refresh (which captured the PRIOR epoch) becomes stale and its
    // commit yields, and so it cannot finish AFTER this login and OVERWRITE the caches/persistence
    // with the superseded credential. This login then runs `#getSession`/`#begin` AFTER the bump,
    // so it captures the NEW epoch and commits for itself. (Bumping on a same-account no-popup
    // reuse is harmless: the reused settled session is untouched and the next proactive cycle
    // re-arms from it.)
    this.#bumpEpoch(issuer.href);
    // The FENCED COMMIT (the #123 roborev HIGH): pass the freshness predicate into
    // `#getSession`/`#begin` so a superseded login commits NOTHING provider-wide (no
    // settled-session cache, no persist, no scheduler) — symmetric with `restoreIssuer`. The
    // `forLogin` flag makes `#getSession` reuse only a fully-SETTLED fresh session (the
    // no-popup "Continue as" path) and NEVER JOIN another login's still-PENDING in-flight work
    // (the #123 same-issuer wrong-identity join — an explicit login establishes its OWN
    // identity, so it must not adopt an earlier, possibly-superseded login's in-flight WebID).
    const session = await this.#getSession(
      issuer,
      this.#authSignal,
      mode,
      stillCurrent,
      // The `forLogin` reuse policy: reuse a settled session only when it matches the requested
      // WebID (or none was requested). A SAME-ISSUER ACCOUNT SWITCH to a known different WebID
      // forces fresh auth instead of returning the prior account's session (the #123 MEDIUM).
      { expectedWebId: options.expectedWebId },
    );
    // Pin the provider-wide issuer for future lazy 401 upgrades — but ONLY if this login is
    // still current. A superseded login leaves the newer actor's pin intact.
    if (stillCurrent()) this.#issuer = Promise.resolve(issuer);
    return { webId: session.webId };
  }

  /**
   * SYNCHRONOUS probe: would {@link login} for this issuer complete without
   * any authorize navigation? True when the last settled session is still
   * fresh (within the expiry skew) OR carries a refresh token — the refresh
   * grant (RFC 6749 §6) is a plain fetch, no popup. False when nothing is
   * cached, the cached state is unusable, or a first login is still in
   * flight (unknown ≠ yes).
   *
   * The click handler uses this to decide whether to `window.open` while the
   * user activation is live (`openPopupUnlessRenewable` in popup-login.ts).
   * A YES can still be wrong — the server may reject the refresh grant — in
   * which case {@link #renew} drops the dead token (keeping this probe honest
   * for the next click) and the code-flow fallback recovers via the popup
   * controller's `onBlocked` affordance, never a raw unactivated open.
   *
   * APP-SPECIFIC (candidate for upstream alongside the PR #11/#12 session
   * cache): upstream's DPoPTokenProvider exposes no popup-avoidance probe.
   */
  canRenewWithoutInteraction(issuer: URL, expectedWebId?: string): boolean {
    const session = this.#settledSessions.get(issuer.href);
    if (session === undefined) return false;
    // WEBID-AWARE (the #123 roborev MEDIUM): when a specific WebID is requested (a same-issuer
    // account switch), the cached session is renewable WITHOUT a popup ONLY if it is for THAT
    // WebID. A cached session for a DIFFERENT WebID on the same issuer will NOT be reused by
    // `login(expectedWebId)` (it forces fresh interactive auth), so the popup-avoidance probe
    // must report false here — otherwise the click handler skips opening the popup and the
    // interactive auth lands outside the user activation (the blocked-popup path).
    if (expectedWebId !== undefined && session.webId !== expectedWebId) return false;
    return !hasExpired(session) || session.refreshToken !== undefined;
  }

  async upgrade(request: Request): Promise<Request> {
    this.#issuer ??= this.#resolveIssuer(this.#authSignal).catch((e) => {
      this.#issuer = undefined; // allow retry after cancel/failure
      throw e;
    });
    const issuer = await this.#issuer;
    const session = await this.#getSession(issuer, this.#authSignal);
    const headers = new Headers(request.headers);
    headers.set(
      "DPoP",
      await DPoP.generateProof(
        session.dpopKey,
        request.url,
        request.method,
        undefined,
        session.accessToken,
      ),
    );
    headers.set("Authorization", ["DPoP", session.accessToken].join(" "));
    return new Request(request, { headers });
  }

  /**
   * Marks the cached session stale when the access token attached to the
   * request was rejected by the resource server (still 401 after an upgrade):
   * revoked, invalidated early, or expired without a server-reported lifetime.
   * The next upgrade then renews the session — refresh grant first, popup flow
   * as fallback — instead of replaying the rejected token.
   *
   * MIRRORS upstream reactive-authentication PR #14 (`TokenProvider.invalidate`
   * + the manager's 401-once retry) — delete with the rest of this port when a
   * release containing it is published.
   */
  async invalidate(request: Request): Promise<void> {
    const issuer = await this.#issuer?.catch(() => undefined);
    if (issuer === undefined) return;
    const pending = this.#sessions.get(issuer.href);
    if (pending === undefined) return;

    const session = await pending.catch(() => undefined);

    // Only when the rejected token is still the cached one — a concurrent
    // renewal may already have replaced it.
    if (
      session !== undefined &&
      request.headers.get("Authorization") === `DPoP ${session.accessToken}`
    ) {
      session.expiresAt = 0;
    }
  }

  /**
   * Reuse the (possibly in-flight) session for the issuer; renew an expired one
   * (transparently via the refresh-token grant where possible); else run the
   * code flow once, with `mode` deciding whether that flow tries `prompt=none`
   * first (background re-auth) or goes straight to the login page (explicit
   * login).
   */
  async #getSession(
    issuer: URL,
    signal: AbortSignal,
    mode: AuthorizeMode = "silent-first",
    stillCurrent: () => boolean = () => true,
    forLogin: false | { expectedWebId?: string } = false,
  ): Promise<IssuerSession> {
    // NO-JOIN for an explicit login (the #123 roborev HIGH): an explicit `login()` may REUSE a
    // fully-SETTLED fresh session (the no-popup "Continue as" path), but must NEVER JOIN a
    // still-PENDING in-flight entry left by an EARLIER login for the same issuer — that would
    // let this (newer) login adopt the earlier login's authenticated WebID and publish the
    // WRONG identity on a same-issuer / issuer-only account switch. So a login reads the
    // SETTLED snapshot only; a non-login caller (lazy 401 upgrade / proactive refresh) keeps
    // the original join-the-in-flight-work behaviour for dedup.
    if (forLogin) {
      const expectedWebId = forLogin.expectedWebId;
      const cachedSettled = this.#settledSessions.get(issuer.href);
      // SAME-ISSUER ACCOUNT-SWITCH GUARD (the #123 roborev MEDIUM): only treat a settled session
      // as reusable when it matches the requested WebID (or none was requested). Switching to a
      // DIFFERENT known WebID on the same issuer must NOT reuse / renew the prior account's
      // session — it forces a FRESH interactive authentication for the requested identity.
      const settled =
        cachedSettled !== undefined &&
        (expectedWebId === undefined || cachedSettled.webId === expectedWebId)
          ? cachedSettled
          : undefined;
      if (settled !== undefined && !hasExpired(settled)) {
        // A settled, still-fresh session ⇒ reuse it (the no-popup "Continue as" path).
        return settled;
      }
      if (settled !== undefined && settled.refreshToken !== undefined) {
        // Settled but expired, WITH a refresh token ⇒ try the refresh grant (still no popup).
        // Two-part design (the #123 roborev MEDIUM):
        //   1. DEDUP only the PURE `#refresh` GRANT per issuer — concurrent same-issuer logins
        //      must NOT each redeem the ROTATING refresh token (that trips invalid_grant). The
        //      in-flight map holds the bare grant promise (NO `#begin`, NO commit, NO fence).
        //   2. EACH login then runs its OWN fenced `#commitSession` against the shared grant
        //      result with ITS OWN `stillCurrent` — so a login that is STILL current commits +
        //      publishes for itself, regardless of whether a SIBLING (e.g. the one that started
        //      the grant) was superseded. Reusing one login's fence for all joiners would let a
        //      superseded starter's fence skip the commit while a still-current joiner returns
        //      logged-in with NOTHING committed (the finding). We deliberately do NOT expose the
        //      grant via `#begin`'s `#sessions` single-flight (a code-flow path could be joined
        //      by a lazy upgrade — the earlier HIGH); the dedup is this dedicated grant map.
        const inflight = this.#inflightLoginRefreshes.get(issuer.href);
        let grant = inflight;
        if (grant === undefined) {
          grant = this.#refresh(issuer, settled, settled.refreshToken);
          this.#inflightLoginRefreshes.set(issuer.href, grant);
          // Clear the in-flight entry when the grant settles (compare-and-swap on the tail).
          void grant.catch(() => undefined).finally(() => {
            if (this.#inflightLoginRefreshes.get(issuer.href) === grant) {
              this.#inflightLoginRefreshes.delete(issuer.href);
            }
          });
        }
        // EPOCH FENCE (the #123 whole-branch HIGHs): capture the issuer epoch before awaiting the
        // shared grant, so a `forgetIssuer`/superseding-login bump that lands while we wait makes
        // this login's own commit yield (no resurrection of a forgotten / superseded issuer).
        const fenced = this.#fenceFor(issuer.href, stillCurrent);
        try {
          const granted = await grant;
          // THIS login's OWN fenced commit against the shared grant result (publish-last,
          // atomic, per-issuer-serialised — `#commitSession`). A superseded/cancelled login
          // commits nothing; a still-current one commits + publishes for itself.
          await this.#commitSession(issuer, granted, fenced, { pin: false });
          return granted;
        } catch {
          // The refresh grant was rejected (expiry / revocation / rotation reuse). DROP the dead
          // token IN PLACE on the settled snapshot so the synchronous probe
          // (`canRenewWithoutInteraction`) stops promising a popup-free renewal on the next click
          // (matching `#renew`'s behaviour). Then fall through to a FRESH interactive
          // authentication, which must NOT be exposed (next block).
          settled.refreshToken = undefined;
        }
      }
      // No reusable settled session — OR the refresh grant just failed — ⇒ authenticate FRESH
      // for THIS login (the code flow / popup), never adopting an earlier login's in-flight
      // identity. `exposeInFlight: false` keeps this fresh login's establishment work OUT of the
      // shared `#sessions` map until the commit fence passes, so no concurrent upgrade joins (and
      // uses) a not-yet-final, possibly-superseded or DIFFERENT-account session (the #123 roborev
      // HIGH — premature in-flight join). `stillCurrent` is threaded into `#authenticate` so a
      // superseded login never drives the shared popup (the #123 stale-login popup guard).
      return this.#begin(issuer, this.#authenticate(issuer, signal, mode, stillCurrent), stillCurrent, false);
    }

    const cached = this.#sessions.get(issuer.href);
    if (cached === undefined) {
      return this.#begin(issuer, this.#authenticate(issuer, signal, mode, stillCurrent), stillCurrent);
    }

    const session = await cached;
    if (!hasExpired(session)) return session;

    // Renew, unless a concurrent caller already replaced the expired session.
    if (this.#sessions.get(issuer.href) === cached) {
      this.#sessions.delete(issuer.href);
      return this.#begin(issuer, this.#renew(issuer, session, signal, mode, stillCurrent), stillCurrent);
    }
    return this.#getSession(issuer, signal, mode, stillCurrent, forLogin);
  }

  /**
   * Cache the in-flight work; evict on failure so the next request can retry.
   *
   * FENCED COMMIT (the #123 roborev HIGH): `stillCurrent` (default always-true for the lazy
   * upgrade / proactive-refresh callers that MAINTAIN an established session) is re-checked
   * AFTER the work resolves and gates the provider-wide COMMIT — the settled-session cache,
   * the durable persist, and the proactive scheduler. A LOGIN superseded mid-flow (a logout /
   * a newer same-issuer login won the race) passes a predicate that returns false, so the
   * stale login commits NOTHING provider-wide: it returns the session to its caller (which
   * will itself bail at the SessionProvider fence) but never overwrites/resurrects the caches
   * or the persisted credential. The in-flight `#sessions` entry it set is rolled back
   * (compare-and-delete) so a concurrent same-issuer reader cannot join this abandoned work.
   */
  async #begin(
    issuer: URL,
    work: Promise<IssuerSession>,
    stillCurrent: () => boolean = () => true,
    exposeInFlight = true,
  ): Promise<IssuerSession> {
    // `exposeInFlight` (default true) publishes the in-flight `work` into `#sessions` so a
    // CONCURRENT lazy upgrade / proactive refresh DEDUPS onto it (the established single-flight
    // contract). The LOGIN establishment paths pass false (the #123 roborev HIGH): an explicit
    // login's not-yet-final session must NOT be joinable by a concurrent upgrade before the
    // post-persist commit fence, or that upgrade could USE a session about to be rolled back as
    // superseded. With false, only the COMMITTED session is published (post-fence, by
    // `#commitSession`), never the raw in-flight work.
    // EPOCH FENCE (the #123 whole-branch HIGHs): capture the issuer epoch NOW (before awaiting
    // `work`) and AND it into the freshness predicate, so a `forgetIssuer`/superseding-login bump
    // that lands while this work is in flight makes EVERY downstream write (the roll-back checks
    // below + `#commitSession`) yield. Unifies the supersession `stillCurrent` with the
    // issuer-epoch cancellation in one predicate.
    const fenced = this.#fenceFor(issuer.href, stillCurrent);
    if (exposeInFlight) this.#sessions.set(issuer.href, work);
    try {
      const session = await work;
      // SUPERSEDED-OR-CANCELLED before commit: do not commit provider-wide. Roll back our
      // in-flight entry (only if it is still ours — never clobber a newer login's) and return
      // uncommitted.
      if (!fenced()) {
        if (exposeInFlight && this.#sessions.get(issuer.href) === work) {
          this.#sessions.delete(issuer.href);
        }
        return session;
      }
      // Commit ATOMICALLY w.r.t. supersession (the #123 roborev HIGH): persist FIRST, re-check
      // the fence AFTER persist, and publish the reusable caches LAST (only when still
      // current) — so a superseded login never exposes/persists a credential that outlives it.
      // `#begin` never pins `#issuer` (login() pins separately, gated on its own freshness).
      const committed = await this.#commitSession(issuer, session, fenced, { pin: false });
      // If the commit did NOT publish (superseded/cancelled post-persist) AND we exposed an
      // in-flight entry, evict it so no concurrent reader joins this abandoned session
      // (compare-and-swap: never clobber a newer login that already replaced the slot).
      if (!committed && exposeInFlight && this.#sessions.get(issuer.href) === work) {
        this.#sessions.delete(issuer.href);
      }
      return session;
    } catch (e) {
      if (exposeInFlight && this.#sessions.get(issuer.href) === work) {
        this.#sessions.delete(issuer.href);
      }
      throw e;
    }
  }

  // ── Proactive refresh (opt-in; MIRRORS-CANDIDATE for upstream) ─────────────
  //
  // Composes WITH the lazy paths rather than replacing them: every settled
  // session reschedules here (#begin), and a fired refresh runs through the SAME
  // single-flight #getSession machinery a lazy upgrade()/invalidate() uses — so a
  // proactive refresh in flight satisfies a concurrent upgrade(), and the two
  // never stampede the token endpoint. The persistence path is untouched: the
  // refresh grant rotates + #persist()s the new token exactly as the lazy renew
  // does. The renew-on-rejected path (invalidate) still wins on real 401s — a
  // proactive refresh just makes those rare during active use.

  /**
   * Arm (or re-arm) the proactive refresh timer for an issuer from a freshly
   * settled session. No-op unless proactive refresh is enabled AND the session
   * holds a refresh token with a reported lifetime (otherwise there is nothing
   * to refresh with, or nothing to schedule against — the lazy path stays).
   *
   * Idempotent per session: clears any prior timer first. Subscribes the shared
   * visibility listeners on first use. While the tab is HIDDEN, no timer is armed
   * — the resume listener re-evaluates on return instead (battery + sleep-drop
   * correctness).
   */
  #scheduleProactive(issuer: URL, session: IssuerSession): void {
    if (!this.#proactiveRefresh || this.#destroyed) return;
    // N/A without a refresh token or a reported lifetime — document: the lazy
    // path remains the only renewal trigger for these sessions.
    if (session.refreshToken === undefined) {
      this.#clearScheduler(issuer.href);
      return;
    }
    const fireAt = proactiveRefreshAt(session);
    if (fireAt === undefined) {
      this.#clearScheduler(issuer.href);
      return;
    }

    this.#ensureVisibilitySubscribed();

    let scheduler = this.#schedulers.get(issuer.href);
    if (scheduler === undefined) {
      scheduler = { retries: 0 };
      this.#schedulers.set(issuer.href, scheduler);
    } else if (scheduler.timer !== undefined) {
      this.#clearTimeout(scheduler.timer);
      scheduler.timer = undefined;
    }
    // A successfully (re)scheduled cycle starts a fresh retry budget.
    scheduler.retries = 0;
    scheduler.fireAt = fireAt;

    // Don't run timers in a hidden tab: the resume listener will re-evaluate.
    if (!this.#visibility.isVisible()) {
      scheduler.timer = undefined;
      return;
    }
    this.#armTimer(issuer, scheduler, fireAt);
  }

  /** Arm a timer to fire the proactive refresh at `fireAt` (clamped ≥ now). */
  #armTimer(issuer: URL, scheduler: IssuerScheduler, fireAt: number): void {
    const delay = Math.max(PROACTIVE_MIN_DELAY_MS, fireAt - Date.now());
    scheduler.fireAt = fireAt;
    scheduler.timer = this.#setTimeout(() => {
      scheduler.timer = undefined;
      void this.#fireProactive(issuer);
    }, delay);
  }

  /**
   * Run a proactive refresh in the background, SHARING the single-flight session
   * cache with the lazy paths so the two never stampede the token endpoint:
   *
   *  - If a renewal/login is already IN FLIGHT for this issuer (`#sessions` holds
   *    a pending entry — a concurrent `upgrade()`→`#renew`, a `restoreIssuer`, …),
   *    JOIN it instead of starting a second grant. When it settles fresh, the
   *    cycle is satisfied (that entry's own {@link #begin} already rescheduled);
   *    only if it settles still-expired do we fall through and refresh ourselves.
   *  - Otherwise publish our own refresh-token grant into the cache via
   *    {@link #begin}, so a concurrent `upgrade()` that arrives mid-flight sees
   *    and shares it rather than firing its own.
   *
   * The refresh is driven through {@link #refresh} DIRECTLY (not {@link #renew}),
   * so a dead/transient grant is handled here WITHOUT ever falling back to the
   * authorize popup — there is no user gesture on this path. invalid_grant clears
   * the persisted session and STOPS scheduling; transient/network failure retries
   * with bounded backoff.
   */
  async #fireProactive(issuer: URL): Promise<void> {
    const scheduler = this.#schedulers.get(issuer.href);
    if (scheduler === undefined || this.#destroyed) return;
    // Hidden again between arming and firing: defer to the resume listener.
    if (!this.#visibility.isVisible()) {
      scheduler.timer = undefined;
      return;
    }
    // EPOCH FENCE (the #123 whole-branch HIGH #1): capture the issuer epoch at the START of the
    // proactive cycle — before reading `#settledSessions` / joining in-flight work / the grant —
    // and thread it into `#begin` so the proactive COMMIT yields if a `forgetIssuer` (logout) or a
    // SUPERSEDING login bumped the epoch in the meantime. Without this, an OLD account's proactive
    // refresh (which `#begin` would otherwise re-capture the epoch for AFTER the bump) could finish
    // AFTER the new login committed and OVERWRITE the caches/persistence with the old credential.
    const fenced = this.#fenceFor(issuer.href);

    // The session we mean to refresh — the last settled one, captured up front
    // so we can tell a steady-state cache hit (refresh it) from a NEWER renewal
    // that landed while we waited (join it; don't double-refresh).
    const current = this.#settledSessions.get(issuer.href);
    if (current === undefined || current.refreshToken === undefined) {
      this.#clearScheduler(issuer.href);
      return;
    }

    // Single-flight: in steady state `#sessions` holds the promise that settled
    // to `current` — that is just the cache, and we go on to refresh it. But if
    // a DIFFERENT renewal is in flight (a lazy upgrade()→#renew, a restore, …),
    // join it rather than stampeding a second grant; when it settles to a newer
    // fresh session the cycle is satisfied (its own #begin rescheduled).
    const inFlight = this.#sessions.get(issuer.href);
    if (inFlight !== undefined) {
      const joined = await inFlight.catch(() => undefined);
      if (joined !== undefined && joined !== current && !hasExpired(joined)) {
        return;
      }
    }
    // A renewal may have started (and not yet settled) while we awaited above —
    // don't clobber it; let it own the cycle (it reschedules on settle).
    if (this.#sessions.get(issuer.href) !== inFlight) return;

    try {
      // Publish our refresh-token grant into the single-flight cache so a
      // concurrent upgrade() shares it; #begin reschedules + re-persists the
      // rotated token on success. The `fenced` predicate (captured at this cycle's
      // START) gates the commit, so a login/logout that bumped the epoch mid-cycle
      // makes this proactive commit yield rather than overwrite/resurrect.
      await this.#begin(
        issuer,
        this.#refresh(issuer, current, current.refreshToken),
        fenced,
      );
      // #begin's success path already rescheduled via #scheduleProactive.
    } catch (e) {
      await this.#handleProactiveFailure(issuer, e);
    }
  }

  /**
   * Classify a failed proactive refresh:
   *  - `invalid_grant` (refresh token dead/revoked): clear the persisted session
   *    and STOP scheduling for this issuer. No popup — the next user-initiated
   *    action falls back to the existing interactive path.
   *  - transient/network: retry with bounded exponential backoff, still no popup.
   *    After the budget is spent, stop scheduling (the lazy path will recover on
   *    the next real request).
   */
  async #handleProactiveFailure(issuer: URL, error: unknown): Promise<void> {
    const scheduler = this.#schedulers.get(issuer.href);
    if (scheduler === undefined || this.#destroyed) return;

    if (isInvalidGrant(error)) {
      this.#clearScheduler(issuer.href);
      this.#settledSessions.delete(issuer.href);
      this.#sessions.delete(issuer.href);
      await this.#clearPersisted(issuer);
      return;
    }

    // Transient: retry with backoff, bounded, never a popup.
    if (scheduler.retries >= PROACTIVE_MAX_RETRIES) {
      this.#clearScheduler(issuer.href);
      return;
    }
    const attempt = ++scheduler.retries;
    const backoff = PROACTIVE_RETRY_BASE_MS * 2 ** (attempt - 1);
    if (!this.#visibility.isVisible()) {
      // Don't burn retries in the background; resume re-evaluates.
      scheduler.timer = undefined;
      return;
    }
    scheduler.timer = this.#setTimeout(() => {
      scheduler.timer = undefined;
      void this.#fireProactive(issuer);
    }, backoff);
  }

  /** Subscribe the shared visibility/focus listeners once (first scheduler). */
  #ensureVisibilitySubscribed(): void {
    if (this.#visibilityUnsub !== undefined) return;
    const onResume = this.#onResume.bind(this);
    const onHide = this.#onHide.bind(this);
    const unsubResume = this.#visibility.onResume(onResume);
    const unsubHide = this.#visibility.onHide(onHide);
    this.#visibilityUnsub = () => {
      unsubResume();
      unsubHide();
    };
  }

  /**
   * The tab became visible / window regained focus. Timers may have been
   * throttled or dropped while hidden (or during OS sleep), so we ALWAYS
   * re-evaluate expiry rather than trust a timer fired: for each issuer, if the
   * token is already within the refresh window (or expired), refresh now; else
   * re-arm a fresh timer to its scheduled instant.
   */
  #onResume(): void {
    if (this.#destroyed) return;
    const now = Date.now();
    for (const [href, scheduler] of this.#schedulers) {
      const session = this.#settledSessions.get(href);
      if (session === undefined || session.refreshToken === undefined) {
        this.#clearScheduler(href);
        continue;
      }
      const fireAt = scheduler.fireAt ?? proactiveRefreshAt(session, now);
      const issuer = new URL(href);
      if (scheduler.timer !== undefined) {
        this.#clearTimeout(scheduler.timer);
        scheduler.timer = undefined;
      }
      if (fireAt === undefined || now >= fireAt) {
        // Within (or past) the refresh window: refresh immediately.
        void this.#fireProactive(issuer);
      } else {
        this.#armTimer(issuer, scheduler, fireAt);
      }
    }
  }

  /** The tab became hidden: stop firing timers (re-armed on resume). */
  #onHide(): void {
    for (const scheduler of this.#schedulers.values()) {
      if (scheduler.timer !== undefined) {
        this.#clearTimeout(scheduler.timer);
        scheduler.timer = undefined;
      }
    }
  }

  /** Clear and forget the scheduler for one issuer (timer + bookkeeping). */
  #clearScheduler(href: string): void {
    const scheduler = this.#schedulers.get(href);
    if (scheduler?.timer !== undefined) this.#clearTimeout(scheduler.timer);
    this.#schedulers.delete(href);
    if (this.#schedulers.size === 0) {
      this.#visibilityUnsub?.();
      this.#visibilityUnsub = undefined;
    }
  }

  /**
   * Stop proactively refreshing one issuer (e.g. explicit logout). Clears its
   * timer + bookkeeping; the visibility listeners are released once the last
   * scheduler is gone. Does NOT touch the persisted session — logout clears that
   * separately via {@link forgetPersisted}.
   */
  stopProactiveRefresh(issuer: URL): void {
    this.#clearScheduler(issuer.href);
  }

  /**
   * Provider teardown: stop ALL proactive scheduling and release the shared
   * visibility listeners. Idempotent. Call on unmount so no interval/listener
   * leaks (and no token churn) after the provider is discarded.
   */
  teardown(): void {
    this.#destroyed = true;
    for (const scheduler of this.#schedulers.values()) {
      if (scheduler.timer !== undefined) this.#clearTimeout(scheduler.timer);
    }
    this.#schedulers.clear();
    this.#visibilityUnsub?.();
    this.#visibilityUnsub = undefined;
  }

  /**
   * Persist (or update) the durable session for this issuer: the ROTATED refresh
   * token + the DPoP key. Persists ONLY when a refresh token exists and a WebID
   * is known (an issuer-first login with no `webid` claim cannot be restored by
   * WebID, so there is nothing useful to store). The ACCESS TOKEN is never
   * written — only the long-lived, key-bound credential. No-op without a store.
   */
  async #persist(issuer: URL, session: IssuerSession): Promise<void> {
    if (this.#sessionStore === undefined) return;
    if (session.refreshToken === undefined || session.webId === undefined) return;
    try {
      await this.#sessionStore.put({
        issuer: issuer.href,
        webId: session.webId,
        refreshToken: session.refreshToken,
        dpopKey: session.dpopKey,
        clientId: this.#clientId,
        expiresAt: session.expiresAt,
      });
    } catch {
      // Best-effort durability: a quota/transaction error degrades to the
      // in-memory-only behaviour (a later return visit re-prompts), never a
      // failed login. Deliberately not logged (would touch the refresh token).
    }
  }

  /** Drop the durable session for this issuer (logout / dead refresh token). */
  async #clearPersisted(issuer: URL): Promise<void> {
    if (this.#sessionStore === undefined) return;
    try {
      await this.#sessionStore.delete(issuer.href);
    } catch {
      // Non-fatal: a stale entry is harmless (its refresh token is DPoP-bound,
      // and a failed restore re-clears it).
    }
  }

  /**
   * RESTORE a returning user's session for a KNOWN issuer from the durable store
   * via a `refresh_token` grant — the whole point of this module: a
   * token-endpoint FETCH, never a window/iframe. Call on page load once the
   * issuer is known (the app reads it from the persisted recent-account record).
   *
   * Returns the authenticated WebID on success (the in-memory session is now
   * populated, so subsequent 401 upgrades and the synchronous popup-avoidance
   * probe work without any further interaction), or `undefined` when there is
   * nothing to restore OR the persisted refresh token is dead — in which case
   * the persisted entry is CLEARED and the caller falls back to its existing
   * behaviour (no popup on restore; interactive popup only on an explicit click).
   *
   * Pins the provider's issuer on success, exactly like {@link login}, so a
   * later 401 reuses the restored session without prompting for a WebID.
   *
   * SUPERSESSION-SAFE PIN (the #123 roborev HIGH): pinning `#issuer` is a
   * provider-WIDE mutation — `upgrade()` reads it to pick whose session to attach.
   * On a boot silent restore that RACES a newer interactive login (account switch),
   * a late-resolving restore could re-pin the provider to the OLD account AFTER the
   * new login pinned the new one, so the next `upgrade()` would attach the OLD
   * session. The caller therefore passes `shouldPin` — a generation re-check
   * evaluated AT the pin point: when it returns false (the restore was superseded),
   * the rebuilt session is still cached (harmless — keyed by issuer href) but the
   * provider-wide `#issuer` pin is SKIPPED, so the newer login's pin stands. Default
   * (always pin) preserves the normal restore/login behaviour.
   *
   * APP-SPECIFIC divergence (strong upstream candidate — see the module docs):
   * upstream reactive-authentication's DPoPTokenProvider holds its refresh token
   * in memory only, so a reload re-runs the authorization-code flow (the
   * prompt=none probe that flashes a window). Persisting the DPoP-bound refresh
   * token + non-extractable key and restoring via the refresh grant removes that
   * flash. Equivalent library change described in the task report.
   */
  async restoreIssuer(
    issuer: URL,
    stillCurrent: () => boolean = () => true,
  ): Promise<{ webId: string } | undefined> {
    if (this.#sessionStore === undefined) return undefined;

    // EPOCH FENCE (the #123 whole-branch HIGHs): capture the issuer epoch at the START of the
    // restore (before the store read + the refresh grant), and AND it into `stillCurrent` for
    // every downstream commit/delete. A `forgetIssuer` (logout) OR a superseding login bumps the
    // epoch, so a late-finishing boot restore can neither resurrect a forgotten issuer nor
    // overwrite a newer login's credential.
    const fenced = this.#fenceFor(issuer.href, stillCurrent);

    let stored: PersistedSession | undefined;
    try {
      stored = await this.#sessionStore.get(issuer.href);
    } catch {
      return undefined;
    }
    if (stored === undefined) return undefined;

    // Run the refresh grant WITHOUT committing to the provider-wide caches yet — the commit
    // is fenced below so a SUPERSEDED boot restore (a newer login won the race, possibly on
    // the SAME issuer) can never replace the issuer-keyed session/settled caches, re-pin
    // `#issuer`, re-persist, or re-schedule on behalf of the stale account. Just running
    // `#restore` mutates nothing provider-wide (it only builds a fresh session object).
    //
    // TRADEOFF vs the old `#begin` path: `#begin` registered the in-flight restore in
    // `#sessions` so a concurrent same-issuer `upgrade()` would JOIN it (dedup). We
    // deliberately do NOT register in-flight here — a concurrent `upgrade()` runs its own
    // auth — because registering shared in-flight work for a possibly-superseded restore is
    // itself the cross-account-join leak this fence closes. During a boot silent restore that
    // is the safe direction (correctness over one deduped refresh).
    let session: IssuerSession;
    try {
      session = await this.#restore(issuer, stored);
    } catch {
      // The refresh token was expired/revoked (token endpoint invalid_grant) or the restore
      // otherwise failed: clear the DEAD entry and report "nothing restored" (no popup).
      //
      // SUPERSESSION-SAFE DELETE (the #123 roborev HIGH): a stale boot restore that FAILS must
      // NOT delete a NEWER same-issuer login's freshly-persisted credential. Delete ONLY when
      // this restore is still current AND not epoch-cancelled, and use the ATOMIC
      // `compareAndDelete` (one transaction) so the read-compare-delete is indivisible — a newer
      // login persisting BETWEEN a plain get and delete can never be wiped. The scheduler is
      // cleared separately (it is in-memory).
      if (fenced()) {
        this.#clearScheduler(issuer.href);
        await this.#sessionStore
          ?.compareAndDelete(issuer.href, stored.refreshToken)
          .catch(() => false);
      }
      return undefined;
    }

    // FENCE (the #123 roborev HIGH): commit the restored session to the provider-wide state
    // ONLY if this restore is still current AND not epoch-cancelled. A superseded/cancelled
    // restore returns the WebID (so the boot path knows what WOULD have restored) but commits
    // NOTHING in-memory — the newer login owns the issuer-keyed caches, the `#issuer` pin, and
    // the refresh scheduler.
    if (!fenced()) {
      // The refresh grant ALREADY CONSUMED + ROTATED the stored refresh token (#restore ran),
      // so the OLD `stored.refreshToken` left in the store is now DEAD — a later restore with it
      // would invalid_grant (the #123 roborev MEDIUM). ATOMICALLY compare-and-delete it (so a
      // newer same-issuer login that re-persisted a fresh token in the meantime is never wiped).
      // We do NOT write the rotated token (the newer login owns the durable slot); dropping the
      // dead one is the fail-closed choice (the user re-authenticates with one click).
      await this.#sessionStore
        ?.compareAndDelete(issuer.href, stored.refreshToken)
        .catch(() => false);
      return session.webId === undefined ? undefined : { webId: session.webId };
    }
    // ATOMIC-W.R.T.-SUPERSESSION commit (shared with `#begin`): installs caches + (optionally)
    // the pin, awaits persist, then re-checks the fence AFTER the awaited persist and rolls
    // the whole commit back (compare-and-swap) if a logout / newer login won during persist.
    await this.#commitSession(issuer, session, fenced, { pin: true });
    return session.webId === undefined ? undefined : { webId: session.webId };
  }

  /** The current epoch for an issuer (0 when none has been recorded). */
  #epochOf(href: string): number {
    return this.#issuerEpoch.get(href) ?? 0;
  }

  /**
   * BUMP an issuer's epoch — the cancellation primitive. Every commit-producing path that was
   * already in flight captured the PRIOR epoch (via {@link #fenceFor}); bumping makes ALL of them
   * stale at their next fence re-check, so none can publish/persist for this issuer after the
   * bump. Called by {@link forgetIssuer} (logout/cancel) and by a SUPERSEDING fresh login, in both
   * cases BEFORE the new actor captures its own (now-newer) epoch. Returns the new epoch.
   */
  #bumpEpoch(href: string): number {
    const next = this.#epochOf(href) + 1;
    this.#issuerEpoch.set(href, next);
    return next;
  }

  /**
   * Build the COMBINED freshness predicate for a commit-producing path: capture the issuer's
   * CURRENT epoch now, and return a predicate that is true only when BOTH the caller's own
   * `stillCurrent` (the generation+WebID fence) holds AND the epoch has not since been bumped
   * (by a `forgetIssuer` or a superseding login). Threaded into `#commitSession`/`#commitSessionInner`
   * and the in-flight roll-back checks, so every `#sessions`/`#settledSessions`/`#issuer`/persist
   * write is gated on it — a single fence unifying supersession AND issuer-epoch cancellation.
   */
  #fenceFor(href: string, stillCurrent: () => boolean = () => true): () => boolean {
    const captured = this.#epochOf(href);
    return () => stillCurrent() && this.#epochOf(href) === captured;
  }

  /**
   * Commit a freshly-established/restored session to the provider-wide state ATOMICALLY w.r.t.
   * supersession (the #123 roborev HIGH). PUBLISH-LAST: the durable persist runs FIRST, THEN
   * `stillCurrent()` is re-checked, and ONLY THEN are the reusable provider-wide caches
   * (`#sessions`/`#settledSessions`), the `#issuer` pin, and the proactive scheduler installed.
   * Nothing reusable is exposed before the post-persist fence, so a newer same-issuer login (via
   * `#getSession(..., forLogin)` / `canRenewWithoutInteraction`) can NEVER observe and reuse a
   * not-yet-final stale session (closes the premature-publication leak). On a post-persist
   * supersession it commits NOTHING in-memory and compare-and-deletes the just-persisted refresh
   * token INDEPENDENTLY of any in-memory ownership (so a stale persist finishing last cannot
   * leave its token behind). Shared by `#begin` (login/renew) and `restoreIssuer`.
   */
  async #commitSession(
    issuer: URL,
    session: IssuerSession,
    stillCurrent: () => boolean,
    opts: { pin: boolean },
  ): Promise<boolean> {
    // SERIALISE per-issuer commits (the #123 roborev MEDIUM): chain onto any in-flight commit
    // for this issuer so two concurrent same-issuer establishes never interleave their durable
    // put/compare-and-delete. Different issuers run concurrently (the chain is per-issuer.href).
    const prior = this.#commitChains.get(issuer.href) ?? Promise.resolve();
    const run = prior
      .catch(() => undefined) // a prior commit's failure must not block the next
      .then(() => this.#commitSessionInner(issuer, session, stillCurrent, opts));
    this.#commitChains.set(issuer.href, run);
    try {
      return await run;
    } finally {
      // Clear the chain entry once it is the tail (compare-and-swap), so the map doesn't grow.
      if (this.#commitChains.get(issuer.href) === run) {
        this.#commitChains.delete(issuer.href);
      }
    }
  }

  async #commitSessionInner(
    issuer: URL,
    session: IssuerSession,
    stillCurrent: () => boolean,
    opts: { pin: boolean },
  ): Promise<boolean> {
    // PRE-PERSIST FENCE (the #123 roborev HIGH): by the time this runs it has WAITED on the
    // per-issuer commit chain, so a NEWER same-issuer commit may already have landed. If we are
    // no longer current, return WITHOUT persisting at all — never write our (now stale) token
    // over the newer credential. (Our refresh grant did consume+rotate the prior stored token,
    // but the newer login re-persisted its own; the fail-closed choice is to leave the newer
    // credential untouched rather than risk clobbering it. The token WE consumed is dead and
    // already replaced by the newer login's record, so there is nothing of ours to clean up.)
    if (!stillCurrent()) return false;
    // PERSIST (before exposing anything reusable in memory). The store's own errors are swallowed
    // inside #persist (a storage failure degrades to in-memory-only).
    await this.#persist(issuer, session);
    if (!stillCurrent()) {
      // SUPERSEDED during persist — publish NOTHING in-memory. ATOMIC compare-and-delete the
      // just-persisted token by refresh-token equality (one transaction), INDEPENDENT of any
      // in-memory cache ownership — so a stale persist that finished last cannot leave its
      // credential behind, and a newer login persisting concurrently is never wiped (the #123
      // roborev HIGH — the non-atomic get-then-delete race).
      await this.#sessionStore
        ?.compareAndDelete(issuer.href, session.refreshToken ?? "")
        .catch(() => false);
      return false; // not committed — the caller evicts any in-flight cache entry it set.
    }
    // STILL CURRENT after persist → publish the reusable caches, the pin, and the scheduler.
    this.#sessions.set(issuer.href, Promise.resolve(session));
    this.#settledSessions.set(issuer.href, session);
    if (opts.pin) this.#issuer = Promise.resolve(issuer);
    this.#scheduleProactive(issuer, session);
    return true;
  }

  /**
   * Rebuild an {@link IssuerSession} from a {@link PersistedSession}: discover
   * the AS, reconstruct the DPoP handle around the PERSISTED key (key continuity
   * — the same non-extractable key that minted the original token signs the
   * refresh proof, which is the whole point of DPoP sender-constraining), then
   * run the refresh grant. Throws on a dead refresh token so restoreIssuer()
   * clears it.
   */
  async #restore(
    issuer: URL,
    stored: PersistedSession,
  ): Promise<IssuerSession> {
    const http = this.#httpOptions(issuer, this.#authSignal);

    const discoveryResponse = await oauth.discoveryRequest(issuer, http);
    const authorizationServer = await oauth.processDiscoveryResponse(
      issuer,
      discoveryResponse,
    );
    const clientRegistration = await this.#resolveClient(authorizationServer, http);

    // Reattach the PERSISTED, non-extractable DPoP key — the proof for the
    // refresh grant must be signed by the key the token is bound to.
    const dpopHandle = oauth.DPoP({}, stored.dpopKey);

    // A bare in-memory session shell; #refresh redeems the persisted refresh
    // token against it and returns the populated, rotated session.
    const shell: IssuerSession = {
      authorizationServer,
      clientRegistration,
      dpopKey: stored.dpopKey,
      dpopHandle,
      accessToken: "", // never persisted; minted by the refresh grant below
      refreshToken: stored.refreshToken,
      expiresAt: 0,
      webId: stored.webId,
    };
    return this.#refresh(issuer, shell, stored.refreshToken);
  }

  /**
   * Clear the durable session for an issuer (explicit logout). Public so the
   * React session bridge can wipe the persisted refresh token + key on sign-out.
   */
  async forgetPersisted(issuer: URL): Promise<void> {
    // Logout: stop refreshing this issuer (no leaked timer, no churn) AND drop
    // the durable credential so it is not silently revived on the next load.
    this.#clearScheduler(issuer.href);
    await this.#clearPersisted(issuer);
  }

  /**
   * FULLY discard an issuer's session — the IN-MEMORY caches (`#sessions` / `#settledSessions`),
   * the `#issuer` pin (only if it still points at this issuer), the proactive scheduler, AND the
   * durable persisted credential. Use this (not the persistence-only {@link forgetPersisted})
   * when a committed login must be DISCARDED so it can NEVER be reused from memory by the next
   * same-issuer login / `upgrade()` — i.e. a CANCELLED login (the user backed out) or a
   * still-current login that FAILED a fail-closed identity check after `provider.login()` already
   * committed the session (the #123 roborev HIGH). `#getSession(..., forLogin)` reads
   * `#settledSessions` and `upgrade()` reads `#issuer`, so leaving either behind would let a
   * cancelled/abandoned credential be silently reused.
   */
  async forgetIssuer(issuer: URL): Promise<void> {
    // EPOCH CANCELLATION (the #123 whole-branch HIGH #2): BUMP the issuer epoch BEFORE clearing
    // any state, so an in-flight `#commitSession` / proactive / lazy refresh that finishes AFTER
    // this forget (a pending commit carries the default always-current predicate) sees a stale
    // captured epoch and publishes/persists NOTHING — it can no longer RESURRECT the issuer we are
    // about to forget. The bump must precede the clears: a path that re-checks its fence between
    // the bump and the clears already sees the new epoch and yields.
    this.#bumpEpoch(issuer.href);
    this.#clearScheduler(issuer.href);
    this.#sessions.delete(issuer.href);
    this.#settledSessions.delete(issuer.href);
    // Unpin only if `#issuer` still resolves to THIS issuer — never wipe a newer login's pin.
    // COMPARE-AND-SWAP BY PROMISE REFERENCE (the #123 roborev MEDIUM): a newer login can replace
    // `#issuer` WHILE we await the old promise below, so we capture the exact promise first and
    // unpin only if `#issuer` is STILL that same promise after the await — otherwise the newer
    // login's pin stands.
    const pinPromise = this.#issuer;
    if (pinPromise !== undefined) {
      const pinned = await pinPromise.catch(() => undefined);
      if (pinned?.href === issuer.href && this.#issuer === pinPromise) {
        this.#issuer = undefined;
      }
    }
    await this.#clearPersisted(issuer);
  }

  /**
   * Prefer a transparent refresh-token grant; fall back to a new
   * authorization-code flow when there is no refresh token or the grant fails
   * (refresh-token expiry, revocation, rotation-reuse detection, …).
   */
  async #renew(
    issuer: URL,
    expired: IssuerSession,
    signal: AbortSignal,
    mode: AuthorizeMode = "silent-first",
    stillCurrent: () => boolean = () => true,
  ): Promise<IssuerSession> {
    if (expired.refreshToken === undefined) {
      // `stillCurrent` threaded so a superseded login's code-flow fallback never drives the
      // shared popup (the #123 roborev HIGH).
      return this.#authenticate(issuer, signal, mode, stillCurrent);
    }
    try {
      return await this.#refresh(issuer, expired, expired.refreshToken);
    } catch {
      // The grant was rejected (refresh-token expiry, revocation, rotation
      // reuse, …): drop the dead token IN PLACE so the synchronous probe
      // (canRenewWithoutInteraction) stops promising a popup-free renewal on
      // the next click. On the background path the fallback stays silent
      // while the IdP cookie lives (prompt=none first); an explicit login
      // goes interactive at once.
      expired.refreshToken = undefined;
      return this.#authenticate(issuer, signal, mode, stillCurrent);
    }
  }

  /**
   * The refresh-token grant (RFC 6749 §6), DPoP-bound with the session's
   * existing key/handle, adopting the rotated refresh token when the server
   * issues one. One retry on a server-required DPoP nonce.
   */
  async #refresh(
    issuer: URL,
    session: IssuerSession,
    refreshToken: string,
  ): Promise<IssuerSession> {
    const { authorizationServer, clientRegistration, dpopHandle } = session;
    const clientAuth = this.#clientAuth(authorizationServer.issuer, clientRegistration);
    const http = this.#httpOptions(issuer, this.#authSignal);

    const grant = () =>
      oauth.refreshTokenGrantRequest(
        authorizationServer,
        clientRegistration,
        clientAuth,
        refreshToken,
        { DPoP: dpopHandle, ...http },
      );

    let tokenResult: oauth.TokenEndpointResponse;
    try {
      tokenResult = await oauth.processRefreshTokenResponse(
        authorizationServer,
        clientRegistration,
        await grant(),
      );
    } catch (e) {
      if (!oauth.isDPoPNonceError(e)) throw e;
      // The handle captured the server's DPoP nonce from the error; retry once.
      tokenResult = await oauth.processRefreshTokenResponse(
        authorizationServer,
        clientRegistration,
        await grant(),
      );
    }

    return {
      ...session,
      accessToken: tokenResult.access_token,
      refreshToken: tokenResult.refresh_token ?? refreshToken,
      expiresAt: expiresAt(tokenResult),
    };
  }

  /**
   * The published DPoPTokenProvider flow, verbatim except for two changes
   * threaded through: the insecure-loopback option on every oauth4webapi call,
   * and a STATIC-vs-DYNAMIC client branch. Flow: discovery → client identity
   * (static Client Identifier Document when {@link WebIdDPoPTokenProviderOptions.clientId}
   * is set, else dynamic client registration) → PKCE/DPoP authorization-code
   * grant. In `"silent-first"` mode the `prompt=none` attempt + interactive
   * retry are preserved verbatim; in `"interactive"` mode (explicit login) the
   * first navigation IS the interactive request.
   */
  async #authenticate(
    issuer: URL,
    signal: AbortSignal,
    mode: AuthorizeMode = "silent-first",
    stillCurrent: () => boolean = () => true,
  ): Promise<IssuerSession> {
    const http = this.#httpOptions(issuer, signal);

    const discoveryResponse = await oauth.discoveryRequest(issuer, http);
    const authorizationServer = await oauth.processDiscoveryResponse(
      issuer,
      discoveryResponse,
    );

    const clientRegistration = await this.#resolveClient(
      authorizationServer,
      http,
    );

    const [registeredRedirectUri] = clientRegistration.redirect_uris as
      | string[]
      | undefined ?? [this.#callbackUri];
    const [registeredResponseType] = (clientRegistration.response_types as
      | string[]
      | undefined) ?? ["code"];

    const dpopKey = await oauth.generateKeyPair("ES256", { extractable: false });
    const dpop = oauth.DPoP({}, dpopKey);
    const codeVerifier = oauth.generateRandomCodeVerifier();
    const nonce = oauth.generateRandomNonce();
    const state = oauth.generateRandomState();

    // Opt in to refresh tokens where the server supports them (OIDC Core §11).
    // The static Client Identifier Document already declares offline_access +
    // the refresh_token grant; servers without support see the old request.
    const useOfflineAccess =
      authorizationServer.scopes_supported?.includes("offline_access") ?? false;

    const buildAuthorizationUrl = (withPrompt: boolean): URL => {
      const url = new URL(authorizationServer.authorization_endpoint as string);
      url.searchParams.set("client_id", clientRegistration.client_id);
      url.searchParams.set("redirect_uri", registeredRedirectUri);
      url.searchParams.set("response_type", registeredResponseType);
      url.searchParams.set(
        "scope",
        useOfflineAccess ? "openid webid offline_access" : "openid webid",
      );
      if (withPrompt) {
        url.searchParams.set("prompt", "none");
      } else if (useOfflineAccess) {
        // The interactive attempt must carry `prompt=consent` for the server to
        // honour `offline_access`: OIDC Core §11 says the AS MUST ignore the
        // scope otherwise, and oidc-provider (CSS, this broker) enforces that.
        url.searchParams.set("prompt", "consent");
      }
      url.searchParams.set("state", state);
      url.searchParams.set("nonce", nonce);
      if (authorizationServer.code_challenge_methods_supported !== undefined) {
        if (
          authorizationServer.code_challenge_methods_supported.includes("S256")
        ) {
          url.searchParams.set("code_challenge_method", "S256");
          // challenge set asynchronously below
        } else {
          url.searchParams.set("code_challenge_method", "plain");
          url.searchParams.set("code_challenge", codeVerifier);
        }
      }
      return url;
    };

    // PKCE challenge (async) computed once and reused across prompt/no-prompt URLs.
    const usePkce =
      authorizationServer.code_challenge_methods_supported !== undefined;
    const useS256 =
      usePkce &&
      authorizationServer.code_challenge_methods_supported!.includes("S256");
    const codeChallenge = useS256
      ? await oauth.calculatePKCECodeChallenge(codeVerifier)
      : codeVerifier;

    // Explicit logins go straight to the interactive URL; background re-auth
    // tries prompt=none first (see AuthorizeMode).
    const silentFirst = mode === "silent-first";
    const authorizationUrl = buildAuthorizationUrl(silentFirst);
    if (usePkce) authorizationUrl.searchParams.set("code_challenge", codeChallenge);

    // Run the interactive (no-`prompt=none`) authorization once, reusing the
    // same popup window. Shared by the two silent-fallthrough paths below.
    // STALE-LOGIN POPUP GUARD (the #123 roborev HIGH): `#getCode` drives the SHARED popup. A
    // login superseded / cancelled while this auth was in flight (discovery / client resolution
    // above) must NOT navigate or cancel the popup that now belongs to a NEWER login. Re-check
    // `stillCurrent` immediately before EVERY `#getCode` and reject if stale, so the stale login
    // never touches the shared window.
    const assertCurrent = (): void => {
      if (!stillCurrent()) {
        throw new DOMException("Login superseded", "AbortError");
      }
    };

    const interactiveRetry = async (): Promise<URLSearchParams> => {
      const retryUrl = buildAuthorizationUrl(false);
      if (usePkce) retryUrl.searchParams.set("code_challenge", codeChallenge);
      assertCurrent();
      const retryResponse = await this.#getCode(retryUrl, signal);
      return oauth.validateAuthResponse(
        authorizationServer,
        clientRegistration,
        new URL(retryResponse),
        state,
      );
    };

    let authorizationCodeParams: URLSearchParams;
    assertCurrent();
    const authorizationCodeResponse = await this.#getCode(authorizationUrl, signal);

    // Non-compliant servers (NSS — solidweb.org, datapod.igrant.io; Trinpod)
    // IGNORE `prompt=none`: instead of an OIDC error redirect back to our
    // callback (`?error=login_required`), they serve their HTML login page
    // with HTTP 200 and no OIDC parameter. The popup then lands on a page that
    // is NOT our callback, so the response carries neither `code` nor `error`.
    // `validateAuthResponse` would surface that as an opaque "missing response
    // parameter" error the classifier below never matches — so on the SILENT
    // path we detect it FIRST, by response SHAPE (not by hostname — any other
    // server that ignores prompt=none behaves the same), and treat it as an
    // IMPLICIT `interaction_required`: fall through to the interactive retry in
    // the same window instead of hanging or surfacing a raw error.
    //
    // Scoped to `silentFirst`: a GENUINE interactive login that lands on the
    // IdP's HTML is expected (the user types credentials there) and must NOT be
    // reclassified — that path runs with `mode === "interactive"`.
    if (silentFirst && isNonCallbackResponse(authorizationCodeResponse)) {
      authorizationCodeParams = await interactiveRetry();
    } else {
      try {
        authorizationCodeParams = oauth.validateAuthResponse(
          authorizationServer,
          clientRegistration,
          new URL(authorizationCodeResponse),
          state,
        );
      } catch (e) {
        if (
          silentFirst &&
          ((e instanceof oauth.AuthorizationResponseError &&
            (e.error === "interaction_required" ||
              e.error === "consent_required" ||
              e.error === "login_required")) ||
            isEssMissingIssInteractionNeeded(e))
        ) {
          // The IdP needs the user to interact: retry once without `prompt=none`.
          authorizationCodeParams = await interactiveRetry();
        } else {
          throw e;
        }
      }
    }

    const tokenResponse = await oauth.authorizationCodeGrantRequest(
      authorizationServer,
      clientRegistration,
      this.#clientAuth(authorizationServer.issuer, clientRegistration),
      authorizationCodeParams,
      this.#callbackUri,
      usePkce ? codeVerifier : oauth.nopkce,
      { DPoP: dpop, ...http },
    );
    const tokenResult = await oauth.processAuthorizationCodeResponse(
      authorizationServer,
      clientRegistration,
      tokenResponse,
      { expectedNonce: this.#nonceVerification(authorizationServer.issuer, nonce) },
    );

    return {
      authorizationServer,
      clientRegistration,
      dpopKey,
      dpopHandle: dpop,
      accessToken: tokenResult.access_token,
      refreshToken: tokenResult.refresh_token,
      expiresAt: expiresAt(tokenResult),
      webId: webIdFromIdToken(oauth.getValidatedIdTokenClaims(tokenResult)),
    };
  }

  /**
   * Resolve the OAuth client used for this issuer.
   *
   * - **Static (a Client Identifier Document):** when `clientId` is set, return a
   *   public {@link oauth.Client} whose `client_id` IS that URL, with
   *   `token_endpoint_auth_method: "none"`. No network call is made here — the OP
   *   dereferences the document itself at the authorization/token endpoints and
   *   matches the redirect_uri against the document's `redirect_uris`. The
   *   document must therefore list this provider's `callbackUri`. `redirect_uris`
   *   and `response_types` are seeded locally so the shared URL-building code
   *   below has the values it needs.
   * - **Dynamic (the default):** dynamic client registration, exactly as the
   *   published provider does — a throwaway client per session, no stable name.
   */
  async #resolveClient(
    authorizationServer: oauth.AuthorizationServer,
    http: { signal: AbortSignal; [oauth.allowInsecureRequests]?: true },
  ): Promise<oauth.Client> {
    if (this.#clientId !== undefined) {
      // A public browser client identified by a dereferenceable URL. `oauth.Client`
      // requires only `client_id`; the rest are accepted via its index signature
      // and consumed by the shared authorization-URL builder below.
      return {
        client_id: this.#clientId,
        token_endpoint_auth_method: "none",
        redirect_uris: [this.#callbackUri],
        response_types: ["code"],
      };
    }
    const registrationResponse = await oauth.dynamicClientRegistrationRequest(
      authorizationServer,
      {
        redirect_uris: [this.#callbackUri],
        // Register for refresh tokens where supported (mirrors the static
        // Client Identifier Document, which declares both grants).
        ...(authorizationServer.grant_types_supported?.includes("refresh_token")
          ? { grant_types: ["authorization_code", "refresh_token"] }
          : {}),
      },
      http,
    );
    return oauth.processDynamicClientRegistrationResponse(registrationResponse);
  }

  /** Client authentication, mirroring the published provider's ESS workaround. */
  #clientAuth(issuer: string, client: oauth.Client): oauth.ClientAuth {
    if (client.token_endpoint_auth_method === "client_secret_basic") {
      return clientSecretBasicFor(issuer)(client.client_secret as string);
    }
    return oauth.None();
  }

  /** Some servers (NSS/ESS variants) omit the nonce; expect none for them. */
  #nonceVerification(issuer: string, nonce: string): string | typeof oauth.expectNoNonce {
    if (issuer === "https://datapod.igrant.io" || issuer === "https://solidweb.org") {
      return oauth.expectNoNonce;
    }
    return nonce;
  }
}

/**
 * The authenticated WebID stated by the ID token: the `webid` claim
 * (Solid-OIDC §5), falling back to `sub` when it is an http(s) URL (the NSS
 * convention). `undefined` when the token states neither — issuer-first
 * logins then fail with clear copy rather than guessing.
 */
function webIdFromIdToken(
  claims: oauth.IDToken | undefined,
): string | undefined {
  if (claims === undefined) return undefined;
  const webid = claims.webid;
  if (typeof webid === "string" && /^https?:\/\//.test(webid)) return webid;
  if (/^https?:\/\//.test(claims.sub)) return claims.sub;
  return undefined;
}

/**
 * Whether a failed token-endpoint request was an OAuth `invalid_grant` — the
 * refresh token is dead (expired / revoked / rotation-reuse), so proactive
 * scheduling must STOP rather than retry. oauth4webapi surfaces this as a
 * `ResponseBodyError` whose `.error` is `"invalid_grant"`; we also probe the
 * nested `cause.parameters` shape some paths carry. Anything else is treated as
 * transient (network, 5xx, …) and retried with backoff.
 */
function isInvalidGrant(e: unknown): boolean {
  if (e instanceof oauth.ResponseBodyError && e.error === "invalid_grant") {
    return true;
  }
  try {
    return (
      (e as { error?: unknown }).error === "invalid_grant" ||
      (e as { cause: { parameters: URLSearchParams } }).cause.parameters.get(
        "error",
      ) === "invalid_grant"
    );
  } catch {
    return false;
  }
}

/**
 * Whether a `getCode` result is NOT a usable OIDC authorization response — the
 * popup landed somewhere OTHER than our callback redirect. True when the string
 * does not parse as a URL, or parses to a URL carrying neither a `code` nor an
 * `error` query parameter (an authorization response MUST carry one or the
 * other; RFC 6749 §4.1.2 / §4.1.2.1). This is the SHAPE of a server ignoring
 * `prompt=none` and serving its HTML login page (NSS, Trinpod) — detected
 * server-agnostically, never by hostname. Used ONLY on the silent path, to
 * reclassify such a landing as an implicit `interaction_required`.
 */
function isNonCallbackResponse(response: string): boolean {
  let url: URL;
  try {
    url = new URL(response);
  } catch {
    return true;
  }
  return (
    !url.searchParams.has("code") &&
    !url.searchParams.has("error") &&
    !new URLSearchParams(url.hash.replace(/^#/, "")).has("code") &&
    !new URLSearchParams(url.hash.replace(/^#/, "")).has("error")
  );
}

function isEssMissingIssInteractionNeeded(e: unknown): boolean {
  try {
    return (
      (e as { cause: { parameters: URLSearchParams } }).cause.parameters.get(
        "error",
      ) === "interaction_required"
    );
  } catch {
    return false;
  }
}

/**
 * A variant of oauth4webapi's ClientSecretBasic that does NOT url-encode id and
 * secret — PodSpaces (ESS) fails when the spec is followed.
 * @see https://www.rfc-editor.org/rfc/rfc6749.html#section-2.3.1
 */
function noUrlEncodeClientSecretBasic(clientSecret: string): oauth.ClientAuth {
  return (_as, client, _body, headers) => {
    headers.set(
      "Authorization",
      `Basic ${btoa(`${client.client_id}:${clientSecret}`)}`,
    );
  };
}

function clientSecretBasicFor(issuer: string): (secret: string) => oauth.ClientAuth {
  if (issuer.includes("login.inrupt.com")) return noUrlEncodeClientSecretBasic;
  return oauth.ClientSecretBasic;
}
