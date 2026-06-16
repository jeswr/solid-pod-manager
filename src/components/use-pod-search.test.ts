// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Tests for the pod-search hook's KEYING + GATING logic (`use-pod-search.ts`).
 *
 * Vitest runs the `node` environment with no React renderer (see
 * vitest.config.ts), so we cannot mount the real hook. The load-bearing logic is
 * the SWR key derivation — "blank/short query OR no active storage ⇒ empty key ⇒
 * NO fetch", and "key scoped per active storage so a same-WebID storage switch
 * re-scans" — extracted into the pure `podSearchKey` helper and tested directly.
 * A structural guard asserts the hook routes through `useSwrRead` (the instant-
 * nav contract). The React wiring is covered by the build.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { podSearchKey } from "./use-pod-search.js";

const STORAGE_A = "https://alice.example/storage-a/";
const STORAGE_B = "https://alice.example/storage-b/";

describe("podSearchKey — gating + keying", () => {
  it("keys on the active storage + the trimmed, URL-encoded query", () => {
    expect(podSearchKey("budget", STORAGE_A)).toBe(`pod-search:${STORAGE_A}:budget`);
    expect(podSearchKey("  tax return  ", STORAGE_A)).toBe(
      `pod-search:${STORAGE_A}:tax%20return`,
    );
  });

  it("returns an EMPTY key (no fetch) for a blank or too-short query", () => {
    expect(podSearchKey("", STORAGE_A)).toBe("");
    expect(podSearchKey("   ", STORAGE_A)).toBe("");
    expect(podSearchKey("a", STORAGE_A), "a 1-char query is below the min").toBe("");
  });

  it("returns an EMPTY key when no active storage is set yet", () => {
    expect(podSearchKey("budget", undefined)).toBe("");
    expect(podSearchKey("budget", "")).toBe("");
  });

  it("scopes the key PER ACTIVE STORAGE — a same-WebID switch changes the key", () => {
    // The staleness guard: the scan reads the active storage's stores, so the
    // same query under a different storage must map to a DIFFERENT cache slot
    // (else a switch would paint the previous pod's matches).
    const keyA = podSearchKey("budget", STORAGE_A);
    const keyB = podSearchKey("budget", STORAGE_B);
    expect(keyA).not.toBe(keyB);
  });

  it("encodes the query so a `:`-bearing query cannot forge the storage segment", () => {
    // A query literally containing the key separator must stay within its query
    // slot, never spill into / collide with the storage segment.
    const key = podSearchKey("a:b", STORAGE_A);
    expect(key).toBe(`pod-search:${STORAGE_A}:a%3Ab`);
  });
});

describe("use-pod-search structural guard", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "use-pod-search.ts"),
    "utf8",
  );

  it("routes its read model through useSwrRead (instant-nav contract)", () => {
    expect(src.includes("useSwrRead")).toBe(true);
  });

  it("delegates the scan to the bounded, own-pod-only searchPod", () => {
    expect(src.includes("searchPod")).toBe(true);
  });
});
