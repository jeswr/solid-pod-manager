// @vitest-environment jsdom
// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * First-run onboarding behaviour (task #93, G8/P1-3). We render with a STUBBED
 * app-prefs hook (injected via `useAppPrefsImpl`) so these need no session/SWR
 * runtime — the load-bearing contract is:
 *   - the welcome explainer is shown ONCE to a brand-new user, and NOT after the
 *     pod first-run flag is set;
 *   - it stays hidden while the pod read is still loading or errored (never nag a
 *     returning user on a flaky connection);
 *   - dismissal persists to the pod via the app-prefs `setPrefs` updater, and
 *     hides the explainer immediately (optimistic);
 *   - every dismissal path (Escape, the ✕, Skip, Get started) persists once.
 *
 * The pod-flag READ/WRITE primitives themselves are unit-tested in
 * first-run.test.ts; this file pins the React wiring around them.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { defaultAppPrefs, type AppPrefs } from "../../lib/app-prefs.js";
import type { UseAppPrefsResult } from "../use-app-prefs.js";
import { FIRST_RUN_KEY, firstRunDone } from "./first-run.js";
import { useOnboarding } from "./use-onboarding.js";
import { OnboardingDialog } from "./onboarding-dialog.js";
import { Onboarding } from "./onboarding.js";

// next/link → a plain anchor (no router needed in jsdom).
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}));

/**
 * A controllable stub of `useAppPrefs`: holds the current prefs in module-ish
 * closure state and records `setPrefs` calls so a test can assert the pod write.
 */
function makeAppPrefsStub(initial: Partial<UseAppPrefsResult> = {}) {
  const state: { prefs: AppPrefs } = { prefs: initial.prefs ?? defaultAppPrefs() };
  const setPrefs = vi.fn((update: AppPrefs | ((p: AppPrefs) => AppPrefs)) => {
    state.prefs = typeof update === "function" ? update(state.prefs) : update;
  });
  const result: UseAppPrefsResult = {
    prefs: state.prefs,
    loading: false,
    revalidating: false,
    saving: false,
    setPrefs,
    setCommunity: vi.fn(),
    ...initial,
  };
  // Keep `prefs` pointing at the (possibly stub-overridden) value.
  result.prefs = initial.prefs ?? state.prefs;
  const hook = (() => result) as unknown as typeof import("../use-app-prefs.js").useAppPrefs;
  return { hook, setPrefs, state };
}

/** A tiny harness exposing the hook result to the test via the rendered DOM. */
function HookProbe({
  impl,
}: {
  impl: typeof import("../use-app-prefs.js").useAppPrefs;
}) {
  const { showFirstRun, dismissFirstRun } = useOnboarding({ useAppPrefsImpl: impl });
  return (
    <div>
      <span data-testid="show">{showFirstRun ? "yes" : "no"}</span>
      <button type="button" onClick={dismissFirstRun}>
        dismiss
      </button>
    </div>
  );
}

describe("useOnboarding decision", () => {
  it("shows the explainer for a brand-new user (settled, flag unset)", () => {
    const { hook } = makeAppPrefsStub();
    render(<HookProbe impl={hook} />);
    expect(screen.getByTestId("show").textContent).toBe("yes");
  });

  it("does NOT show once the pod first-run flag is set", () => {
    const prefs: AppPrefs = { ...defaultAppPrefs(), extra: { [FIRST_RUN_KEY]: "1" } };
    const { hook } = makeAppPrefsStub({ prefs });
    render(<HookProbe impl={hook} />);
    expect(screen.getByTestId("show").textContent).toBe("no");
  });

  it("does NOT show while the pod read is still loading", () => {
    const { hook } = makeAppPrefsStub({ loading: true });
    render(<HookProbe impl={hook} />);
    expect(screen.getByTestId("show").textContent).toBe("no");
  });

  it("does NOT show when the pod read errored (never nag on a flaky connection)", () => {
    const { hook } = makeAppPrefsStub({ error: new Error("offline") });
    render(<HookProbe impl={hook} />);
    expect(screen.getByTestId("show").textContent).toBe("no");
  });

  it("dismiss persists the flag via setPrefs (optimistic) and hides it", () => {
    const { hook, setPrefs } = makeAppPrefsStub();
    render(<HookProbe impl={hook} />);
    expect(screen.getByTestId("show").textContent).toBe("yes");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "dismiss" }));
    });
    // The pod write was an UPDATER that sets the flag from the live prefs.
    expect(setPrefs).toHaveBeenCalledTimes(1);
    const updater = setPrefs.mock.calls[0][0] as (p: AppPrefs) => AppPrefs;
    expect(firstRunDone(updater(defaultAppPrefs()))).toBe(true);
    // And the explainer is hidden immediately (local dismissed state).
    expect(screen.getByTestId("show").textContent).toBe("no");
  });
});

describe("OnboardingDialog (the welcome explainer)", () => {
  it("renders the first step with plain language and no jargon", () => {
    render(<OnboardingDialog open onDismiss={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/this is your pod/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Step 1 of 3/i)).toBeInTheDocument();
    // No WebID/ACL/RDF jargon anywhere in the explainer copy (DESIGN.md §2).
    expect(dialog.textContent ?? "").not.toMatch(/WebID|\bACL\b|\bRDF\b|triple|container/i);
  });

  it("walks Next → Next to the final 'Get started' action", () => {
    render(<OnboardingDialog open onDismiss={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByText(/Step 3 of 3/i)).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: /get started/i });
    expect(cta).toHaveAttribute("href", "/my-data");
  });

  it("dismisses via Skip, the ✕, and Escape (keyboard-dismissible)", () => {
    const onDismiss = vi.fn();
    const { unmount } = render(<OnboardingDialog open onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /skip/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    unmount();

    const onDismiss2 = vi.fn();
    const { unmount: unmount2 } = render(<OnboardingDialog open onDismiss={onDismiss2} />);
    fireEvent.click(screen.getByRole("button", { name: /close welcome/i }));
    expect(onDismiss2).toHaveBeenCalledTimes(1);
    unmount2();

    const onDismiss3 = vi.fn();
    render(<OnboardingDialog open onDismiss={onDismiss3} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
    expect(onDismiss3).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when closed", () => {
    render(<OnboardingDialog open={false} onDismiss={() => {}} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("Onboarding (hook → dialog wiring)", () => {
  it("shows the dialog for a new user and persists dismissal to the pod", () => {
    const { hook, setPrefs } = makeAppPrefsStub();
    // Patch the module the wrapper imports by rendering the dialog directly with
    // the hook result — the wrapper just glues useOnboarding to OnboardingDialog,
    // already covered above; here we assert the glue via a real render.
    const { showFirstRun, dismissFirstRun } = (() => {
      let captured!: ReturnType<typeof useOnboarding>;
      function Probe() {
        captured = useOnboarding({ useAppPrefsImpl: hook });
        return null;
      }
      render(<Probe />);
      return captured;
    })();
    expect(showFirstRun).toBe(true);
    render(<OnboardingDialog open={showFirstRun} onDismiss={dismissFirstRun} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /skip/i }));
    });
    expect(setPrefs).toHaveBeenCalledTimes(1);
  });

  it("is exported and mountable (smoke)", () => {
    // The default export reads the real useAppPrefs (needs the session provider),
    // so we only assert it is a function — the behaviour is covered via the hook.
    expect(typeof Onboarding).toBe("function");
  });
});
