// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, expect, it } from "vitest";
import { formatLiteral, formatDuration, looksLikeMarkdown } from "./literal-format.js";

const XSD = "http://www.w3.org/2001/XMLSchema#";
// Pin the locale so Intl output is deterministic across machines/CI.
const LOCALE = "en-GB";

describe("formatLiteral", () => {
  it("echoes a plain string (no datatype) unchanged", () => {
    expect(formatLiteral({ value: "hello" })).toEqual({ text: "hello", kind: "plain" });
  });

  it("echoes xsd:string unchanged", () => {
    expect(formatLiteral({ value: "hello", datatype: `${XSD}string` }, LOCALE)).toEqual({
      text: "hello",
      kind: "plain",
    });
  });

  it("formats xsd:date without time, timezone-stable (no off-by-one)", () => {
    const out = formatLiteral({ value: "2026-06-13", datatype: `${XSD}date` }, LOCALE);
    expect(out.kind).toBe("date");
    expect(out.text).toBe("13 Jun 2026");
  });

  it("formats an xsd:date carrying a timezone by its date part", () => {
    const out = formatLiteral({ value: "2026-01-01Z", datatype: `${XSD}date` }, LOCALE);
    expect(out.kind).toBe("date");
    expect(out.text).toBe("1 Jan 2026");
  });

  it("formats xsd:dateTime with date + time", () => {
    const out = formatLiteral(
      { value: "2026-06-13T09:30:00Z", datatype: `${XSD}dateTime` },
      LOCALE,
    );
    expect(out.kind).toBe("dateTime");
    expect(out.text).toMatch(/13 Jun 2026/);
    expect(out.text).toMatch(/\d{2}:\d{2}/);
  });

  it("formats xsd:time", () => {
    const out = formatLiteral({ value: "14:05:00", datatype: `${XSD}time` }, LOCALE);
    expect(out.kind).toBe("time");
    expect(out.text).toBe("14:05");
  });

  it("formats xsd:boolean as Yes/No (true/false and 1/0)", () => {
    expect(formatLiteral({ value: "true", datatype: `${XSD}boolean` }).text).toBe("Yes");
    expect(formatLiteral({ value: "false", datatype: `${XSD}boolean` }).text).toBe("No");
    expect(formatLiteral({ value: "1", datatype: `${XSD}boolean` }).text).toBe("Yes");
    expect(formatLiteral({ value: "0", datatype: `${XSD}boolean` }).text).toBe("No");
    expect(formatLiteral({ value: "true", datatype: `${XSD}boolean` }).kind).toBe("boolean");
  });

  it("formats numeric datatypes with locale grouping", () => {
    expect(formatLiteral({ value: "1234567", datatype: `${XSD}integer` }, LOCALE).text).toBe(
      "1,234,567",
    );
    expect(formatLiteral({ value: "3.5", datatype: `${XSD}decimal` }, LOCALE).text).toBe("3.5");
    expect(formatLiteral({ value: "1000", datatype: `${XSD}double` }, LOCALE).kind).toBe("number");
  });

  it("surfaces the language tag for rdf:langString and keeps the text", () => {
    const out = formatLiteral({
      value: "Bonjour",
      datatype: "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString",
      language: "fr",
    });
    expect(out).toEqual({ text: "Bonjour", kind: "lang", language: "fr" });
  });

  it("treats a literal with a language tag as lang even if datatype is absent", () => {
    expect(formatLiteral({ value: "Hi", language: "en" })).toEqual({
      text: "Hi",
      kind: "lang",
      language: "en",
    });
  });

  it("echoes the raw value (plain) when a typed value does not parse", () => {
    expect(formatLiteral({ value: "not-a-date", datatype: `${XSD}date` }, LOCALE)).toEqual({
      text: "not-a-date",
      kind: "plain",
    });
    expect(formatLiteral({ value: "NaN", datatype: `${XSD}integer` }, LOCALE)).toEqual({
      text: "NaN",
      kind: "plain",
    });
    expect(formatLiteral({ value: "maybe", datatype: `${XSD}boolean` })).toEqual({
      text: "maybe",
      kind: "plain",
    });
  });

  it("echoes the raw value for unknown datatypes", () => {
    expect(
      formatLiteral({ value: "x", datatype: "https://example.com/custom" }),
    ).toEqual({ text: "x", kind: "plain" });
  });
});

describe("formatDuration", () => {
  it("formats hours and minutes", () => {
    expect(formatDuration("PT1H30M")).toBe("1 hr 30 mins");
  });

  it("formats a single unit with correct pluralisation", () => {
    expect(formatDuration("PT1H")).toBe("1 hr");
    expect(formatDuration("PT2H")).toBe("2 hrs");
    expect(formatDuration("PT1M")).toBe("1 min");
  });

  it("formats days, years and weeks", () => {
    expect(formatDuration("P1Y2M3D")).toBe("1 yr 2 mos 3 days");
    expect(formatDuration("P2W")).toBe("2 wks");
  });

  it("handles a negative duration", () => {
    expect(formatDuration("-PT30M")).toBe("−30 mins");
  });

  it("formats a zero duration", () => {
    expect(formatDuration("PT0S")).toBe("0 sec");
  });

  it("returns undefined for a non-duration string", () => {
    expect(formatDuration("not a duration")).toBeUndefined();
    expect(formatDuration("P")).toBeUndefined();
  });

  it("is exposed through formatLiteral for xsd:duration", () => {
    const out = formatLiteral({ value: "PT1H30M", datatype: `${XSD}duration` });
    expect(out).toEqual({ text: "1 hr 30 mins", kind: "duration" });
  });
});

describe("looksLikeMarkdown", () => {
  it("detects ATX headings", () => {
    expect(looksLikeMarkdown("# Title\nbody")).toBe(true);
  });

  it("detects list items", () => {
    expect(looksLikeMarkdown("- one\n- two")).toBe(true);
    expect(looksLikeMarkdown("1. first")).toBe(true);
  });

  it("detects fenced code, blockquotes and thematic breaks", () => {
    expect(looksLikeMarkdown("```\ncode\n```")).toBe(true);
    expect(looksLikeMarkdown("> quote")).toBe(true);
    expect(looksLikeMarkdown("---")).toBe(true);
  });

  it("detects a link combined with emphasis in prose", () => {
    expect(looksLikeMarkdown("see **this** [link](https://x.example)")).toBe(true);
  });

  it("does not flag plain prose with a stray asterisk", () => {
    expect(looksLikeMarkdown("rated 5 * stars and it was fine")).toBe(false);
  });

  it("does not flag a single plain line", () => {
    expect(looksLikeMarkdown("just a normal sentence.")).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(looksLikeMarkdown("")).toBe(false);
  });
});
