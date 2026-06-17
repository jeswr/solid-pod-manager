// AUTHORED-BY Claude Opus 4.8
/**
 * The PROACTIVE-ATTACH authenticated `fetch` — the fix for the per-resource "401
 * dance" (Pod Manager #123 Phase 1).
 *
 * BEFORE: the Pod Manager patched the global `fetch` with
 * `@solid/reactive-authentication`'s `ReactiveFetchManager`, which sends EVERY request
 * UNAUTHENTICATED first and only attaches the DPoP token REACTIVELY on a 401 — per
 * resource, with no origin/storage memory. So every distinct resource URL paid a wasted
 * `unauthenticated → 401 → upgrade → retry` round-trip; the 401 count scaled with the
 * number of resources touched (≈ child count when browsing a big container).
 *
 * AFTER: this wrapper attaches the token PROACTIVELY on the FIRST request to an ALLOWED
 * origin (no wasted unauthenticated probe), and does exactly ONE bounded 401 re-upgrade
 * if that proactively-attached token is rejected — distinguishing an RFC 9449 §8
 * `use_dpop_nonce` challenge (re-use the still-valid token with the now-cached nonce)
 * from a genuinely-stale token (force a refresh via `provider.invalidate`). A request to
 * a NON-allowed origin (or with no live session) is left UNAUTHENTICATED — the
 * foreign-origin credential boundary.
 *
 * It is modelled on the `@jeswr/solid-elements` auth seam's controller-owned
 * `#authenticatedFetchOver` (pinned sha df0fbe4) and reuses that seam's audited origin
 * boundary (`auth-origin-boundary.ts`, vendored verbatim). It does NOT chain through the
 * live (possibly already-patched) `globalThis.fetch`: it is anchored on an explicit
 * KNOWN-PRISTINE `baseFetch` (the `native-fetch.ts` snapshot), so the authenticated path
 * can never pick up another patcher's global and apply the wrong credentials.
 *
 * The token provider is the Pod Manager's EXISTING {@link AuthTokenProvider}
 * (`WebIdDPoPTokenProvider`) — kept intact (it owns the issuer-session cache, proactive
 * refresh, refresh-grant restore, popup login). This wrapper only changes WHEN/over-WHICH
 * fetch the provider's `upgrade()` runs; the provider's credential logic is unchanged.
 */
import {
  computeAllowedOrigins,
  isOriginAllowed,
  type AllowedOriginsInputs,
} from "./auth-origin-boundary.js";

export { computeAllowedOrigins, type AllowedOriginsInputs };

/**
 * The reactive-auth `TokenProvider` structural contract (matches/upgrade), plus the
 * optional `invalidate` (upstream PR #14) for the stale-token retry. This is exactly the
 * shape the Pod Manager's `WebIdDPoPTokenProvider` implements.
 *
 * `upgrade` MAY accept a second `forceRefresh` argument: when true the provider must
 * re-grant the access token rather than reuse a cached one (the stale-token retry path).
 * `WebIdDPoPTokenProvider.upgrade(request)` ignores extra args, and we drive the
 * force-refresh through `invalidate` regardless, so the call is safe either way.
 */
export interface AuthTokenProvider {
  matches(request: Request): Promise<boolean>;
  upgrade(request: Request, forceRefresh?: boolean): Promise<Request>;
  invalidate?(request: Request): Promise<void>;
}

/**
 * Whether a request is the token provider's OWN OAuth-infrastructure call (discovery /
 * token / refresh), which the proactive wrapper must NOT touch — SCOPED to the ISSUER
 * origins. When a pod is served from its IdP's origin (the common CSS topology), the issuer
 * origin is also a resource origin, so without this guard a provider-internal OAuth request
 * (made via `oauth4webapi` over the patched global fetch) would be routed through the
 * wrapper, which would call `provider.upgrade()` on it: OVERWRITING oauth4webapi's own
 * client-auth `Authorization` / DPoP-proof `DPoP` headers, and potentially RECURSING (a
 * token-endpoint request triggering another upgrade→refresh-grant→another token request …).
 * The roborev finding.
 *
 * Scoping to the issuer origins is the first precision gate; a request elsewhere is never
 * provider-internal (so a resource write to the pod keeps the full auth path). On an issuer
 * origin, a request is treated as OAuth infrastructure ONLY when it ALSO looks like an OAuth
 * call — either (a) it carries a `DPoP` PROOF header (oauth4webapi stamps a DPoP proof on
 * every token/refresh request, and a Solid RESOURCE request routed through this wrapper
 * never pre-sets one — the wrapper is what adds it), or (b) its path is a well-known OIDC
 * mount (`/.well-known/…`, `/.oidc/…`, covering the header-less discovery GET).
 *
 * We deliberately do NOT key off `Authorization` alone: on a SHARED CSS origin (pod + IdP),
 * a caller that pre-authed a pod resource request with its own `Authorization` would then be
 * wrongly bypassed and lose the stale-token retry (the roborev finding). The `DPoP`-proof
 * signal is specific to the provider's own OAuth calls. Fail-safe regardless: a false
 * positive merely leaves a request unauthenticated, which an OAuth endpoint never needs.
 */
