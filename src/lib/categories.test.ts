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

  it("maps a sched:SchedulableEvent poll to Calendar (not Other data)", () => {
    // #94 G3: the Schedule app + SolidOS-interop register this class; it must
    // surface under Calendar, not the Uncategorised fallback.
    expect(
      categoryForClass("http://www.w3.org/ns/pim/schedule#SchedulableEvent").id,
    ).toBe("calendar");
  });

  it("resolves a bare foaf:Person to Identity, not Contacts (priority order)", () => {
    expect(categoryForClass("http://xmlns.com/foaf/0.1/Person").id).toBe("identity");
  });

  // Cross-app interop regression (interop test 2026-06-16): every suite pod-app's
  // PRIMARY registered class must resolve to a real category, NOT the Uncategorised
  // "Other data" fallback. A future edit dropping one of these mappings would let that
  // app's data fall into "Other" even though the Type Index still discovers it (the
  // exact trap that hid pod-docs' documents). Each row is one suite app's forClass IRI.
  it.each([
    // app, primary registered forClass IRI, expected category id
    ["Pod Music", "http://purl.org/ontology/mo/Track", "media"],
    ["Pod Photos", "https://schema.org/Photograph", "media"],
    ["Pod Money", "https://TBD.example/solid/finance#Transaction", "finance"],
    ["Pod Health", "https://TBD.example/solid/health#HealthRecord", "health"],
    ["Pod Mail", "http://schema.org/EmailMessage", "social"],
    ["Pod Chat", "https://w3id.org/jeswr/pod-chat#ChatRoom", "social"],
    ["Pod Docs", "https://w3id.org/jeswr/pod-docs#Document", "documents"],
  ])("maps the %s primary class %s to the %s category", (_app, classIri, expectedId) => {
    const category = categoryForClass(classIri);
    expect(category.id).toBe(expectedId);
    // belt-and-braces: it must NOT be the Uncategorised fallback
    expect(category.id).not.toBe(UNCATEGORISED.id);
  });

  it("falls back to the Other bucket for unrecognised classes", () => {
    expect(categoryForClass("https://example.com/UnknownThing")).toBe(UNCATEGORISED);
  });
});
