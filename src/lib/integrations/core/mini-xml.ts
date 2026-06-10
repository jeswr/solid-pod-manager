/**
 * A minimal, dependency-free reader for the *flat, attribute-only* XML that
 * Apple Health's `export.xml` is built from. It is **not** a general XML
 * parser: it extracts elements with a given tag name and returns their
 * attributes as a string map. That is all the Health export needs (`<Workout
 * .../>`, `<Record .../>` are attribute-only, self-closing or with simple
 * children we ignore), and it avoids bundling a parser for an untrusted,
 * potentially huge file.
 *
 * Security: input is untrusted text. We never resolve entities beyond the five
 * predefined XML ones, never follow DOCTYPE/external entities (a classic XXE
 * vector — we simply ignore DOCTYPE), and only ever return inert strings.
 */

/** One extracted element: its attributes as a (decoded) string map. */
export type XmlAttrs = Readonly<Record<string, string>>;

const DECODE: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Decode the five predefined XML entities plus numeric character refs. */
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return DECODE[body] ?? whole;
  });
}

/**
 * Yield the attribute maps of every `<tag …>` (self-closing or open) element.
 * Open/close nesting is ignored — only the start tag's attributes are read,
 * which is exactly the Apple Health shape. Bounded by `limit`.
 */
export function* extractElements(
  xml: string,
  tag: string,
  limit = Number.POSITIVE_INFINITY,
): Generator<XmlAttrs> {
  // Match `<Tag ...>` or `<Tag .../>`; capture the attribute chunk.
  const re = new RegExp(`<${escapeTag(tag)}((?:\\s[^>]*)?)/?>`, "g");
  let m: RegExpExecArray | null;
  let count = 0;
  // Standard regex `exec` loop (the assignment is intentional).
  while (count < limit && (m = re.exec(xml)) !== null) {
    yield parseAttrs(m[1] ?? "");
    count++;
  }
}

const ATTR_RE = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"|([A-Za-z_:][\w:.-]*)\s*=\s*'([^']*)'/g;

function parseAttrs(chunk: string): XmlAttrs {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  // Standard regex `exec` loop (the assignment is intentional).
  while ((m = ATTR_RE.exec(chunk)) !== null) {
    const name = m[1] ?? m[3];
    const value = m[2] ?? m[4] ?? "";
    if (name) out[name] = decodeXmlEntities(value);
  }
  return out;
}

function escapeTag(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
