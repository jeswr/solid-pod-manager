// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * The pure heart of the generic editing engine: apply a field edit to a parsed
 * dataset, producing a NEW `n3.Store` that **preserves every unrelated triple**
 * and only replaces the `(subject, predicate)` triples the edit targets.
 *
 * This is the "never silently clobber" guarantee at the data level: an editor
 * reads a resource (keeping its ETag), edits one field, and writes the WHOLE
 * document back conditionally (`If-Match`). Because we start from the parsed
 * dataset and surgically replace only the edited statements, the round-trip is
 * byte-faithful for everything the user did not touch — no triple is dropped,
 * no blank-node graph is mangled, no provenance is lost.
 *
 * House rule: we operate on quads via `n3.Store` + `DataFactory`, never by
 * hand-concatenating Turtle. The object term is built per the field's
 * {@link ValueMode} (plain literal, typed literal, IRI, or `mailto:`/`tel:`).
 *
 * No React, no DOM, no I/O. `write.ts` wraps this with the conditional PUT.
 */
import type { DatasetCore, Quad, Term } from "@rdfjs/types";
import { DataFactory, Store } from "n3";
import {
  type FieldSpec,
  XSD_BOOLEAN,
  XSD_DATE,
  XSD_DATETIME,
  XSD_DECIMAL,
  XSD_INTEGER,
} from "./field-types.js";

const { namedNode, literal: lit, quad: mkQuad } = DataFactory;

/** Thrown when a field's value fails validation before any write is attempted. */
export class FieldValidationError extends Error {
  readonly fieldId: string;
  constructor(fieldId: string, message: string) {
    super(message);
    this.name = "FieldValidationError";
    this.fieldId = fieldId;
  }
}

/** Copy every quad of `source` into a fresh `n3.Store` (a mutable working copy). */
export function cloneToStore(source: DatasetCore): Store {
  const store = new Store();
  for (const q of source as Iterable<Quad>) store.addQuad(q);
  return store;
}

/** Wrap a bare email in a `mailto:` IRI; empty → undefined. */
export function toMailto(email: string): string | undefined {
  const v = email.trim();
  return v ? `mailto:${v}` : undefined;
}

/**
 * Wrap a bare phone in a `tel:` IRI. RFC 3966 disallows spaces, so strip
 * everything but digits and a leading `+`; empty → undefined.
 */
export function toTel(phone: string): string | undefined {
  const v = phone.trim();
  if (!v) return undefined;
  const digits = v.replace(/[^\d+]/g, "");
  return digits ? `tel:${digits}` : undefined;
}

/**
 * Validate + normalise a single string value for a field, returning the RDF
 * object `Term` to store — or `undefined` when the value is empty (the edit
 * then just *removes* the field's triples).
 *
 * @throws FieldValidationError for malformed non-empty input (bad URL, NaN
 *   number, unparsable date) so the UI can surface a precise message and the
 *   write never produces a corrupt graph.
 */
export function valueToTerm(spec: FieldSpec, raw: string): Term | undefined {
  const value = raw.trim();
  if (value === "") return undefined; // empty → clear the field

  switch (spec.mode) {
    case "iri": {
      const iri = absoluteHttpUrl(value);
      if (!iri) throw new FieldValidationError(spec.id, "Enter a valid http(s) URL.");
      return namedNode(iri);
    }
    case "mailto": {
      const m = toMailto(value);
      if (!m) return undefined;
      // A light sanity check; the server + RDF layer accept the IRI as-is.
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value))
        throw new FieldValidationError(spec.id, "Enter a valid email address.");
      return namedNode(m);
    }
    case "tel": {
      const t = toTel(value);
      if (!t) throw new FieldValidationError(spec.id, "Enter a valid phone number.");
      return namedNode(t);
    }
    case "literal":
      return literalTermFor(spec, value);
    default:
      return literalTermFor(spec, value);
  }
}

/** Build the literal term for a literal-mode field, validating by kind. */
function literalTermFor(spec: FieldSpec, value: string): Term {
  switch (spec.kind) {
    case "number": {
      if (!/^[+-]?\d+$/.test(value))
        throw new FieldValidationError(spec.id, "Enter a whole number.");
      return lit(value, namedNode(spec.datatype ?? XSD_INTEGER));
    }
    case "decimal": {
      if (!Number.isFinite(Number(value)))
        throw new FieldValidationError(spec.id, "Enter a number.");
      return lit(value, namedNode(spec.datatype ?? XSD_DECIMAL));
    }
    case "boolean": {
      const b = value === "true" || value === "1" ? "true" : "false";
      return lit(b, namedNode(spec.datatype ?? XSD_BOOLEAN));
    }
    case "date": {
      // Accept the browser's `yyyy-mm-dd` (xsd:date) verbatim once validated.
      if (Number.isNaN(Date.parse(value)))
        throw new FieldValidationError(spec.id, "Enter a valid date.");
      return lit(value, namedNode(spec.datatype ?? XSD_DATE));
    }
    case "datetime": {
      const iso = toIsoDateTime(value);
      if (!iso) throw new FieldValidationError(spec.id, "Enter a valid date and time.");
      return lit(iso, namedNode(spec.datatype ?? XSD_DATETIME));
    }
    default: {
      // text / textarea / choice / url-as-literal → plain string literal.
      // A datatype other than xsd:string is preserved if the spec carries one.
      const dt = spec.datatype;
      return dt && dt !== "http://www.w3.org/2001/XMLSchema#string"
        ? lit(value, namedNode(dt))
        : lit(value);
    }
  }
}

