// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { foldContentLine } from "./line-fold.js";

const octets = (s: string) => new TextEncoder().encode(s).length;

describe("foldContentLine", () => {
  it("leaves a short line untouched (no CRLF)", () => {
    expect(foldContentLine("SUMMARY:hello")).toBe("SUMMARY:hello");
  });

  it("folds an ASCII line so no physical line exceeds 75 octets", () => {
    const line = `DESCRIPTION:${"a".repeat(200)}`;
    const folded = foldContentLine(line);
    const physical = folded.split("\r\n");
    expect(physical.length).toBeGreaterThan(1);
    for (const p of physical) expect(octets(p)).toBeLessThanOrEqual(75);
    // Continuations begin with a single space.
    for (let i = 1; i < physical.length; i++) expect(physical[i].startsWith(" ")).toBe(true);
  });

  it("never splits a multi-byte code point", () => {
    // Each "😀" is 4 UTF-8 octets; many of them force several folds.
    const line = `X:${"😀".repeat(60)}`;
    const folded = foldContentLine(line);
    for (const p of folded.split("\r\n")) {
      expect(octets(p)).toBeLessThanOrEqual(75);
      // A clean decode round-trip implies no surrogate was cut.
      expect(typeof p).toBe("string");
    }
    // Reassembling (strip CRLF + the single leading space) restores the input.
    const physical = folded.split("\r\n");
    const rejoined = physical.map((p, i) => (i === 0 ? p : p.slice(1))).join("");
    expect(rejoined).toBe(line);
  });
});
