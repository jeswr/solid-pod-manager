// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Human-readable rendering of common RDF literal datatypes (SolidOS-parity A2).
 *
 * The generic `RdfViewer` historically printed every literal as its raw lexical
 * form: `2026-06-13T09:00:00Z`, `PT1H30M`, `true`, `42^^xsd:integer`. SolidOS's
 * databrowser humanises these. This pure, DOM- and locale-aware-but-deterministic
 * module turns a literal's lexical value + datatype (+ optional language tag)
 * into a friendly display string, falling back to the raw value when the type is
 * unknown or the value doesn't parse — never throwing, never dropping data.
 *
 * It stays pure (no React, no DOM) so it is node-testable; the date/time/number
 * formatters use `Intl`, which is available in Node. To keep tests deterministic
 * across machines, the formatters accept an explicit `locale`; callers in the UI
 * pass `undefined` to use the user's locale. Markdown detection lives here too
 * (the predicate the `text` viewer uses to decide whether to render Markdown).
 */

const XSD = "http://www.w3.org/2001/XMLSchema#";

/** xsd datatypes we humanise. Anything else → the raw lexical value. */
const XSD_DATE = `${XSD}date`;
const XSD_DATETIME = `${XSD}dateTime`;
const XSD_TIME = `${XSD}time`;
const XSD_DURATION = `${XSD}duration`;
const XSD_BOOLEAN = `${XSD}boolean`;
const XSD_INTEGER = `${XSD}integer`;
const XSD_DECIMAL = `${XSD}decimal`;
const XSD_DOUBLE = `${XSD}double`;
const XSD_FLOAT = `${XSD}float`;
const RDF_LANG_STRING = "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString";

/** A literal's parts as carried from the parsed quad to the formatter. */
export interface LiteralParts {
  /** The lexical value (the quad object's `.value`). */
  value: string;
  /** The datatype IRI (xsd:string when absent). */
  datatype?: string;
  /** BCP-47 language tag for `rdf:langString` literals (e.g. "en", "fr-CA"). */
  language?: string;
}

/**
 * Format a literal for human display, with a tag describing how it was rendered
 * (so the UI can, e.g., show a subtle language chip). Always returns a non-empty
 * display string for non-empty input; unknown/unparsable types echo the raw value.
 */
export interface FormattedLiteral {
  /** The display string. */
  text: string;
  /** What kind of formatting was applied (drives optional UI affordances). */
  kind: "date" | "dateTime" | "time" | "duration" | "boolean" | "number" | "lang" | "plain";
  /** The language tag, when this was a language-tagged string. */
  language?: string;
}

/** Is `dt` one of the numeric xsd datatypes we right-format? */
function isNumericDatatype(dt: string): boolean {
  return dt === XSD_INTEGER || dt === XSD_DECIMAL || dt === XSD_DOUBLE || dt === XSD_FLOAT;
}

/**
 * Parse an ISO-8601 / xsd:duration (`PnYnMnDTnHnMnS`, optional leading `-`) into
 * a friendly string like "1 hr 30 min". Returns `undefined` when it doesn't look
 * like a duration so the caller can fall back to the raw value.
 */
export function formatDuration(value: string): string | undefined {
  const m = /^(-)?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    value.trim(),
  );
  if (!m) return undefined;
  const [, sign, y, mo, w, d, h, min, s] = m;
  const parts: string[] = [];
  const push = (n: string | undefined, unit: string) => {
    if (n && Number(n) !== 0) parts.push(`${Number(n)} ${unit}${Number(n) === 1 ? "" : "s"}`);
  };
  push(y, "yr");
  push(mo, "mo");
  push(w, "wk");
  push(d, "day");
  push(h, "hr");
  push(min, "min");
  push(s, "sec");
  // A duration that parsed but has no non-zero component (e.g. "PT0S") → "0 sec".
  if (parts.length === 0) {
    // Reject a bare "P"/"PT" with nothing at all — not a meaningful duration.
    if (!/\d/.test(value)) return undefined;
    return "0 sec";
  }
  return (sign === "-" ? "−" : "") + parts.join(" ");
}

/** `true`/`false`/`1`/`0` → "Yes"/"No"; otherwise `undefined`. */
function formatBoolean(value: string): string | undefined {
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1") return "Yes";
  if (v === "false" || v === "0") return "No";
  return undefined;
}

