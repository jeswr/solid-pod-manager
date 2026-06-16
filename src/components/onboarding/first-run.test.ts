// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * The first-run flag helpers (task #93, G8) — pure, no DOM (node env). These lock
 * the pod-flag READ ({@link firstRunDone}) + the immutable WRITE
 * ({@link withFirstRunDone}) that the onboarding hook composes into the app-prefs
 * optimistic `setPrefs` updater.
 */
import { describe, expect, it } from "vitest";
import { defaultAppPrefs, type AppPrefs } from "../../lib/app-prefs.js";
import { FIRST_RUN_KEY, firstRunDone, withFirstRunDone } from "./first-run.js";

describe("firstRunDone", () => {
  it("is false for a brand-new user (no stored flag)", () => {
    expect(firstRunDone(defaultAppPrefs())).toBe(false);
  });

  it("is true once the flag is set", () => {
    const prefs: AppPrefs = { ...defaultAppPrefs(), extra: { [FIRST_RUN_KEY]: "1" } };
    expect(firstRunDone(prefs)).toBe(true);
  });

  it("treats any non-empty stored value as done (format-tolerant)", () => {
    const prefs: AppPrefs = { ...defaultAppPrefs(), extra: { [FIRST_RUN_KEY]: "yes" } };
    expect(firstRunDone(prefs)).toBe(true);
  });

  it("is false for an empty stored value", () => {
    const prefs: AppPrefs = { ...defaultAppPrefs(), extra: { [FIRST_RUN_KEY]: "" } };
    expect(firstRunDone(prefs)).toBe(false);
  });
});

describe("withFirstRunDone", () => {
  it("sets the flag, preserving every other preference", () => {
    const base: AppPrefs = {
      ...defaultAppPrefs(),
      theme: "dark",
      extra: { foo: "bar" },
    };
    const next = withFirstRunDone(base);
    expect(firstRunDone(next)).toBe(true);
    // Foreign prefs untouched.
    expect(next.theme).toBe("dark");
    expect(next.extra.foo).toBe("bar");
    expect(next.community).toEqual(base.community);
  });

  it("does not mutate the input", () => {
    const base = defaultAppPrefs();
    const next = withFirstRunDone(base);
    expect(base.extra[FIRST_RUN_KEY]).toBeUndefined();
    expect(next).not.toBe(base);
  });

  it("is idempotent — returns the SAME reference when already set (no pod churn)", () => {
    const set: AppPrefs = { ...defaultAppPrefs(), extra: { [FIRST_RUN_KEY]: "1" } };
    expect(withFirstRunDone(set)).toBe(set);
  });
});