export function isProviderOAuthRequest(
  request: Request,
  issuerOrigins: ReadonlySet<string>,
): boolean {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  // Only the issuer's own origins host OAuth infrastructure — a request elsewhere is never
  // treated as provider-internal (so resource writes keep the full auth path).
  if (!issuerOrigins.has(url.origin)) return false;
  if (request.headers.has("dpop")) return true; // oauth4webapi's token/refresh DPoP proof
  const path = url.pathname.toLowerCase();
  return path.startsWith("/.well-known/") || path.startsWith("/.oidc/");
}

/** What origins the live session's token may be attached to + the boundary inputs. */
export interface ProactiveAuthFetchOptions {
  /** The Pod Manager's token provider (kept intact; this wrapper drives its `upgrade`). */
  provider: AuthTokenProvider;
  /**
   * A function returning the CURRENT allowed-origin set. Read FRESH per request so a
   * post-login storage/WebID change (the allowed origins are derived from the active
   * profile) takes effect without re-installing the wrapper. An EMPTY set fail-closes:
   * the token is attached to nothing.
   */
  allowedOrigins: () => ReadonlySet<string>;
  /**
   * A function returning the CURRENT issuer origin(s) — the origins that host the OAuth
   * infrastructure (discovery / token / refresh). Read FRESH per request. Used to SCOPE the
   * provider-internal-OAuth bypass (`isProviderOAuthRequest`) so it only excludes OAuth
   * calls to the issuer, never a Solid resource write that happens to carry an auth header.
   * Empty when logged out (nothing is treated as OAuth infrastructure).
   */
  issuerOrigins: () => ReadonlySet<string>;
  /**
   * The KNOWN-PRISTINE base fetch (captured before any patching — see `native-fetch.ts`).
   * The authenticated path runs over THIS, never the live global.
   */
  baseFetch: typeof fetch;
  /**
   * A SESSION-LIVENESS gate: returns true only when the provider can attach a token to
   * this request WITHOUT any user interaction (a live access token, or a refresh token
   * that renews via a plain fetch). Read FRESH per request.
   *
   * This MUST be supplied because `WebIdDPoPTokenProvider.matches()` always returns true
   * (it was the reactive manager's "is this my provider" check, NOT a liveness check). If
   * we proactively `upgrade()` whenever `matches()` is true, a PASSIVE read (e.g. the
   * on-load silent restore's profile fetch) for an account whose refresh token is DEAD
   * would start the INTERACTIVE code flow from a background fetch — popping a window
   * during restore, breaking the fail-closed silent-restore invariant (the roborev
   * finding). Gating on non-interactive renewability keeps a passive read UNAUTHENTICATED
   * when the only way to get a token would be a popup; an EXPLICIT login flow (which has a
   * fresh session) passes the gate and is proactively authenticated.
   *
   * When omitted, the wrapper falls back to `provider.matches()` (the bare structural
   * contract) — correct only for a provider whose `matches` IS a liveness check.
   */
  canAttachNonInteractively?: (request: Request) => boolean;
}

/**
 * The proactive-attach authenticated fetch implementation, run over the explicit
 * pristine `baseFetch`. Returned as a stable `typeof fetch` so it can be assigned to
 * `globalThis.fetch`.
 */
