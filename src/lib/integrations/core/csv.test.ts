import { describe, it, expect } from "vitest";
import { parseCsv, parseCsvRows } from "./csv.js";

describe("parseCsvRows", () => {
  it("splits simple comma-separated rows", () => {
    expect(parseCsvRows("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("keeps quoted fields with embedded commas", () => {
    expect(parseCsvRows('name,note\n"Doe, John","hi, there"')).toEqual([
      ["name", "note"],
      ["Doe, John", "hi, there"],
    ]);
  });

  it("unescapes doubled quotes inside quoted fields", () => {
    expect(parseCsvRows('q\n"She said ""hi"""')).toEqual([["q"], ['She said "hi"']]);
  });

  it("handles embedded newlines inside quotes", () => {
    expect(parseCsvRows('a\n"line1\nline2"')).toEqual([["a"], ["line1\nline2"]]);
  });

  it("treats CRLF and bare CR as line breaks", () => {
    expect(parseCsvRows("a,b\r\n1,2\r3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("strips a UTF-8 BOM and ignores a trailing newline", () => {
    expect(parseCsvRows("﻿a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("returns an empty matrix for empty input", () => {
    expect(parseCsvRows("")).toEqual([]);
    expect(parseCsvRows("\n")).toEqual([]);
  });

  it("preserves empty trailing fields", () => {
    expect(parseCsvRows("a,b,c\n1,,3")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });

  it("supports a custom delimiter (tab)", () => {
    expect(parseCsvRows("a\tb\n1\t2", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("parseCsv", () => {
  it("keys rows by trimmed header names", () => {
    const { headers, rows } = parseCsv("Title , Date\nDune,2024-01-02");
    expect(headers).toEqual(["Title", "Date"]);
    expect(rows).toEqual([{ Title: "Dune", Date: "2024-01-02" }]);
  });

  it("pads short rows and ignores extra cells", () => {
    const { rows } = parseCsv("a,b,c\n1\n1,2,3,4");
    expect(rows[0]).toEqual({ a: "1", b: "", c: "" });
    expect(rows[1]).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("returns no rows for a header-only file", () => {
    expect(parseCsv("a,b,c").rows).toEqual([]);
  });
});
