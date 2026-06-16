// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * The first-run onboarding entry point (task #93, G8/P1-3) — wires the
 * {@link useOnboarding} decision to the {@link OnboardingDialog}.
 *
 * Mounted ONCE inside the authenticated app frame (AppShell), so it covers the
 * whole app and only ever runs for a logged-in user (the gate is the AppShell's
 * `status === "logged-in"`). It reads the first-run flag through G2's pod-backed
 * app-prefs (instant-nav SWR; NO new fetch-on-mount) and shows the welcome
 * explainer at most once per account — see {@link useOnboarding}.
 *
 * It renders nothing until the explainer should actually show, so it adds no
 * markup to the steady-state app.
 */
import { useOnboarding } from "./use-onboarding";
import { OnboardingDialog } from "./onboarding-dialog";

export function Onboarding() {
  const { showFirstRun, dismissFirstRun } = useOnboarding();
  return <OnboardingDialog open={showFirstRun} onDismiss={dismissFirstRun} />;
}
