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

/** The once-per-scope decision `usePrefetch` makes on each render. */
export interface PrefetchDecision {
  /** Warm now? (true exactly once per NEW non-empty scope). */
  shouldWarm: boolean;
  /** The value to write back into the `warmedFor` ref after this render. */
  nextWarmedFor: string | undefined;
}

/**
 * The once-per-scope guard logic, factored OUT of the hook so the logout→login
 * lifecycle is unit-testable without a React renderer.
 *
 * `usePrefetch` is MOUNTED for the app's whole life (AppShell never unmounts it —
 * it renders on the logged-out screen too). So the guard cannot merely "warm when
 * the key changes"; it must also RESET when there is no live scope. Otherwise:
 * login(A) warms + records `warmedFor = scope(A)`; logout clears `readCache` but
 * leaves `warmedFor` stale; login(A) again reproduces the SAME `scope(A)` and the
 * "already warmed" check skips it — leaving the freshly-cleared session COLD
 * (roborev finding, Medium). Resetting to `undefined` on every empty-scope render
 * makes the next login re-warm.
 *
 *   - `warmKey === ""` (logged-out / no WebID): never warm; RESET `warmedFor` so
 *     the next login re-warms the cleared cache.
 *   - `warmKey === prevWarmedFor` (same live scope already warmed): skip (idempotent
 *     across re-renders/navigations within one session).
 *   - otherwise (a NEW non-empty scope — first login, account switch, storage
 *     switch, or a re-login after a logout reset): WARM, and record the scope.
 */
export function decidePrefetch(
  prevWarmedFor: string | undefined,
  warmKey: string,
): PrefetchDecision {
  if (warmKey === "") return { shouldWarm: false, nextWarmedFor: undefined };
  if (prevWarmedFor === warmKey) return { shouldWarm: false, nextWarmedFor: warmKey };
  return { shouldWarm: true, nextWarmedFor: warmKey };
}