/** A browser `datetime-local` value (`yyyy-mm-ddThh:mm`) → an ISO-8601 string. */
function toIsoDateTime(value: string): string | undefined {
  const t = Date.parse(value);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

/** Return `value` iff it is an absolute http(s) URL, else `undefined`. */
function absoluteHttpUrl(value: string): string | undefined {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Apply a single-valued field edit to `dataset`, returning a NEW store with
 * every `(subject, spec.predicate)` triple replaced by (at most) one new triple
 * for `rawValue`. An empty value clears the field. ALL other triples — other
 * predicates on the subject, other subjects, blank-node trees — are preserved
 * verbatim.
 *
 * @throws FieldValidationError when `rawValue` is malformed (see {@link valueToTerm}).
 */
export function applyFieldEdit(
  dataset: DatasetCore,
  subject: string,
  spec: FieldSpec,
  rawValue: string,
): Store {
  const store = cloneToStore(dataset);
  const s = namedNode(subject);
  const p = namedNode(spec.predicate);
  // Remove the existing statements for this exact (subject, predicate).
  for (const q of store.match(s, p, null, null)) store.removeQuad(q);
  const term = valueToTerm(spec, rawValue);
  if (term) store.addQuad(mkQuad(s, p, term as Quad["object"]));
  return store;
}

/**
 * Apply several single-valued field edits in one pass (so a multi-field save is
 * one document write). Edits are keyed by field `id`; only present keys are
 * touched, so omitting a field leaves it exactly as read.
 *
 * @throws FieldValidationError on the first malformed value (nothing is written).
 */
export function applyFieldEdits(
  dataset: DatasetCore,
  subject: string,
  fields: readonly FieldSpec[],
  values: Readonly<Record<string, string>>,
): Store {
  // Validate everything FIRST so a bad value never leaves a half-applied store.
  for (const f of fields) {
    if (f.readOnly) continue;
    if (Object.hasOwn(values, f.id)) valueToTerm(f, values[f.id]);
  }
  const store = cloneToStore(dataset);
  for (const f of fields) {
    if (f.readOnly || !Object.hasOwn(values, f.id)) continue;
    const s = namedNode(subject);
    const p = namedNode(f.predicate);
    for (const q of store.match(s, p, null, null)) store.removeQuad(q);
    const term = valueToTerm(f, values[f.id]);
    if (term) store.addQuad(mkQuad(s, p, term as Quad["object"]));
  }
  return store;
}

/**
 * Read the current string value of a field off a subject (the inverse of
 * {@link valueToTerm}, for seeding the editor). Returns the first matching
 * object's lexical form, with `mailto:`/`tel:` stripped for display. Absent →
 * empty string.
 */
export function readFieldValue(
  dataset: DatasetCore,
  subject: string,
  spec: FieldSpec,
): string {
  const s = namedNode(subject);
  const p = namedNode(spec.predicate);
  for (const q of dataset.match(s, p, null, null) as Iterable<Quad>) {
    const o = q.object;
    if (spec.mode === "mailto" || spec.mode === "tel") {
      return stripScheme(o.value);
    }
    if (spec.kind === "datetime" || spec.kind === "date") return o.value;
    return o.value;
  }
  return "";
}

/** Read every value of a (possibly multi-valued) field as display strings. */
export function readFieldValues(
  dataset: DatasetCore,
  subject: string,
  spec: FieldSpec,
): string[] {
  const s = namedNode(subject);
  const p = namedNode(spec.predicate);
  const out: string[] = [];
  for (const q of dataset.match(s, p, null, null) as Iterable<Quad>) {
    out.push(
      spec.mode === "mailto" || spec.mode === "tel" ? stripScheme(q.object.value) : q.object.value,
    );
  }
  return out;
}

/** Strip a `mailto:`/`tel:` scheme for display; anything else passes through. */
export function stripScheme(uri: string): string {
  const m = /^(?:mailto|tel):(.*)$/i.exec(uri);
  return m ? decodeURIComponent(m[1]) : uri;
}
