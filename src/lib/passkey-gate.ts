// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * passkey-gate.ts — the PURE decision behind the proactive-auth-fetch
 * session-liveness gate (`canAttachNonInteractively`), extracted so the
 * load-bearing Finding-3 + no-auto-prompt-on-load invariants are unit-testable
 * WITHOUT a React render (the vitest runner is `src/lib/**` / node-env only).
 *
 * ─── Why the passkey LICENCE exists (roborev Finding 3, the flicker fix) ───────
 * `WebIdDPoPTokenProvider.canRenewWithoutInteraction` is the only signal the gate
 * had: it is true ONLY when the interactive provider holds a live token or a
 * refresh token. For a PASSKEY account whose refresh token is DEAD it returns
 * false — so the gate blocked any `upgrade()`, the protected read 401'd, and the
 * old recent-account path fell to an OAuth popup that flashed open/closed
 * (`prompt=none` against the live IdP cookie). The passkey ceremony
 * (`navigator.credentials.get()`) is "non-interactive" in the popup sense — a
 * NATIVE prompt, NO window — exactly what the gate is meant to permit but could
 * not express.
 *
 * The LICENCE is a single boolean the session provider sets ONLY from a
 * USER-GESTURE passkey sign-in (`signInWithPasskey`), scoped to one WebID. It is
 * UNSET on boot, so a PASSIVE boot read can never satisfy the passkey branch and
 * therefore can never reach `upgrade()` / a passkey prompt automatically on load.
 * That is the load-bearing no-auto-prompt-on-load invariant, encoded HERE so a
 * test can assert it directly.
 */

/** The inputs the gate decision reads, all captured fresh per request. */
export interface PasskeyGateInputs {
  /**
   * A USER-GESTURE passkey sign-in licensed a redirect-free passkey `upgrade()`
   * for the upcoming protected read. `undefined` on boot and after the sign-in
   * settles — so a passive boot read is NEVER licensed.
   */
  passkeyInteractiveWebId: string | undefined;
  /** Whether a composed passkey provider was wired this load (else there is nothing to license). */
  hasPasskeyProvider: boolean;
  /** Whether the request URL is inside the current credential boundary (own-pod origins). */
  originAllowed: boolean;
  /**
   * Whether the interactive provider can renew this session WITHOUT a popup (a
   * live token or a refresh token). The PRE-EXISTING signal, unchanged.
   */
  interactiveRenewable: boolean;
}

/**
 * Decide whether the proactive-auth fetch may attach/upgrade a token for this
 * request WITHOUT any user-visible interaction (no popup, no flash).
 *
 * Two ways to qualify:
 *  1. PASSKEY LICENCE — a user-gesture passkey sign-in is in flight
 *     (`passkeyInteractiveWebId` set), a passkey provider is wired, and the
 *     request is inside the credential boundary. The composed `upgrade()` then
 *     serves it via the native passkey prompt (no window). This is what lets a
 *     DEAD-refresh-token passkey account sign in redirect-free. UNSET on boot ⇒
 *     a passive boot read never qualifies here.
 *  2. INTERACTIVE RENEWAL — the pre-existing path: the interactive provider holds
 *     a live/refresh token (a plain fetch, no popup).
 *
 * Neither ⇒ false: the request goes out unauthenticated (fail-closed; the old
 * behaviour for a dead session).
 */
export function canAttachNonInteractivelyDecision(inputs: PasskeyGateInputs): boolean {
  const { passkeyInteractiveWebId, hasPasskeyProvider, originAllowed, interactiveRenewable } =
    inputs;
  if (passkeyInteractiveWebId !== undefined && hasPasskeyProvider && originAllowed) {
    return true;
  }
  return interactiveRenewable;
}
