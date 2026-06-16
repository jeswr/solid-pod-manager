// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * `useOnboarding` (task #93, G8/P1-3) — decides whether to show the first-run
 * welcome explainer, and persists its dismissal to the POD.
 *
 * READS via G2's pod-backed app-prefs ({@link useAppPrefs}) — which is itself
 * instant-nav SWR over the durable cache, so this adds NO new fetch-on-mount: the
 * flag is read cache-first (instant paint), revalidated in the background. The
 * "first run" flag lives in the pod ({@link FIRST_RUN_KEY}), so the explainer is
 * shown at most once per account across every device/browser, surviving a cache
 * clear (#62 research P1-3).
 *
 * SHOW DECISION — conservative + fail-CLOSED so we never nag a returning user:
 *   - Only once the app-prefs read has SETTLED (not its first uncached load) AND
 *     did not error — a durable-mirror value from a FAILED pod revalidation, or a
 *     not-yet-loaded default, must NOT trigger the explainer (that would re-show
 *     it on a flaky connection). On error / still-loading we show nothing.
 *   - Only when the pod flag is genuinely UNSET.
 *
 * DISMISS — optimistic + non-blocking (the suite mutation rule): `setPrefs`'s
 * functional updater sets the flag from the LIVE cache value, paints+caches it
 * immediately (so the explainer closes at once + a re-mount won't reopen it), and
 * persists to the pod async; on failure the app-prefs hook reverts and toasts.
 * Local `dismissed` state hides the dialog the instant the user acts, so the UI
 * never waits on the pod round-trip.
 */
import { useCallback, useMemo, useState } from "react";
import { useAppPrefs } from "@/components/use-app-prefs";
import { firstRunDone, withFirstRunDone } from "./first-run";

export interface UseOnboardingResult {
  /**
   * True when the first-run welcome explainer should be shown: the pod-backed
   * app-prefs have settled cleanly, the flag is unset, and the user hasn't
   * dismissed it in this session yet.
   */
  showFirstRun: boolean;
  /**
   * Dismiss/finish the explainer: hides it immediately and persists the pod flag
   * optimistically (so it never shows again, on any device). Idempotent.
   */
  dismissFirstRun: () => void;
}

export interface UseOnboardingOptions {
  /**
   * Inject the app-prefs hook (tests). Defaults to the real {@link useAppPrefs}.
   * Typed as the call signature only so a test stub needs just the surface the
   * onboarding uses.
   */
  useAppPrefsImpl?: typeof useAppPrefs;
}

/**
 * The first-run onboarding hook. Pure of the dialog UI — it only owns the
 * "show?" decision + the optimistic pod dismissal, so it is testable without a
 * DOM by injecting a stub app-prefs hook.
 */
export function useOnboarding(options: UseOnboardingOptions = {}): UseOnboardingResult {
  const useAppPrefsHook = options.useAppPrefsImpl ?? useAppPrefs;
  // The app-prefs hook already surfaces write failures via a toast (its onError),
  // so the onboarding need not handle them again here.
  const { prefs, loading, error, setPrefs } = useAppPrefsHook();

  // Hide the explainer the instant the user acts, independent of the pod write
  // settling — so dismissal feels instant even on a slow connection.
  const [dismissed, setDismissed] = useState(false);

  // Show ONLY when the read has settled cleanly and the flag is genuinely unset.
  // Fail-closed: still-loading or errored ⇒ show nothing (never nag on a flaky
  // connection or off a stale-mirror default).
  const showFirstRun = useMemo(
    () => !dismissed && !loading && !error && !firstRunDone(prefs),
    [dismissed, loading, error, prefs],
  );

  const dismissFirstRun = useCallback(() => {
    setDismissed(true);
    // Optimistic functional updater: set the flag from the LIVE cache value (so
    // it composes with any other in-flight app-prefs write), persist async. An
    // already-set flag returns the SAME reference ⇒ the hook short-circuits (no
    // pod churn).
    setPrefs((prev) => withFirstRunDone(prev));
  }, [setPrefs]);

  return useMemo(
    () => ({ showFirstRun, dismissFirstRun }),
    [showFirstRun, dismissFirstRun],
  );
}
