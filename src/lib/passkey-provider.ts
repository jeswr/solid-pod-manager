// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * passkey-provider.ts — compose the redirect-free WebAuthn (passkey) re-auth
 * provider INTO the #123 single-provider proactive-auth-fetch model.
 *
 * ─── Why this module exists (the #123 adaptation) ──────────────────────────────
 * The ORIGINAL A5 wiring put the passkey provider FIRST in a
 * `new ReactiveFetchManager([webAuthnProvider, provider])` array — first-`matches`
 * wins, reactive-on-401. The #123 rewrite REMOVED the manager: it installs a
 * SINGLE token provider into `installProactiveAuthFetch`, which attaches the token
 * PROACTIVELY (not on a 401) and reads a credential-origin boundary fresh per
 * request. So "passkey = provider[0]" no longer has anywhere to live.
 *
 * This module re-expresses the manager's first-`matches`-wins precedence as a
 * COMPOSING {@link AuthTokenProvider} (the exact shape proactive-auth-fetch
 * drives): it wraps the interactive {@link WebIdDPoPTokenProvider} and, when a
 * per-load passkey provider exists AND its host-matcher matches the request,
 * routes `upgrade()` through the WebID-bound passkey provider — which itself
 * falls back to the interactive provider on a wrong-account / failed ceremony
 * ({@link WebIdBoundWebAuthnProvider}). `matches` / `invalidate` delegate to the
 * interactive provider so the proactive-auth-fetch's structural contract +
 * stale-token retry are byte-for-byte unchanged.
 *
 * ─── The credential-boundary + no-auto-prompt invariants are UNCHANGED ─────────
 * This composer changes only WHICH credential `upgrade()` mints for an
 * ALREADY-PERMITTED request; it does NOT widen the set of requests that reach
 * `upgrade()`. The proactive-auth-fetch gate (`isOriginAllowed` +
 * `!isProviderOAuthRequest` + `canAttachNonInteractively` + `provider.matches`)
 * still decides whether ANY upgrade happens. In particular `canAttachNonInteractively`
 * is the session-liveness gate: on a PASSIVE / background read (the boot silent
 * restore's profile fetch) with a dead refresh token it returns false, so
 * `upgrade()` is never called — therefore the passkey `navigator.credentials.get()`
 * native prompt NEVER fires automatically on page load. The passkey path is reached
 * only when the gate already permits a non-interactive attach (a live session) OR
 * on an explicit user-gesture login (which establishes a fresh session). This keeps
 * the load-bearing Issue-1 invariant: nothing user-visible (popup, tab, OR passkey
 * prompt) happens AUTOMATICALLY on load — only the silent refresh-grant.
 *
 * The passkey provider is built ONCE per load (matching the manager-built-once
 * design); the payoff is therefore RETURN visits to the LAST account (the
 * persisted active WebID). A fresh login to a DIFFERENT account in the same
 * session does not get passkey re-auth until the next load.
 */
import type { AuthTokenProvider } from "./proactive-auth-fetch.js";
import type { WebIdBoundWebAuthnProvider } from "./webauthn-reauth.js";

/**
 * The interactive provider's slice the composer delegates to — the structural
 * `AuthTokenProvider` contract proactive-auth-fetch drives. `WebIdDPoPTokenProvider`
 * implements exactly this (matches / upgrade / optional invalidate).
 */
export type InteractiveProvider = AuthTokenProvider;

/**
 * Compose the per-load passkey provider with the interactive provider into the
 * SINGLE {@link AuthTokenProvider} `installProactiveAuthFetch` consumes.
 *
 * When `passkey` is `undefined` (the active WebID has no passkey on this device,
 * OR no active WebID is persisted), the returned provider is the interactive
 * provider's contract UNCHANGED — the pipeline is byte-for-byte today's behaviour.
 *
 * `upgrade(request)`:
 *   - if `passkey` exists AND `passkey.matches(request)` (the WebAuthn host
 *     matcher — keyed by the account's RESOURCE hosts) → delegate to
 *     `passkey.upgrade`, which mints a passkey-bound token and, on a wrong-account
 *     or failed ceremony, ITSELF delegates to the interactive fallback it was
 *     constructed with (so a body-bearing request's body is preserved — the
 *     `request.clone()` in {@link WebIdBoundWebAuthnProvider});
 *   - else → delegate straight to `interactive.upgrade`.
 *
 * `matches` / `invalidate` delegate to the INTERACTIVE provider: it owns the
 * "this is my request" structural contract + the stale-token retry's `invalidate`.
 * (The passkey provider is stateless — its `invalidate` is a no-op — so routing
 * invalidate to the interactive provider is both correct and what the
 * stale-token-retry path expects.)
 */
export function composePasskeyProvider(
  interactive: InteractiveProvider,
  passkey: WebIdBoundWebAuthnProvider | undefined,
): AuthTokenProvider {
  if (passkey === undefined) return interactive;

  return {
    matches: (request) => interactive.matches(request),
    upgrade: async (request, forceRefresh) => {
      // First-`matches`-wins precedence (the old ReactiveFetchManager array
      // semantics): only the passkey provider's OWN host matcher decides whether
      // the passkey path runs. A request to a host the user has no passkey for
      // takes the interactive path unchanged.
      if (await passkey.matches(request)) {
        // The WebID-bound passkey provider mints a passkey token and, on a
        // wrong-account or failed ceremony, delegates to the interactive
        // fallback it holds — never rejecting the fetch. (It ignores
        // forceRefresh: a passkey upgrade is stateless — a fresh ceremony every
        // time — so there is no cached credential to force past.)
        return passkey.upgrade(request);
      }
      return interactive.upgrade(request, forceRefresh);
    },
    // The stale-token retry's invalidate + the structural contract are the
    // interactive provider's. The passkey provider's invalidate is a no-op
    // (stateless), so this is correct AND keeps the proactive-auth-fetch retry
    // path identical.
    ...(interactive.invalidate !== undefined
      ? { invalidate: (request: Request) => interactive.invalidate!(request) }
      : {}),
  };
}
