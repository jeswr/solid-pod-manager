// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * boot-restore.ts — the pure, injectable BOOT SILENT-RESTORE decision, extracted
 * from `SessionProvider`'s on-load restore IIFE so its load-bearing invariant is
 * UNIT-TESTABLE without a React render (the vitest harness here is node-env,
 * `src/lib/**` only — no `@testing-library/react`, no jsdom component render).
 *
 * ─── THE LOAD-BEARING INVARIANT (Issue 1: the re-auth flicker) ─────────────────
 * On page load the restore path is FULLY BACKGROUND: it tries ONLY the
 * refresh-grant (a plain token-endpoint fetch via `restoreIssuer`). It must NEVER
 * open a popup / tab / iframe, and must NEVER auto-trigger a passkey native
 * prompt, just to restore. A popup may open ONLY later, as a last resort, on an
 * EXPLICIT user gesture (a login click) — never automatically on load.
 *
 * The flicker root cause: after a long absence the persisted refresh token has
 * expired, so `restoreIssuer` fails. The OLD failure handling could let a
 * follow-on path open a popup that completes fast against a still-valid IdP
 * cookie — a visible "tab rapidly opening and closing" flash. The fix is that the
 * boot-restore decision has NO popup-opening dependency AT ALL: a failed restore
 * resolves to LOGGED-OUT (the non-intrusive LoginScreen "session expired — sign
 * in" affordance), and the popup only ever opens from a later user gesture.
 *
 * This module makes that mechanical and testable: {@link runBootRestore} is given
 * a `restoreSession` (the refresh-grant) and the publish/logged-out effects, and
 * has NO parameter through which a popup / passkey prompt could be triggered. A
 * test injects a FAILING `restoreSession` and asserts the outcome is logged-out
 * and that no injected popup spy was ever reachable — proving boot restore cannot
 * open a window.
 */

/** The outcome of a boot silent-restore attempt — what the UI should become. */
export type BootRestoreOutcome =
  /** A renewable session was rebuilt (refresh-grant succeeded) → published logged-in. */
  | { kind: "restored" }
  /** No renewable session (dead/absent refresh token, or no remembered issuer) → logged-out. */
  | { kind: "logged-out" }
  /** A logout / new login superseded this restore mid-flight → the superseder owns the UI. */
  | { kind: "superseded" };

/**
 * The effects {@link runBootRestore} orchestrates. NOTE — by CONSTRUCTION there
 * is NO popup-open / passkey-prompt effect in this contract: the boot restore
 * cannot trigger one. That absence is the invariant, enforced by the type.
 */
export interface BootRestoreDeps {
  /**
   * Rebuild a RENEWABLE in-memory session for the remembered issuer via a
   * REFRESH-GRANT ONLY (a plain token-endpoint fetch — NO popup/iframe). Resolves
   * truthy iff a renewable session was rebuilt; resolves falsy / rejects when the
   * refresh token is dead/absent. The provider's `restoreIssuer` is exactly this.
   */
  restoreSession: () => Promise<boolean>;
  /** Whether THIS restore is still the current establish (no racing logout/login). */
  stillCurrent: () => boolean;
  /** Publish the logged-in UI for the restored account (reads the now-renewable session). */
  publishRestored: () => Promise<void>;
  /** Close the credential boundary + flip the UI to logged-out (the fail-closed fallback). */
  toLoggedOut: () => void;
}

/**
 * Run the boot silent-restore decision: refresh-grant → (renewable ⇒ publish
 * logged-in) | (dead ⇒ logged-out). Fail-closed: ANY thrown/false `restoreSession`
 * resolves to logged-out, NEVER a popup and NEVER a falsely-asserted session.
 * Bails WITHOUT touching the UI when superseded (the superseding login/logout owns
 * the boundary + UI — the #123 fence).
 *
 * There is deliberately no code path here that can open a popup, a tab, or a
 * passkey prompt — the only renewal mechanism is the injected `restoreSession`
 * refresh-grant. That is the Issue-1 invariant, expressed as code.
 */
export async function runBootRestore(deps: BootRestoreDeps): Promise<BootRestoreOutcome> {
  let renewable = false;
  try {
    renewable = await deps.restoreSession();
  } catch {
    renewable = false; // a dead refresh token is a normal outcome, not an error
  }
  // FENCE: a logout / new login won the race during the refresh grant — the
  // superseding actor owns the boundary + UI now; touch nothing.
  if (!deps.stillCurrent()) return { kind: "superseded" };

  if (renewable) {
    try {
      await deps.publishRestored();
      return { kind: "restored" };
    } catch {
      // The post-grant profile read failed: fall closed to logged-out (still
      // never a popup), but only while current (the publish's own fence covers
      // the superseded case — re-check here so we don't clobber a newer actor).
      if (!deps.stillCurrent()) return { kind: "superseded" };
      deps.toLoggedOut();
      return { kind: "logged-out" };
    }
  }

  // No renewable session → logged-out (the LoginScreen affordance). NO popup.
  deps.toLoggedOut();
  return { kind: "logged-out" };
}
