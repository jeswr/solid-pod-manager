// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * The pure, node-testable field model that drives the generic editing engine
 * (Wave 5 — Forms / UI-ontology + inline editing over the #61 typed views).
 *
 * A `FieldSpec` is the single editable binding: a human label, the RDF
 * `predicate` it reads/writes on a subject, how the value is shaped on the wire
 * (`ValueMode` — a plain literal, a typed literal, an IRI, or a `mailto:`/`tel:`
 * URI), and which widget the UI should render (`FieldKind`). It is the common
 * currency of three producers — the per-typed-view edit maps (`edit-map.ts`),
 * the Solid UI-ontology form parser (`ui-form.ts`), and the auto-form generator
 * (`auto-form.ts`) — and one consumer (the React `EditableField` /
 * `FormRenderer`).
 *
 * No React, no DOM, no I/O here. The writer (`subject-edit.ts`) consumes a
 * `FieldSpec` + a new string value and mutates quads; it never hand-builds
 * Turtle (house rule).
 */

/** Which widget the UI renders for a field. */
export type FieldKind =
  | "text" // single-line free text
  | "textarea" // multi-line free text
  | "url" // an absolute http(s) URL (stored as an IRI object)
  | "email" // an email address (stored as a `mailto:` IRI)
  | "tel" // a phone number (stored as a `tel:` IRI)
  | "date" // a calendar date (xsd:date)
  | "datetime" // a date + time (xsd:dateTime)
  | "number" // an integer (xsd:integer)
  | "decimal" // a decimal/float (xsd:decimal)
  | "boolean" // a checkbox (xsd:boolean)
  | "choice"; // a closed set of options (enum)

/** How a field's value is represented as an RDF object on the wire. */
export type ValueMode =
  | "literal" // a plain (or language/datatype) literal
  | "iri" // a NamedNode (absolute IRI)
  | "mailto" // a literal email rendered, stored as a `mailto:` IRI
  | "tel"; // a literal phone rendered, stored as a `tel:` IRI

/** XSD datatype IRIs used by literal fields. */
export const XSD = "http://www.w3.org/2001/XMLSchema#";
export const XSD_STRING = `${XSD}string`;
export const XSD_DATE = `${XSD}date`;
export const XSD_DATETIME = `${XSD}dateTime`;
export const XSD_INTEGER = `${XSD}integer`;
export const XSD_DECIMAL = `${XSD}decimal`;
export const XSD_BOOLEAN = `${XSD}boolean`;

/** One selectable option for a `choice` field. */
export interface FieldOption {
  /** The stored value (a literal lexical form or an IRI, per the field's mode). */
  value: string;
  /** The human label shown in the picker (defaults to `value`). */
  label: string;
}

/**
 * A single editable binding: label + predicate + how to read/write it. Pure +
 * serialisable. `id` is a stable key (defaults to the predicate) so React can
 * track the field across renders.
 */
export interface FieldSpec {
  /** Stable key for React + the edit registry (defaults to the predicate IRI). */
  id: string;
  /** Human-readable label. */
  label: string;
  /** The RDF predicate this field reads from / writes to. */
  predicate: string;
  /** Which widget to render. */
  kind: FieldKind;
  /** How the value is shaped as an RDF object. */
  mode: ValueMode;
  /** Datatype IRI for typed literals (defaults derived from `kind`). */
  datatype?: string;
  /** Closed option set for `choice` fields. */
  options?: FieldOption[];
  /** A short hint shown under the input. */
  hint?: string;
  /** Whether the field accepts multiple values (renders a value list). */
  multi?: boolean;
  /** Whether the field is required (UI hint; not enforced by the writer). */
  required?: boolean;
  /** When set, the field is shown but not editable (e.g. a derived value). */
  readOnly?: boolean;
  /** Optional autocomplete source id (see `autocomplete.ts`); a clean seam. */
  autocomplete?: string;
}

/** The datatype a `kind`'s literal should carry, when none is stated. */
export function defaultDatatypeFor(kind: FieldKind): string | undefined {
  switch (kind) {
    case "date":
      return XSD_DATE;
    case "datetime":
      return XSD_DATETIME;
    case "number":
      return XSD_INTEGER;
    case "decimal":
      return XSD_DECIMAL;
    case "boolean":
      return XSD_BOOLEAN;
    case "text":
    case "textarea":
    case "choice":
      return XSD_STRING;
    // url/email/tel are IRI/mailto/tel — no literal datatype.
    default:
      return undefined;
  }
}

/** Normalise a partial spec into a complete one (fills `id` + `datatype`). */
export function normaliseField(spec: Omit<FieldSpec, "id"> & { id?: string }): FieldSpec {
  return {
    ...spec,
    id: spec.id ?? spec.predicate,
    datatype: spec.datatype ?? (spec.mode === "literal" ? defaultDatatypeFor(spec.kind) : undefined),
  };
}
