// AUTHORED-BY Claude Opus 4.8
/**
 * The ESTABLISH-SESSION GENERATION FENCE — the pure, audited check that closes the
 * unfenced credential-boundary race in the Pod Manager's `establishSessionFor`
 * (`SessionProvider.completeLogin` / `restore`), the same race the seven vite siblings
 * fixed for the #123 proactive-fetch rollout (roborev HIGH, surfaced by pod-health).
 *
 * THE RACE (Pod Manager shape). `completeLogin` / `restore` are async: they arm the
 * proactive credential boundary (`allowedOriginsRef` / `issuerOriginRef` /
 * `activeIssuerRef`), then `await fetchProfile(id)` — the now-authenticated profile
 * re-read — and ONLY THEN re-arm the boundary to the discovered storage origins, write
 * the active-WebID pointer, and publish the logged-in UI (`setProfile` / `setActive` /
 * `setStatus("logged-in")`). A concurrent `logout()` or a NEW `login()`/`restore()`
 * (account switch) racing that `await` supersedes this establish. If the resumed
 * establish re-arms + publishes UNCONDITIONALLY it can:
 *   (a) re-arm the boundary against a provider the user just LOGGED OUT of (reads against
 *       a reset/logged-out session behind a logged-out UI);
 *   (b) republish a STALE webId/profile/session over the newer state;
 *   (c) CLOBBER a newer login's freshly-armed boundary/pointer with the older identity's;
 *   (d) resurrect a logged-out credential's origins.
 *
 * THE FENCE. The Pod Manager's `WebIdDPoPTokenProvider` exposes no `loginGeneration()` /
 * `reset()` / `authenticatedWebId()` (unlike the vite apps' provider), so — adapting the
 * vite `establishStillCurrent` pattern to the Pod Manager's shape — the SessionProvider
 * owns a MONOTONIC generation counter, bumped on EVERY supersession (each `login` /
 * `loginWithIssuer` / `restore` start, and `logout`). Each establish snapshots its
 * generation up front and re-checks it AFTER the profile await, BEFORE re-arming the
 * authoritative boundary / writing the pointer / publishing. The generation captures the
 * UNION of all four sub-races (any logout OR any account switch advances it), so an
 * issuer/WebID re-check is unnecessary — a superseded establish is detected purely by the
 * counter having moved.
 *
 * BAIL WITHOUT CLEARING: on supersession the establish returns WITHOUT touching the
 * boundary. The superseding actor (the logout, or the newer login) already owns the
 * boundary — clearing it here would wipe a NEWER login's freshly-armed boundary (closing
 * sub-race (c) the correct way), and the logout already closed it. This mirrors the vite
 * fix's "bail without clearing on the superseded path".
 */

/**
 * Whether the establish identified by `establishGeneration` is STILL the current one —
 * i.e. no logout / new login / new restore advanced the counter while it awaited.
 *
 * PURE + exported so the fence is unit-testable WITHOUT a React render: a test snapshots a
 * generation, advances the live counter (simulating a racing logout / account switch), and
 * asserts this returns false so the caller bails. Returns true ONLY when the live
 * generation still equals the snapshot — fail-closed (false) on ANY advance.
 */
export function establishStillCurrent(inputs: {
  establishGeneration: number;
  currentGeneration: number;
}): boolean {
  return inputs.currentGeneration === inputs.establishGeneration;
}

/**
 * The injected side effects + generation read that {@link runFencedPublish} orchestrates.
 * Extracting the FENCE-GATED PUBLISH (the security-critical tail of every establish) into a
 * dependency-injected unit makes its FENCE PLACEMENT testable WITHOUT a React render or auth
 * runtime (the vite `runEstablishSession` pattern): a test injects a controllable
 * `readProfile` promise, advances `liveGeneration()` at the await boundary (simulating a
 * racing logout / account switch), and asserts NO authoritative arm + NO publish + NO persist
 * leak past the superseded fence — i.e. the fence is consulted AFTER the await and BEFORE any
 * shared-state mutation, not merely that the pure equality is correct.
 */
export interface FencedPublishDeps<P> {
  /** The CURRENT (live) establish generation — re-read AT the fence (advances on supersession). */
  liveGeneration: () => number;
  /** Arm the PROVISIONAL boundary (WebID + issuer) so the authenticated profile read carries the token. */
  armProvisional: () => void;
  /** Read the now-authenticated profile (the single async boundary the fence guards). */
  readProfile: () => Promise<P>;
  /** Arm the AUTHORITATIVE boundary (+ the discovered storage origins) once the profile is known. */
  armAuthoritative: (profile: P) => void;
  /** Publish the logged-in UI (setWebId / setProfile / setActive / setStatus) — the LAST step. */
  publish: (profile: P) => void;
  /** Best-effort persistence (recent-accounts + active-WebID pointer). Optional (restore skips it). */
  persist?: (profile: P) => void;
}

/**
 * The SHARED, fence-gated PUBLISH tail of every establish (completeLogin / restore), extracted
 * so its security-critical fence PLACEMENT is unit-testable with injected side effects. Arms a
 * PROVISIONAL boundary, reads the authenticated profile, then — re-checking
 * {@link establishStillCurrent} AFTER the await — arms the AUTHORITATIVE boundary, persists, and
 * publishes the UI. A logout / new login that advanced the generation during the read makes this
 * BAIL WITHOUT arming the authoritative boundary, persisting, or publishing — and WITHOUT clearing
 * the boundary (the superseding actor owns it). Returns whether it published (true) or bailed
 * (false). The profile-read REJECTION is NOT swallowed here — the caller's own (fenced) catch owns
 * failure cleanup — so this orchestrates only the success/superseded split.
 *
 * ORDER (load-bearing): provisional-arm → read → FENCE → authoritative-arm → persist → publish.
 * Publishing the logged-in UI is the final act, never before the boundary is armed, and never on a
 * superseded path.
 */
export async function runFencedPublish<P>(
  establishGeneration: number,
  deps: FencedPublishDeps<P>,
): Promise<boolean> {
  deps.armProvisional();
  const profile = await deps.readProfile();
  if (
    !establishStillCurrent({
      establishGeneration,
      currentGeneration: deps.liveGeneration(),
    })
  ) {
    return false; // superseded during the read — bail WITHOUT arming/persisting/publishing.
  }
  deps.armAuthoritative(profile);
  deps.persist?.(profile);
  deps.publish(profile);
  return true;
}
