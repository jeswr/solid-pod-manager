/**
 * A tiny, safe Markdown parser for Notes (the editor accepts Markdown; this
 * lets the read/preview render it). It produces a small typed AST — the
 * renderer turns that into React elements, so there is **no HTML string and no
 * `dangerouslySetInnerHTML` anywhere**: the XSS surface a Markdown feature
 * usually adds simply does not exist here. Link safety is enforced at render
 * time via `safeLinkHref` (scheme allowlist).
 *
 * Supported (a deliberate, common subset — documented so expectations are
 * honest): ATX headings (`#`..`######`), fenced code blocks (```), blockquotes
 * (`>`), unordered (`-`/`*`/`+`) and ordered (`1.`) lists, thematic breaks
 * (`---`), and paragraphs; inline `code`, `**bold**`/`__bold__`,
 * `*italic*`/`_italic_`, and `[text](url)` links. Unrecognised syntax renders
 * as its literal text (never dropped, never executed).
 */

/** An inline run inside a block. */
export type Inline =
  | { type: "text"; value: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; value: string }
  | { type: "link"; href: string; children: Inline[] };

/** A top-level block. */
export type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "code"; value: string }
  | { type: "blockquote"; children: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "hr" };

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^```/;
const HR = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const UL_ITEM = /^[-*+]\s+(.*)$/;
const OL_ITEM = /^\d+\.\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

/** Parse Markdown source into a block AST. Never throws; bounded by input length. */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line — skip.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block: collect until the closing fence (or EOF).
    if (FENCE.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      blocks.push({ type: "code", value: body.join("\n") });
      continue;
    }

    // Thematic break.
    if (HR.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Heading.
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: "heading", level, children: parseInline(h[2]) });
      i++;
      continue;
    }

    // Blockquote: consecutive `>` lines, inline-joined.
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        quoted.push(QUOTE.exec(lines[i])![1]);
        i++;
      }
      blocks.push({ type: "blockquote", children: parseInline(quoted.join("\n")) });
      continue;
    }

    // List (ordered or unordered) — a run of same-kind item lines.
    const ulFirst = UL_ITEM.test(line);
    const olFirst = OL_ITEM.test(line);
    if (ulFirst || olFirst) {
      const ordered = olFirst;
      const re = ordered ? OL_ITEM : UL_ITEM;
      const items: Inline[][] = [];
      while (i < lines.length && re.test(lines[i])) {
        items.push(parseInline(re.exec(lines[i])![1]));
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // Paragraph: consecutive non-blank lines that aren't another block start.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !FENCE.test(lines[i]) &&
      !HR.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !QUOTE.test(lines[i]) &&
      !UL_ITEM.test(lines[i]) &&
      !OL_ITEM.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ type: "paragraph", children: parseInline(para.join("\n")) });
  }

  return blocks;
}

// Inline matchers, tried leftmost-first. `code` wins over emphasis so
// `` `**x**` `` stays literal.
const INLINE_CODE = /`([^`]+)`/;
const LINK = /\[([^\]]*)\]\(([^)\s]+)\)/;
const STRONG = /\*\*([^*]+)\*\*|__([^_]+)__/;
const EM = /\*([^*]+)\*|_([^_]+)_/;

/** Parse a string of inline Markdown into inline nodes. */
export function parseInline(input: string): Inline[] {
  if (input === "") return [];
  const out: Inline[] = [];
  let rest = input;

  while (rest.length > 0) {
    const candidates: { index: number; build: () => { node: Inline; end: number } }[] = [];

    const code = INLINE_CODE.exec(rest);
    if (code)
      candidates.push({
        index: code.index,
        build: () => ({ node: { type: "code", value: code[1] }, end: code.index + code[0].length }),
      });

    const link = LINK.exec(rest);
    if (link)
      candidates.push({
        index: link.index,
        build: () => ({
          node: { type: "link", href: link[2], children: parseInline(link[1]) },
          end: link.index + link[0].length,
        }),
      });

    const strong = STRONG.exec(rest);
    if (strong)
      candidates.push({
        index: strong.index,
        build: () => ({
          node: { type: "strong", children: parseInline(strong[1] ?? strong[2]) },
          end: strong.index + strong[0].length,
        }),
      });

    const em = EM.exec(rest);
    if (em)
      candidates.push({
        index: em.index,
        build: () => ({
          node: { type: "em", children: parseInline(em[1] ?? em[2]) },
          end: em.index + em[0].length,
        }),
      });

    if (candidates.length === 0) {
      out.push({ type: "text", value: rest });
      break;
    }

    // Earliest match wins; ties resolve by candidate order (code, link, strong, em).
    candidates.sort((a, b) => a.index - b.index);
    const { index, build } = candidates[0];
    if (index > 0) out.push({ type: "text", value: rest.slice(0, index) });
    const { node, end } = build();
    out.push(node);
    rest = rest.slice(end);
  }

  return out;
}
