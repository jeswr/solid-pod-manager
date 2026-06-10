import { describe, expect, it } from "vitest";
import { parseMarkdown, parseInline, type Block } from "./markdown.js";

describe("parseInline", () => {
  it("returns a single text node for plain text", () => {
    expect(parseInline("hello world")).toEqual([{ type: "text", value: "hello world" }]);
  });

  it("parses bold, italic and inline code", () => {
    expect(parseInline("a **b** c")).toEqual([
      { type: "text", value: "a " },
      { type: "strong", children: [{ type: "text", value: "b" }] },
      { type: "text", value: " c" },
    ]);
    expect(parseInline("_i_")).toEqual([{ type: "em", children: [{ type: "text", value: "i" }] }]);
    expect(parseInline("`x = 1`")).toEqual([{ type: "code", value: "x = 1" }]);
  });

  it("keeps emphasis literal inside inline code (code wins leftmost)", () => {
    expect(parseInline("`**not bold**`")).toEqual([{ type: "code", value: "**not bold**" }]);
  });

  it("parses links and preserves the href verbatim for the renderer to sanitize", () => {
    expect(parseInline("[home](https://x.example)")).toEqual([
      { type: "link", href: "https://x.example", children: [{ type: "text", value: "home" }] },
    ]);
    // A dangerous scheme is kept in the AST (href runs to the first ')'); safety
    // is enforced at render time by safeLinkHref, which blocks the javascript: scheme.
    const danger = parseInline("[x](javascript:alert)")[0] as { type: string; href: string };
    expect(danger.type).toBe("link");
    expect(danger.href).toMatch(/^javascript:/);
  });

  it("nests emphasis inside strong", () => {
    const out = parseInline("**bold _and italic_**");
    expect(out[0]).toMatchObject({ type: "strong" });
    const strong = out[0] as { children: unknown[] };
    expect(strong.children).toContainEqual({
      type: "em",
      children: [{ type: "text", value: "and italic" }],
    });
  });
});

describe("parseMarkdown", () => {
  it("parses headings by level", () => {
    expect(parseMarkdown("# Title")).toEqual<Block[]>([
      { type: "heading", level: 1, children: [{ type: "text", value: "Title" }] },
    ]);
    expect((parseMarkdown("### Sub")[0] as { level: number }).level).toBe(3);
  });

  it("groups blank-line-separated paragraphs", () => {
    const out = parseMarkdown("one\ntwo\n\nthree");
    expect(out).toHaveLength(2);
    expect(out[0].type).toBe("paragraph");
    expect(out[1].type).toBe("paragraph");
  });

  it("parses unordered and ordered lists", () => {
    const ul = parseMarkdown("- a\n- b") as [Block];
    expect(ul[0]).toMatchObject({ type: "list", ordered: false });
    expect((ul[0] as { items: unknown[] }).items).toHaveLength(2);

    const ol = parseMarkdown("1. first\n2. second")[0];
    expect(ol).toMatchObject({ type: "list", ordered: true });
  });

  it("parses fenced code blocks verbatim (no inline parsing inside)", () => {
    const out = parseMarkdown("```\nconst x = `**y**`\n```");
    expect(out).toEqual<Block[]>([{ type: "code", value: "const x = `**y**`" }]);
  });

  it("parses blockquotes and thematic breaks", () => {
    expect(parseMarkdown("> quoted")[0]).toMatchObject({ type: "blockquote" });
    expect(parseMarkdown("---")[0]).toEqual({ type: "hr" });
  });

  it("treats an unclosed fence as a code block to EOF (never throws)", () => {
    const out = parseMarkdown("```\nunclosed");
    expect(out).toEqual<Block[]>([{ type: "code", value: "unclosed" }]);
  });

  it("returns an empty list for empty input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n  \n")).toEqual([]);
  });
});
