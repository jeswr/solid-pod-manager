// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Content-line folding for the iCalendar (RFC 5545 §3.1) and vCard (RFC 6350
 * §3.2) serialisers. The spec limit is **75 octets** (UTF-8 bytes), not
 * characters — a naive char-length fold would emit over-long lines for
 * non-ASCII titles/names and hurt interoperability with real clients. This
 * folds on UTF-8 byte boundaries (never mid-code-point) with a CRLF + a single
 * leading space for each continuation. Shared so both serialisers fold
 * identically (DRY).
 */

/** UTF-8 byte length of a single code point (`String.fromCodePoint`-able). */
function codePointBytes(cp: number): number {
  if (cp <= 0x7f) return 1;
  if (cp <= 0x7ff) return 2;
  if (cp <= 0xffff) return 3;
  return 4;
}

/**
 * Fold one logical content line to a maximum of 75 octets per physical line,
 * continuing with `CRLF + " "`. Folds only on code-point boundaries so multi-
 * byte characters are never split. The continuation's leading space counts
 * toward that line's 75-octet budget (so a continuation carries up to 74 octets
 * of payload), matching how unfolders strip exactly one leading space.
 */
export function foldContentLine(line: string): string {
  const cps = Array.from(line); // split into code points (surrogate-safe)
  const out: string[] = [];
  let buf = "";
  let bytes = 0;
  let budget = 75; // first physical line has no leading space

  for (const ch of cps) {
    const cb = codePointBytes(ch.codePointAt(0) as number);
    if (bytes + cb > budget) {
      out.push(buf);
      buf = ch;
      bytes = cb;
      budget = 74; // continuation lines spend one octet on the leading space
    } else {
      buf += ch;
      bytes += cb;
    }
  }
  out.push(buf);
  return out.length === 1 ? out[0] : out.map((p, i) => (i === 0 ? p : ` ${p}`)).join("\r\n");
}
