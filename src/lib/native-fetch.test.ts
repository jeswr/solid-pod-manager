// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * native-fetch captures the pristine `fetch` BEFORE the reactive-auth patch.
 * The capture is idempotent (first wins) so a call that happens to run after the
 * patch can never overwrite the good reference — the property that keeps
 * community-feed requests off the Solid auth path. Imported fresh per test
 * (module-level capture state) via vi.resetModules.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL;
  vi.resetModules();
});

describe("native-fetch", () => {
  it("captures the current global fetch on first call and exposes it", async () => {
    const pristine = vi.fn();
    globalThis.fetch = pristine as unknown as typeof fetch;
    const mod = await import("./native-fetch.js");
    mod.captureNativeFetch();
    // A bound copy of `pristine` — calling it invokes the original.
    const got = mod.getNativeFetch();
    expect(got).toBeTypeOf("function");
    got?.("https://example.test/");
    expect(pristine).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — a later patch cannot overwrite the captured reference", async () => {
    const pristine = vi.fn();
    globalThis.fetch = pristine as unknown as typeof fetch;
    const mod = await import("./native-fetch.js");
    mod.captureNativeFetch(); // captures `pristine`

    // Simulate the reactive-auth patch replacing the global, then a stray re-capture.
    const patched = vi.fn();
    globalThis.fetch = patched as unknown as typeof fetch;
    mod.captureNativeFetch(); // must be a no-op

    mod.getNativeFetch()?.("https://example.test/");
    expect(pristine).toHaveBeenCalledTimes(1); // still the pristine one
    expect(patched).not.toHaveBeenCalled();
  });

  it("returns undefined before any capture", async () => {
    const mod = await import("./native-fetch.js");
    expect(mod.getNativeFetch()).toBeUndefined();
  });
});
