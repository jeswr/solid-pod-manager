// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * vCard (RFC 6350) import/export for the Contacts app.
 *
 * **Why a focused in-repo (de)serialiser, not a dependency.** The fields the
 * Contacts app stores (`FN` / `EMAIL` / `TEL` / `NOTE`) are a small,
 * well-specified slice of RFC 6350. A hand-written parser/serialiser for *this
 * slice* — with correct line-unfolding and value-escaping — is smaller and
 * safer to review than pulling a general vCard library (and its transitive
 * surface) into a Solid client. Supports vCard 3.0 and 4.0 on import (both are
 * common in `.vcf` exports); emits 4.0.
 *
 * Pure (no I/O, no RDF): operates on the plain `Contact` shape the app already
 * uses, so it round-trips through the same type the `ProductivityStore` reads
 * and writes.
 */
import type { Contact } from "./contacts.js";
import { foldContentLine } from "./line-fold.js";

/** Escape a vCard TEXT value (RFC 6350 §3.4): backslash, comma, semicolon, newline. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n?/g, "\n") // normalise CR / CRLF to a single LF first
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/**
 * Split a structured vCard value (e.g. `N`'s `family;given;…`) on unescaped
 * semicolons, tracking the escape state character-by-character so `\;` is a
 * literal and `\\;` is an escaped backslash *followed by* a delimiter. Each
 * returned segment is still escaped (the caller unescapes).
 */
function splitStructured(value: string): string[] {
  const out: string[] = [];
  let buf = "";
  let escaped = false;
  for (const c of value) {
    if (escaped) {
      buf += `\\${c}`;
      escaped = false;
    } else if (c === "\\") {
      escaped = true;
    } else if (c === ";") {
      out.push(buf);
      buf = "";
    } else {
      buf += c;
    }
  }
  if (escaped) buf += "\\"; // a trailing lone backslash — keep it
  out.push(buf);
  return out;
}

/** Reverse {@link escapeText} for a parsed TEXT value. */
function unescapeText(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\" && i + 1 < value.length) {
      const n = value[++i];
      out += n === "n" || n === "N" ? "\n" : n;
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * Unfold raw text into logical lines. Joins the two continuation forms seen in
 * `.vcf` files: RFC 6350 folding (a line starting with space/tab) and vCard 3.0
 * QUOTED-PRINTABLE soft line-breaks (a line ending in `=`, where the next line
 * continues the encoded run with no leading space).
 */
function unfold(text: string): string[] {
  // Strip a leading UTF-8 BOM (common in Windows/Outlook .vcf exports) so the
  // first property name is `BEGIN`, not a BOM-prefixed token.
  const raw = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  const lines: string[] = [];
  let qpOpen = false;
  for (const line of raw) {
    if (qpOpen && lines.length > 0) {
      // Continuation of a quoted-printable run: a soft break means "drop the
      // trailing `=` and the line break", so strip the `=` and concatenate.
      const prev = lines[lines.length - 1];
      lines[lines.length - 1] = prev.replace(/=$/, "") + line;
    } else if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
    // A trailing `=` on an ENCODING=QUOTED-PRINTABLE line means "continue".
    const tail = lines[lines.length - 1] ?? "";
    qpOpen = /quoted-printable/i.test(tail) && tail.endsWith("=");
  }
  return lines;
}

/**
 * Map a vCard `CHARSET` parameter value to a `TextDecoder` label, defaulting to
 * UTF-8. Older 3.0 exports commonly use ISO-8859-1 / Windows-1252, so those are
 * recognised explicitly; an unknown charset falls back to UTF-8.
 */
function decoderLabel(charset: string | undefined): string {
  const c = (charset ?? "").trim().toLowerCase();
  if (c === "iso-8859-1" || c === "latin1" || c === "iso8859-1") return "iso-8859-1";
  if (c === "windows-1252" || c === "cp1252") return "windows-1252";
  return "utf-8";
}

/**
 * Decode a QUOTED-PRINTABLE value (`=XX` octets, `=` soft line-breaks). Used for
 * vCard 3.0 exports that carry `ENCODING=QUOTED-PRINTABLE` (common from older
 * address books). The decoded bytes are interpreted with the declared
 * `charset` (UTF-8 by default).
 */
function decodeQuotedPrintable(value: string, charset?: string): string {
  // Join soft line breaks ("=" at end of an encoded run).
  const joined = value.replace(/=\r?\n/g, "").replace(/=$/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === "=" && i + 2 < joined.length) {
      const hex = joined.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(joined.charCodeAt(i) & 0xff);
  }
  try {
    return new TextDecoder(decoderLabel(charset)).decode(Uint8Array.from(bytes));
  } catch {
    try {
      return new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
    } catch {
      return joined;
    }
  }
}

/**
 * Split a content line into property name (upper, sans params), the raw value,
 * and the (lower-cased) parameter segment so callers can honour `ENCODING`.
 */
function splitLine(line: string): { name: string; params: string; value: string } | undefined {
  const idx = line.indexOf(":");
  if (idx < 0) return undefined;
  const namePart = line.slice(0, idx);
  const value = line.slice(idx + 1);
  const segs = namePart.split(";");
  // A property may carry a group prefix (`item1.EMAIL`); the actual property is
  // the segment after the last `.`. Strip it so grouped exports still match.
  const nameToken = segs[0].trim();
  const name = (nameToken.includes(".") ? nameToken.slice(nameToken.lastIndexOf(".") + 1) : nameToken).toUpperCase();
  // Keep the parameter segment in its original case; callers match case-
  // insensitively only on the parameter names/known values they care about.
  const params = segs.slice(1).join(";");
  return { name, params, value };
}

/** Decode a property value per its parameters (quoted-printable + charset). */
function decodeValue(value: string, params: string): string {
  if (/quoted-printable/i.test(params)) {
    const charset = /charset=([^;]+)/i.exec(params)?.[1];
    return decodeQuotedPrintable(value, charset);
  }
  return value;
}

// ── export ───────────────────────────────────────────────────────────────

function vcardBlock(contact: Contact): string[] {
  const lines = ["BEGIN:VCARD", "VERSION:4.0"];
  const fn = contact.fn?.trim() || "Unnamed contact";
  lines.push(foldContentLine(`FN:${escapeText(fn)}`));
  // N (structured name) is required in 3.0 and good practice in 4.0; derive a
  // best-effort family/given split from the formatted name.
  const parts = fn.split(/\s+/);
  const family = parts.length > 1 ? parts[parts.length - 1] : "";
  const given = parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0] ?? "";
  lines.push(foldContentLine(`N:${escapeText(family)};${escapeText(given)};;;`));
  if (contact.email) lines.push(foldContentLine(`EMAIL:${escapeText(contact.email)}`));
  // vCard 4.0 TEL defaults to a URI value type; free-form numbers (with spaces)
  // are not valid URIs, so declare VALUE=text to keep them verbatim.
  if (contact.phone) lines.push(foldContentLine(`TEL;VALUE=text:${escapeText(contact.phone)}`));
  if (contact.note) lines.push(foldContentLine(`NOTE:${escapeText(contact.note)}`));
  lines.push("END:VCARD");
  return lines;
}