/** Format a numeric literal with locale grouping; `undefined` if not a finite number. */
function formatNumber(value: string, locale: string | undefined): string | undefined {
  const n = Number(value.trim());
  if (!Number.isFinite(n)) return undefined;
  return new Intl.NumberFormat(locale).format(n);
}

/** Format an xsd:date (no time) in a friendly, locale-aware way; `undefined` if unparsable. */
function formatDate(value: string, locale: string | undefined): string | undefined {
  // xsd:date may carry a timezone (`2026-06-13Z`); parse the date part only to
  // avoid an off-by-one from local-timezone shifting of a midnight UTC instant.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return undefined;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** Format an xsd:dateTime in a friendly, locale-aware way; `undefined` if unparsable. */
function formatDateTime(value: string, locale: string | undefined): string | undefined {
  const t = Date.parse(value.trim());
  if (Number.isNaN(t)) return undefined;
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(t));
}

/** Format an xsd:time (`HH:MM:SS`); `undefined` if unparsable. */
function formatTime(value: string, locale: string | undefined): string | undefined {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?/.exec(value.trim());
  if (!m) return undefined;
  const [, h, min] = m;
  const date = new Date(Date.UTC(2000, 0, 1, Number(h), Number(min)));
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date);
}

/**
 * Format a literal for display. `locale` is passed through to the `Intl`
 * formatters; pass `undefined` in the UI to use the user's locale, or a fixed
 * tag in tests for determinism. Unknown datatypes / unparsable values echo the
 * raw lexical value (kind `"plain"`), so no information is ever lost.
 */
export function formatLiteral(parts: LiteralParts, locale?: string): FormattedLiteral {
  const { value } = parts;
  const datatype = parts.datatype;

  // Language-tagged string: show the text, surface the tag separately.
  if (parts.language || datatype === RDF_LANG_STRING) {
    return { text: value, kind: "lang", language: parts.language };
  }

  if (!datatype) return { text: value, kind: "plain" };

  switch (datatype) {
    case XSD_DATE: {
      const out = formatDate(value, locale);
      return out ? { text: out, kind: "date" } : { text: value, kind: "plain" };
    }
    case XSD_DATETIME: {
      const out = formatDateTime(value, locale);
      return out ? { text: out, kind: "dateTime" } : { text: value, kind: "plain" };
    }
    case XSD_TIME: {
      const out = formatTime(value, locale);
      return out ? { text: out, kind: "time" } : { text: value, kind: "plain" };
    }
    case XSD_DURATION: {
      const out = formatDuration(value);
      return out ? { text: out, kind: "duration" } : { text: value, kind: "plain" };
    }
    case XSD_BOOLEAN: {
      const out = formatBoolean(value);
      return out ? { text: out, kind: "boolean" } : { text: value, kind: "plain" };
    }
    default:
      if (isNumericDatatype(datatype)) {
        const out = formatNumber(value, locale);
        return out ? { text: out, kind: "number" } : { text: value, kind: "plain" };
      }
      return { text: value, kind: "plain" };
  }
}

/**
 * Heuristic: does this text body look like Markdown worth rendering as formatted
 * HTML, rather than plain text? `text/markdown` is always treated as Markdown by
 * the caller; this is the *opt-in* signal for `text/plain` bodies that carry
 * markdown-ish structure (headings, lists, fenced code, emphasis, links).
 *
 * Deliberately conservative — a false negative just shows monospace text (no
 * harm); a false positive would only re-flow plain prose, which the AST renderer
 * does safely. We require at least one *structural* marker at a line start so a
 * stray `*` in prose doesn't trigger it.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text) return false;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    // ATX heading, list item, blockquote, fenced code, or thematic break.
    if (/^\s{0,3}(#{1,6}\s+\S|[-*+]\s+\S|\d+\.\s+\S|>\s|```|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(line)) {
      return true;
    }
  }
  // A link plus emphasis anywhere is a softer signal that prose is Markdown.
  const hasLink = /\[[^\]]+\]\([^)\s]+\)/.test(text);
  const hasEmphasis = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`)/.test(text);
  return hasLink && hasEmphasis;
}
