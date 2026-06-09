import { describe, it, expect } from "vitest";
import {
  CATEGORIES,
  UNCATEGORISED,
  commonCategories,
  otherCategories,
  categoryById,
  categoryForClass,
} from "./categories.js";

describe("category taxonomy", () => {
  it("exposes the proposed common tier in order (DESIGN.md §3)", () => {
    expect(commonCategories().map((c) => c.id)).toEqual([
      "identity",
      "contacts",
      "health",
      "finance",
      "calendar",
      "media",
    ]);
  });

  it("exposes a non-empty 'other' tail", () => {
    expect(otherCategories().map((c) => c.id)).toContain("documents");
    expect(otherCategories().length).toBeGreaterThan(0);
  });

  it("gives every category a URL-safe id and a privacy assurance (R6)", () => {
    for (const c of [...CATEGORIES, UNCATEGORISED]) {
      expect(c.id).toMatch(/^[a-z0-9-]+$/);
      expect(c.assurance.length).toBeGreaterThan(0);
      expect(c.label.length).toBeGreaterThan(0);
    }
  });

  it("has unique category ids", () => {
    const ids = [...CATEGORIES, UNCATEGORISED].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("categoryById", () => {
  it("resolves known ids including the fallback", () => {
    expect(categoryById("health")?.label).toBe("Health");
    expect(categoryById("other")).toBe(UNCATEGORISED);
  });
  it("returns undefined for an unknown id", () => {
    expect(categoryById("nope")).toBeUndefined();
  });
});

describe("categoryForClass", () => {
  it("maps a known class to its category", () => {
    expect(categoryForClass("https://schema.org/Event").id).toBe("calendar");
    expect(categoryForClass("http://www.w3.org/2006/vcard/ns#AddressBook").id).toBe(
      "contacts",
    );
  });

  it("maps both schema.org URL forms (https and legacy http)", () => {
    expect(categoryForClass("https://schema.org/Invoice").id).toBe("finance");
    expect(categoryForClass("http://schema.org/Invoice").id).toBe("finance");
  });

  it("resolves a bare foaf:Person to Identity, not Contacts (priority order)", () => {
    expect(categoryForClass("http://xmlns.com/foaf/0.1/Person").id).toBe("identity");
  });

  it("falls back to the Other bucket for unrecognised classes", () => {
    expect(categoryForClass("https://example.com/UnknownThing")).toBe(UNCATEGORISED);
  });
});