/** Serialise one or more contacts into a `.vcf` document (one VCARD each). */
export function exportVCard(contacts: readonly Contact[]): string {
  const lines: string[] = [];
  for (const c of contacts) lines.push(...vcardBlock(c));
  return `${lines.join("\r\n")}\r\n`;
}

// ── import ───────────────────────────────────────────────────────────────

/** Strip a `mailto:` / `tel:` scheme an exporter may have left on the value. */
function stripScheme(value: string): string {
  const m = /^(?:mailto|tel):(.*)$/i.exec(value.trim());
  if (!m) return value.trim();
  try {
    return decodeURIComponent(m[1]);
  } catch {
    // Malformed percent-encoding — keep the scheme-stripped raw value rather
    // than throwing and failing the whole import.
    return m[1];
  }
}

/**
 * Parse a `.vcf` document into contacts. Resilient: unknown properties are
 * ignored; a card with no usable name falls back to its email/phone so a row is
 * never silently dropped. Handles multiple cards in one file (vCard 3.0/4.0).
 */
export function importVCard(text: string): Contact[] {
  const contacts: Contact[] = [];
  let inCard = false;
  let fn: string | undefined;
  let nFamily: string | undefined;
  let nGiven: string | undefined;
  let email: string | undefined;
  let phone: string | undefined;
  let note: string | undefined;

  const flush = () => {
    const fromN = [nGiven, nFamily].filter(Boolean).join(" ") || undefined;
    // Treat a blank FN as absent so the N / email / phone fallback still applies.
    const fnTrimmed = fn?.trim() || undefined;
    const name = fnTrimmed ?? fromN ?? email ?? phone;
    if (name === undefined && !email && !phone) return; // nothing usable
    contacts.push({
      fn: (name ?? "").trim(),
      email,
      phone,
      note,
    });
  };

  for (const line of unfold(text)) {
    const parsed = splitLine(line);
    if (!parsed) continue;
    const { name, params } = parsed;
    const value = decodeValue(parsed.value, params);

    if (name === "BEGIN" && value.trim().toUpperCase() === "VCARD") {
      inCard = true;
      fn = nFamily = nGiven = email = phone = note = undefined;
      continue;
    }
    if (name === "END" && value.trim().toUpperCase() === "VCARD") {
      if (inCard) flush();
      inCard = false;
      continue;
    }
    if (!inCard) continue;

    switch (name) {
      case "FN":
        fn = unescapeText(value);
        break;
      case "N": {
        // family;given;additional;prefix;suffix
        const segs = splitStructured(value);
        nFamily = unescapeText(segs[0] ?? "").trim() || undefined;
        nGiven = unescapeText(segs[1] ?? "").trim() || undefined;
        break;
      }
      case "EMAIL":
        if (!email) email = stripScheme(unescapeText(value)) || undefined;
        break;
      case "TEL":
        if (!phone) phone = stripScheme(unescapeText(value)) || undefined;
        break;
      case "NOTE":
        if (!note) note = unescapeText(value) || undefined;
        break;
    }
  }

  return contacts;
}
