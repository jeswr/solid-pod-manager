// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * First-run flag helpers (task #93, G8/P1-3) — the small pure functions that
 * read/write the "the user has seen the welcome explainer" flag.
 *
 * WHERE THE FLAG LIVES — the POD, not localStorage. It is stored as a single
 * entry in G2's pod-backed app-prefs `extra` escape hatch
 * ({@link file://../../lib/app-prefs.ts}), under the key {@link FIRST_RUN_KEY}.
 * That means the welcome explainer is shown at most ONCE PER ACCOUNT across every
 * device and browser the user signs in from (it survives a cache clear), instead
 * of re-appearing on each new device the way a localStorage flag would.
 *
 * These are deliberately pure (no React, no I/O) so the onboarding hook + its
 * tests can compute "should we show the explainer?" and "the prefs with the flag
 * set" without mounting anything. The actual write goes through the app-prefs
 * hook's optimistic `setPrefs` (so it paints+caches now, persists async, reverts
 * on failure) — see {@link file://./use-onboarding.ts}.
 */
import type { AppPrefs } from "@/lib/app-prefs";

/**
 * The `extra` key under which the dismissal flag is stored in the pod-backed
 * app-prefs. A truthy value (`"1"`) means the user has dismissed/finished the
 * welcome explainer and it must not be shown again.
 */
export const FIRST_RUN_KEY = "firstRunDone";

/** The stored value written when the explainer is dismissed/finished. */
const FIRST_RUN_VALUE = "1";

/**
 * True when the welcome explainer has already been dismissed for this account —
 * i.e. the pod-backed flag is set. Tolerant: any non-empty stored value counts
 * as "done", so a future format tweak can never accidentally re-show it.
 */
export function firstRunDone(prefs: AppPrefs): boolean {
  const v = prefs.extra[FIRST_RUN_KEY];
  return typeof v === "string" && v.length > 0;
}

/**
 * Return a NEW AppPrefs with the first-run flag set, preserving every other
 * preference (theme, community, the rest of `extra`). Pure — never mutates the
 * input — so it composes with the app-prefs hook's functional `setPrefs`
 * updater (which reads the LIVE cache value, so rapid writes don't race).
 *
 * Idempotent: if the flag is already set this returns the SAME object reference,
 * which lets the optimistic write short-circuit (the hook treats an identical
 * reference as a no-op and never churns the pod).
 */
export function withFirstRunDone(prefs: AppPrefs): AppPrefs {
  if (firstRunDone(prefs)) return prefs;
  return {
    ...prefs,
    extra: { ...prefs.extra, [FIRST_RUN_KEY]: FIRST_RUN_VALUE },
  };
}
