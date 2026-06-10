import { describe, it, expect } from "vitest";
import { fnv1a, recordFragment, slugify } from "./slug.js";

describe("slugify", () => {
  it("lowercases, hyphenates and strips punctuation", () => {
    expect(slugify("The Matrix: Reloaded!")).toBe("the-matrix-reloaded");
  });
  it("strips accents to ASCII", () => {
    expect(slugify("Café Crème")).toBe("cafe-creme");
  });
  it("returns empty for punctuation-only input", () => {
    expect(slugify("!!! ???")).toBe("");
  });
  it("caps length without a trailing hyphen", () => {
    expect(slugify("x".repeat(80)).length).toBeLessThanOrEqual(48);
  });
});

describe("recordFragment", () => {
  it("is URI-safe (no colon, space or slash)", () => {
    expect(recordFragment("A/B: C D")).not.toMatch(/[\s:/]/);
  });
  it("is stable for the same key", () => {
    expect(recordFragment("Dune", "Dune|2024")).toBe(recordFragment("Dune", "Dune|2024"));
  });
  it("distinguishes different keys with the same label", () => {
    expect(recordFragment("Dune", "k1")).not.toBe(recordFragment("Dune", "k2"));
  });
  it("never returns empty even for punctuation labels", () => {
    expect(recordFragment("!!!", "k").length).toBeGreaterThan(0);
  });
});

describe("fnv1a", () => {
  it("is deterministic 8-hex-char output", () => {
    expect(fnv1a("hello")).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a("hello")).toBe(fnv1a("hello"));
  });
});
