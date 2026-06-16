// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * native-fetch captures the pristine `fetch` BEFORE the reactive-auth patch.
 *
 * Unified module (people-search + community feeds): capture happens at
 * MODULE-EVALUATION time (importing the module takes the snapshot, so the eager
 * `nativeFetch` const is the pre-patch reference for the WebID-index client),
 * AND `captureNativeFetch()` is an idempotent explicit boot hook (first wins) so
 * a call that happens to run after the patch can never overwrite the good
 * reference. `nativeFetch` and `getNativeFetch()` MUST resolve to the SAME
 * captured reference — never a second uncoordinated snapshot. Imported fresh per
 * test (module-level capture state) via vi.resetModules.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL;
  vi.resetModules();
});

describe("native-fetch", () => {
  it("captures the current global fetch at module-evaluation (import) time", async () => {
    const pristine = vi.fn();
    globalThis.fetch = pristine as unknown as typeof fetch;
    // Importing the module is itself sufficient to snapshot the pre-patch fetch.
    const mod = await import("./native-fetch.js");
    const got = mod.getNativeFetch();
    expect(got).toBeTypeOf("function");
    // A bound copy of `pristine` — calling it invokes the original.
    got?.("https://example.test/");
    expect(pristine).toHaveBeenCalledTimes(1);
  });

  it("exposes the SAME reference via the nativeFetch const and getNativeFetch()", async () => {
    const pristine = vi.fn();
    globalThis.fetch = pristine as unknown as typeof fetch;
    const mod = await import("./native-fetch.js");
    // No second, uncoordinated snapshot: the eager const and the accessor are
    // backed by the one captured reference. (Identity — both bind the same
    // pristine fn at the same instant.)
    expect(mod.nativeFetch).toBe(mod.getNativeFetch());
    expect(mod.nativeFetch).toBeTypeOf("function");
  });

  it("is idempotent — a later patch cannot overwrite the captured reference", async () => {
    const pristine = vi.fn();
    globalThis.fetch = pristine as unknown as typeof fetch;
    const mod = await import("./native-fetch.js");
    mod.captureNativeFetch(); // already captured at import; this is a no-op

    // Simulate the reactive-auth patch replacing the global, then a stray re-capture.
    const patched = vi.fn();
    globalThis.fetch = patched as unknown as typeof fetch;
    mod.captureNativeFetch(); // must be a no-op

    mod.getNativeFetch()?.("https://example.test/");
    expect(pristine).toHaveBeenCalledTimes(1); // still the pristine one
    expect(patched).not.toHaveBeenCalled();
  });

  it("captureNativeFetch returns the captured reference and is stable across calls", async () => {
    const pristine = vi.fn();
    globalThis.fetch = pristine as unknown as typeof fetch;
    const mod = await import("./native-fetch.js");
    const first = mod.captureNativeFetch();
    const second = mod.captureNativeFetch();
    expect(first).toBe(second);
    expect(first).toBe(mod.getNativeFetch());
  });

  it("captures undefined in a non-fetch environment", async () => {
    // Remove the global before the module evaluates: nothing to snapshot.
    // (Restored by afterEach.)
    // @ts-expect-error — intentionally clearing the global for the test.
    delete globalThis.fetch;
    const mod = await import("./native-fetch.js");
    expect(mod.getNativeFetch()).toBeUndefined();
    expect(mod.nativeFetch).toBeUndefined();
  });
});
