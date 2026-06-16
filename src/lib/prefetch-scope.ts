// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * The session-scope key for PROACTIVE PREFETCH (PM #65 Phase 2).
 *
 * `usePrefetch` keys its work by a logged-in `(webId, activeStorage)` pair in TWO
 * places — the once-per-scope `warmedFor` guard AND the `isCurrent` session-race
 * guard's `liveKeyRef`. The `isCurrent` guard works ONLY if those two strings are
 * built IDENTICALLY: it holds (`true`) exactly when `liveKeyRef.current ===
 * warmKey`. A delimiter (or any) drift between the two sites would make that
 * comparison NEVER hold for the current session, so `runPrefetch` would
 * short-circuit and warm NOTHING — the guard silently disabling all prefetching.
 *
 * So the key is built ONE way, here, and BOTH sites call this. Kept in its own
 * JSX-free module (not in the `"use client"` hook) so the load-bearing identity
 * can be unit-tested directly in the node Vitest env without pulling React /
 * session-provider into the test graph.
 *
 * The space delimiter is unambiguous: neither a WebID nor a storage URL can
 * contain a bare space. `""` means "no live scope to warm" (logged-out / no
 * WebID), which can never equal a logged-in scope a warm-up was scheduled for.
 */
export function scopeKey(
  status: string,
  webId: string | undefined,
  activeStorage: string | undefined,
): string {
  if (status !== "logged-in" || !webId) return "";
  return `${webId} ${activeStorage ?? ""}`;
}
