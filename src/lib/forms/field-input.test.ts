// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { controlFor, toControlValue } from "./field-input.js";

describe("controlFor", () => {
  it("maps kinds to controls + input types", () => {
    expect(controlFor("text")).toEqual({ control: "input", inputType: "text" });
    expect(controlFor("textarea")).toEqual({ control: "textarea" });
    expect(controlFor("boolean")).toEqual({ control: "checkbox" });
    expect(controlFor("choice")).toEqual({ control: "select" });
    expect(controlFor("url")).toEqual({ control: "input", inputType: "url" });
    expect(controlFor("date")).toEqual({ control: "input", inputType: "date" });
    expect(controlFor("datetime")).toEqual({ control: "input", inputType: "datetime-local" });
    expect(controlFor("number")).toEqual({ control: "input", inputType: "number" });
  });
});

describe("toControlValue", () => {
  it("formats an ISO dateTime for a datetime-local input", () => {
    expect(toControlValue("datetime", "2026-07-01T09:30:00.000Z")).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
    );
  });
  it("passes non-datetime values through unchanged", () => {
    expect(toControlValue("text", "hello")).toBe("hello");
    expect(toControlValue("date", "2026-07-01")).toBe("2026-07-01");
  });
  it("passes an unparsable datetime through", () => {
    expect(toControlValue("datetime", "")).toBe("");
    expect(toControlValue("datetime", "garbage")).toBe("garbage");
  });
});