export function makeProactiveAuthFetch(options: ProactiveAuthFetchOptions): typeof fetch {
  const { provider, allowedOrigins, issuerOrigins, baseFetch, canAttachNonInteractively } =
    options;

  const authFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input as RequestInfo, init);

    // The per-request credential gate — FOUR conditions, all required:
    //   1. `isOriginAllowed` — the foreign-origin boundary (token never leaves own pod);
    //   2. NOT a provider-internal OAuth request (`isProviderOAuthRequest`) — see below;
    //   3. the SESSION-LIVENESS gate (`canAttachNonInteractively`, falling back to
    //      `provider.matches`) — only attach when we can do so WITHOUT a popup, so a
    //      passive read never starts the interactive code flow (the roborev finding);
    //   4. `provider.matches` — the provider's own structural "this is mine" check.
    // A non-allowed origin / an OAuth request / a non-renewable session leaves the request
    // UNAUTHENTICATED.
    const liveAndRenewable = canAttachNonInteractively
      ? canAttachNonInteractively(request)
      : true;
    if (
      isOriginAllowed(allowedOrigins(), request.url) &&
      !isProviderOAuthRequest(request, issuerOrigins()) &&
      liveAndRenewable &&
      (await provider.matches(request))
    ) {
      // Capture a REPLAY SOURCE for the (at most one) 401 retry, but DEFENSIVELY: a 401
      // retry must re-send the body, and a PUT/PATCH/POST stream is single-use once
      // fetched — but `request.clone()` on a streaming/unusual body can tee or throw and
      // would break an otherwise-valid upload. So we clone ONLY when there is a body to
      // replay, and swallow a clone failure (retrySource stays undefined → no retry, the
      // original 401 is surfaced). A bodyless GET/HEAD needs no clone (the request itself
      // is replayable), so we keep the request as its own retry source. `clonedForRetry`
      // tracks whether retrySource is a CLONE we own (so its unread body must be cancelled
      // on the non-retry path — an un-cancelled clone tees the body and can buffer
      // indefinitely on large/streaming uploads; the roborev finding) vs the original
      // request (which the caller owns — never cancel it).
      let retrySource: Request | undefined;
      let clonedForRetry = false;
      if (request.body == null) {
        retrySource = request; // bodyless → safely replayable as-is (not our clone)
      } else {
        try {
          retrySource = request.clone();
          clonedForRetry = true;
        } catch {
          retrySource = undefined; // non-cloneable body → skip the retry path
        }
      }
      // Whether the retry clone was actually consumed by a retry. If it was NOT — including
      // when `upgrade`/`baseFetch`/`invalidate` THROWS partway — its tee'd body must be
      // cancelled so it can't buffer indefinitely (the roborev finding). `finally` covers
      // every exit, normal or exceptional.
      let retrySourceConsumed = false;
      try {
        // PROACTIVE attach: the provider stamps the DPoP-bound token on the FIRST
        // request — no wasted unauthenticated probe. This is what kills the dance.
        const upgraded = await provider.upgrade(request);
        const response = await baseFetch(upgraded);

        // If the proactively-attached token was REJECTED (401), retry ONCE (bounded —
        // never a loop), exactly as the prior `ReactiveFetchManager` did: mark the
        // attached credentials stale (`invalidate`) and re-`upgrade` (force-refresh) so the
        // retry re-grants the access token via the refresh-token flow. Only when we hold a
        // usable replay source (a bodyless request, or a successful clone).
        //
        // RFC 9449 §8 NOTE: a `use_dpop_nonce` 401 means the server wants the proof to
        // embed a `DPoP-Nonce` it just supplied. The Pod Manager's
        // `WebIdDPoPTokenProvider` does NOT yet embed resource-server DPoP nonces (it
        // passes no nonce to `generateProof`), so this wrapper cannot satisfy a strict-
        // nonce server by itself — neither could the old manager. We retry-once on ANY
        // post-upgrade 401 (no worse than before; a refreshed token can carry a server-
        // bound nonce on some servers). A genuine fix is to teach the provider to capture
        // the `DPoP-Nonce` header and embed it in the next proof, gated on
        // `isUseDpopNonceChallenge` (kept exported + tested for that path). Tracked.
        if (
          response.status === 401 &&
          provider.invalidate !== undefined &&
          retrySource !== undefined
        ) {
          // Release the discarded response body so the connection can be reused.
          await response.body?.cancel().catch(() => undefined);
          await provider.invalidate(upgraded);
          const retried = await provider.upgrade(retrySource, true);
          retrySourceConsumed = true; // the clone's body is now owned by the retry request
          return await baseFetch(retried);
        }
        return response;
      } finally {
        // Cancel the UNUSED clone's tee'd body on EVERY non-retry exit (success, a 401 we
        // can't replay, OR a throw) so it can't buffer. Only our own clone, never the
        // caller-owned original request.
        if (clonedForRetry && !retrySourceConsumed) {
          void retrySource?.body?.cancel().catch(() => undefined);
        }
      }
    }

    // No session / not an allowed origin → unauthenticated (public) request over the
    // pristine fetch.
    return baseFetch(request);
  };

  return authFetch as typeof fetch;
}

/**
 * Install {@link makeProactiveAuthFetch} as `globalThis.fetch`, returning an `uninstall`
 * that restores the previous global. The wrapper is built ONCE (stable reference). The
 * caller owns capturing the pristine `baseFetch` BEFORE calling this (so it is not the
 * wrapper itself).
 */
export function installProactiveAuthFetch(options: ProactiveAuthFetchOptions): () => void {
  const wrapper = makeProactiveAuthFetch(options);
  const previous = globalThis.fetch;
  globalThis.fetch = wrapper;
  return () => {
    // Only un-patch if OURS is still installed — never clobber a newer patcher's global.
    if (globalThis.fetch === wrapper) globalThis.fetch = previous;
  };
}
