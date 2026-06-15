// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * session-restore.ts — the PURE, testable decision at the heart of "reopening a
 * closed tab restores the session instead of bouncing to the login screen".
 *
 * Tokens are held in memory only (AGENTS.md), so a fresh page load has NO live
 * session — but a returning user who merely closed the tab (did NOT log out)
 * still has their DPoP-bound refresh token + non-extractable key persisted in
 * IndexedDB (see {@link ./session-persistence.ts}). On mount the app must try a
 * SILENT restore from that credential — a `refresh_token` grant, which is a
 * plain token-endpoint FETCH, never a popup/iframe — BEFORE it ever decides
 * "logged out" and shows login.
 *
 * This module isolates the *decision* (a pure async function over injected
 * collaborators) from the React wiring in `session-provider.tsx`, so the
 * security-sensitive branch table is unit-testable without a browser:
 *
 *   • no remembered active account            → LOGIN (nothing to restore)
 *   • active account, refresh grant succeeds   → RESTORED (logged in, no popup)
 *   • active account, refresh grant fails       → LOGIN (token expired/revoked)
 *     (expired/revoked is reported by the token provider as `undefined`; it has
 *      already cleared the dead persisted entry — see restoreIssuer)
 *
 * The decision is driven off the REFRESH-GRANT outcome, NOT off a public-profile
 * fetch. Gating "logged in" on the profile read (the previous behaviour) was the
 * bug: a transient profile-read failure dropped a user with a perfectly valid
 * restored token onto the login screen. Here, a restored token means logged-in
 * even if the cosmetic profile fetch later fails — the profile is loaded
 * separately and is allowed to degrade.
 */

/** Where the mount-time restore decision lands. */
export type SessionRestoreDecision =
  | {
      /** A live session was restored silently — render the app, no login UI. */
      readonly outcome: "restored";
      /** The authenticated WebID (from the restored session). */
      readonly webId: string;
      /** The issuer whose refresh-token session was restored. */
      readonly issuer: string;
    }
  | {
      /** No usable persisted session — the login screen must be shown. */
      readonly outcome: "login";
    };

/** The remembered-account shape this decision needs (a subset of RecentAccount). */
export interface RememberedAccount {
  readonly webId: string;
  readonly issuer?: string;
}

/**
 * Attempt a silent refresh-token restore for a known issuer. Resolves to the
 * authenticated WebID on success, or `undefined` when there is nothing to
 * restore OR the persisted refresh token is dead (expired / revoked) — in which
 * case the implementation has already cleared the dead entry. MUST NOT open a
 * popup/iframe (it is a token-endpoint fetch only) and MUST NOT throw for the
 * "no/expired token" case — that is the normal `undefined` path.
 *
 * Production wires {@link WebIdDPoPTokenProvider.restoreIssuer}.
 */
export type RestoreIssuer = (
  issuer: string,
) => Promise<{ webId: string } | undefined>;

/** Inputs to {@link decideSilentRestore} — all injected so it is pure + testable. */
export interface SilentRestoreInputs {
  /** The last active WebID (`null`/`undefined` when the user never signed in here). */
  readonly lastActiveWebId: string | null | undefined;
  /** The remembered accounts (to map the active WebID → its chosen issuer). */
  readonly remembered: readonly RememberedAccount[];
  /** The silent refresh-grant restore (see {@link RestoreIssuer}). */
  readonly restoreIssuer: RestoreIssuer;
}

/**
 * Decide, on a fresh page load, whether a returning user's session can be
 * restored SILENTLY (no popup/iframe, no login screen) from their persisted
 * DPoP-bound refresh token, or whether the login screen must be shown.
 *
 * Pure except for the injected {@link RestoreIssuer} (the one fetch). Never
 * throws: a thrown `restoreIssuer` (an unexpected error, not the normal
 * expired/revoked `undefined`) is treated as "could not restore" → LOGIN, which
 * is the safe, fail-closed default (we never assert a session we could not
 * actually rebuild).
 *
 * On `restored` the caller has, in-memory, a live session whose issuer is pinned
 * in the token provider, so a later private read upgrades without prompting; the
 * caller still loads the (cosmetic) profile separately and may let it degrade.
 */
export async function decideSilentRestore(
  inputs: SilentRestoreInputs,
): Promise<SessionRestoreDecision> {
  const { lastActiveWebId, remembered, restoreIssuer } = inputs;

  // No prior active account on this device → nothing to restore; show login.
  if (!lastActiveWebId) return { outcome: "login" };

  // The issuer the user chose for this account, remembered at login. Without it
  // we cannot run a refresh-token grant (the grant is per-issuer), so there is
  // no silent restore to attempt — fall through to LOGIN (the explicit click
  // there re-pins the issuer). A genuinely-still-logged-in IdP cookie still lets
  // that click complete without typing; we just can't do it without a gesture.
  const issuer = remembered.find((a) => a.webId === lastActiveWebId)?.issuer;
  if (!issuer) return { outcome: "login" };

  let restored: { webId: string } | undefined;
  try {
    restored = await restoreIssuer(issuer);
  } catch {
    // An UNEXPECTED restore error (not the normal expired/revoked `undefined`):
    // fail closed to LOGIN. We never claim a session we could not rebuild.
    return { outcome: "login" };
  }

  // Expired / revoked / no persisted token: restoreIssuer returns undefined and
  // has already cleared the dead entry → show login (the credential is gone).
  if (restored === undefined) return { outcome: "login" };

  // Live session rebuilt silently (refresh grant only): render the app.
  return { outcome: "restored", webId: restored.webId, issuer };
}
