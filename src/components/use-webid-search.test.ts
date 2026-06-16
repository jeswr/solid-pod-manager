// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Tests for the WebID-search hooks' GATING + KEYING logic (`use-webid-search.ts`).
 *
 * Vitest runs the `node` environment with no DOM / React renderer (see
 * vitest.config.ts), so we cannot mount the real hooks. The load-bearing logic
 * is the SWR key derivation — "feature off OR blank query ⇒ empty key ⇒ NO
 * fetch" — which is extracted into the pure `searchKey` / `indexedKey` helpers
 * and tested directly here. A structural guard asserts the hooks actually route
 * through those helpers and gate on `isWebIdIndexEnabled`, so the gating cannot
 * silently regress. The React wiring is covered by the `.test.tsx` render test +
 * the build.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexedKey, searchKey } from "./use-webid-search.js";

describe("searchKey — gating + keying", () => {
  it("keys on the trimmed query when enabled", () => {
    expect(searchKey("ada", true)).toBe("webid-search:ada");
    expect(searchKey("  ada lovelace  ", true)).toBe("webid-search:ada lovelace");
  });

  it("returns an EMPTY key (no fetch) when the feature is disabled", () => {
    expect(searchKey("ada", false)).toBe("");
  });

  it("returns an EMPTY key (no fetch) for a blank query even when enabled", () => {
    expect(searchKey("", true)).toBe("");
    expect(searchKey("   ", true)).toBe("");
  });
});

describe("indexedKey — gating + keying", () => {
  it("keys on the WebID when enabled", () => {
    expect(indexedKey("https://a.pod/card#me", true)).toBe(
      "webid-indexed:https://a.pod/card#me",
    );
  });

  it("returns an EMPTY key when disabled or no WebID", () => {
    expect(indexedKey("https://a.pod/card#me", false)).toBe("");
    expect(indexedKey(undefined, true)).toBe("");
    expect(indexedKey("   ", true)).toBe("");
  });
});

describe("use-webid-search — structural: gates on the feature flag", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "use-webid-search.ts"),
    "utf8",
  );

  it("derives keys via searchKey/indexedKey gated on isWebIdIndexEnabled", () => {
    expect(src.includes("searchKey(q, isWebIdIndexEnabled)")).toBe(true);
    expect(src.includes("indexedKey(id, isWebIdIndexEnabled)")).toBe(true);
  });

  it("guards the fetcher against a null client (feature off / inert)", () => {
    // Both fetchers must short-circuit when webIdIndexClient is null.
    expect(/if \(!webIdIndexClient/.test(src)).toBe(true);
  });
});
