// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { staticSource, sourceFor, register } from "./autocomplete.js";

describe("autocomplete — static source + registry", () => {
  it("filters by query (label or value), capped at limit", () => {
    const src = staticSource("colours", [
      { value: "#f00", label: "Red" },
      { value: "#0f0", label: "Green" },
      { value: "#00f", label: "Blue" },
    ]);
    expect(src.suggest("blu", 10)).toEqual([{ value: "#00f", label: "Blue" }]);
    expect(src.suggest("", 2)).toHaveLength(2);
  });

  it("ships the schema:eventStatus enum", () => {
    const src = sourceFor("schema:eventStatus");
    expect(src).toBeDefined();
    const out = src ? src.suggest("cancel", 5) : [];
    expect(out).toEqual([{ value: "https://schema.org/EventCancelled", label: "Cancelled" }]);
  });

  it("returns undefined for an unknown source id", () => {
    expect(sourceFor("nope")).toBeUndefined();
    expect(sourceFor(undefined)).toBeUndefined();
  });

  it("register adds a runtime source", () => {
    register(staticSource("custom", [{ value: "v", label: "L" }]));
    expect(sourceFor("custom")?.suggest("", 1)).toEqual([{ value: "v", label: "L" }]);
  });
});
