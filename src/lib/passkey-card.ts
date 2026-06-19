// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * passkey-card.ts — the PURE decision behind the settings `PasskeyCard`'s
 * ready-state, extracted so it is unit-testable WITHOUT a React render (the vitest
 * runner is `src/lib/**` / node-env only; the settings PAGE is not in the test
 * include glob and there is no `@testing-library/react` here). Used by
 * `src/app/settings/page.tsx`.
 *
 * The card shows the "Passkey ready on this device" state when EITHER:
 *  - `hasPasskey` — the session reports a persisted per-device hint for the active
 *    WebID (so the next load can build a re-auth provider); or
 *  - `setupComplete` — a passkey set-up SUCCEEDED this session even though the
 *    local hint could NOT be persisted (`registerPasskey()` returned
 *    `{ saved: false }` — the credential was created on the device, only the
 *    cross-load hint failed). Without this, the UI would keep showing "Set up a
 *    passkey", inviting a pointless duplicate ceremony (roborev Finding 4 / S2).
 */
export interface PasskeyCardReadyInputs {
  /** The session's per-device "passkey registered for the active WebID" flag. */
  hasPasskey: boolean;
  /**
   * A passkey set-up succeeded THIS session for the CURRENT account (even if the
   * local hint did not persist). Component-local; reset on an account change so a
   * prior account's success never leaks into a different signed-in account (S1).
   */
  setupComplete: boolean;
}

/** Whether the settings PasskeyCard should render its "ready" state. */
export function passkeyCardReady({ hasPasskey, setupComplete }: PasskeyCardReadyInputs): boolean {
  return hasPasskey || setupComplete;
}
