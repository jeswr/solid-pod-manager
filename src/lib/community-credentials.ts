// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Community-feed credentials — Matrix user access token + (optional) Discourse
 * user API key.
 *
 * These are **in-memory only**, never written to localStorage / sessionStorage /
 * cookies / the pod — exactly like the integration token-store
 * (`integrations/core/token-store.ts`) and the Solid session itself. A hard
 * reload drops them and the user simply re-connects. This keeps a third-party
 * bearer token off disk: it is held only for the lifetime of the tab.
 *
 * The forum (Discourse) read path needs NO credential at all — it works out of
 * the box, so a user sees the Solid forum feed without connecting anything. The
 * Matrix path is gated behind these credentials ("connect your Matrix account").
 *
 * Credentials are passed to `MatrixFeedSource`/`DiscourseFeedSource` via config
 * and are **never logged** (the package's `safeFetch` also never logs them).
 */

/** A user's connected community credentials (per tab, in memory). */
export interface CommunityCredentials {
  /** Matrix user access token (Bearer). Unlocks the Matrix room feed. */
  matrixAccessToken?: string;
  /** Optional Discourse per-user API key — unlocks notifications / restricted categories. */
  discourseUserApiKey?: string;
  /** Discourse client id paired with the user API key, when the platform requires it. */
  discourseUserApiClientId?: string;
}

let creds: CommunityCredentials = {};
/**
 * The WebID the current credentials belong to. Tracked MODULE-level (not in a
 * component ref) so navigating to /community and back does not look like an
 * account switch: a component-local ref re-initialises to `undefined` on every
 * mount and would falsely "switch" on the first effect, disconnecting Matrix on
 * every remount. `null` means "no owner yet" (distinct from a real WebID).
 */
let credOwnerWebId: string | null = null;

/** Read the current in-memory community credentials (a shallow copy). */
export function getCommunityCredentials(): CommunityCredentials {
  return { ...creds };
}

/** True once a Matrix access token has been provided (the Matrix feed is unlocked). */
export function hasMatrixCredential(): boolean {
  return typeof creds.matrixAccessToken === "string" && creds.matrixAccessToken.length > 0;
}

/**
 * Replace the in-memory credentials, recording the owning WebID. Empty/blank
 * values are dropped (so passing `{ matrixAccessToken: "" }` disconnects Matrix
 * rather than storing a blank). Pass the active WebID as `ownerWebId` so a later
 * account switch can detect it ({@link clearCommunityCredentialsIfOwnerChanged}).
 */
export function setCommunityCredentials(
  next: CommunityCredentials,
  ownerWebId?: string,
): void {
  const clean: CommunityCredentials = {};
  if (next.matrixAccessToken && next.matrixAccessToken.trim()) {
    clean.matrixAccessToken = next.matrixAccessToken.trim();
  }
  if (next.discourseUserApiKey && next.discourseUserApiKey.trim()) {
    clean.discourseUserApiKey = next.discourseUserApiKey.trim();
  }
  if (next.discourseUserApiClientId && next.discourseUserApiClientId.trim()) {
    clean.discourseUserApiClientId = next.discourseUserApiClientId.trim();
  }
  creds = clean;
  if (ownerWebId !== undefined) credOwnerWebId = ownerWebId;
}

/** Forget all community credentials (disconnect). */
export function clearCommunityCredentials(): void {
  creds = {};
  credOwnerWebId = null;
}

/**
 * Clear the credentials ONLY when the active WebID differs from the one they
 * belong to — i.e. on a genuine account switch (or logout). This is safe to call
 * on every mount: a remount with the SAME WebID is a no-op (the owner is tracked
 * module-level, surviving remounts), so the in-memory Matrix token lives for the
 * tab as intended; a switch to a different WebID (or to none) drops the previous
 * account's token so it can never leak across accounts. Adopts the active WebID
 * as the new owner so subsequent same-WebID mounts stay no-ops.
 */
export function clearCommunityCredentialsIfOwnerChanged(webId: string | undefined): void {
  const next = webId ?? null;
  if (credOwnerWebId === next) return;
  // A different owner (or logout). If we currently hold credentials, drop them.
  if (creds.matrixAccessToken || creds.discourseUserApiKey || creds.discourseUserApiClientId) {
    creds = {};
  }
  credOwnerWebId = next;
}
