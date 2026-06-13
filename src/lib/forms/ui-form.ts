// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Solid UI-ontology form parser (Wave 5 §2). Given a form *description* written
 * in the `ui:` ontology (http://www.w3.org/ns/ui#) — the vocabulary SolidOS's
 * `forms.js` interprets — produce a flat, ordered list of {@link FieldSpec}s
 * that the generic renderer binds to a subject. This is the read half of the
 * "render + edit a resource from a form description" capability; the write half
 * is the shared `subject-edit.ts` engine.
 *
 * Supported widgets (the common SolidOS set):
 *  - `ui:Form` / `ui:Group` with `ui:parts` (an RDF list) or `ui:part` — groups
 *    of fields, flattened in list order.
 *  - `ui:SingleLineTextField` → text, `ui:MultiLineTextField` → textarea,
 *    `ui:NamedNodeURIField` / `ui:PhoneField` / `ui:EmailField`,
 *    `ui:BooleanField` → boolean, `ui:DateField` → date,
 *    `ui:DateTimeField` → datetime, `ui:IntegerField` → number,
 *    `ui:DecimalField` / `ui:FloatField` → decimal,
 *    `ui:Classifier` / `ui:Choice` → choice (options via `ui:property` range or
 *    an explicit `ui:choices`/`ui:values` list).
 *  - `ui:property` (the predicate the field edits), `ui:label` (the label),
 *    `ui:maxLength`/`ui:size` (hints), `ui:required`.
 *
 * Pure: parses a parsed `DatasetCore`, never touches the network. RDF-list
 * walking is iterative + cycle-guarded (a malformed form never hangs).
 */
import type { DatasetCore, Quad, Term } from "@rdfjs/types";
import { DataFactory } from "n3";
import { type FieldSpec, type FieldKind, type ValueMode, normaliseField } from "./field-types.js";

const { namedNode } = DataFactory;

export const UI = "http://www.w3.org/ns/ui#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDF_FIRST = "http://www.w3.org/1999/02/22-rdf-syntax-ns#first";
const RDF_REST = "http://www.w3.org/1999/02/22-rdf-syntax-ns#rest";
const RDF_NIL = "http://www.w3.org/1999/02/22-rdf-syntax-ns#nil";

/** Map a `ui:` field class to a (kind, mode) pair. */
const FIELD_CLASS: Readonly<Record<string, { kind: FieldKind; mode: ValueMode }>> = {
  [`${UI}SingleLineTextField`]: { kind: "text", mode: "literal" },
  [`${UI}MultiLineTextField`]: { kind: "textarea", mode: "literal" },
  [`${UI}CommentField`]: { kind: "textarea", mode: "literal" },
  [`${UI}NamedNodeURIField`]: { kind: "url", mode: "iri" },
  [`${UI}EmailField`]: { kind: "email", mode: "mailto" },
  [`${UI}PhoneField`]: { kind: "tel", mode: "tel" },
  [`${UI}BooleanField`]: { kind: "boolean", mode: "literal" },
  [`${UI}TristateField`]: { kind: "boolean", mode: "literal" },
  [`${UI}DateField`]: { kind: "date", mode: "literal" },
  [`${UI}DateTimeField`]: { kind: "datetime", mode: "literal" },
  [`${UI}IntegerField`]: { kind: "number", mode: "literal" },
  [`${UI}DecimalField`]: { kind: "decimal", mode: "literal" },
  [`${UI}FloatField`]: { kind: "decimal", mode: "literal" },
  [`${UI}Classifier`]: { kind: "choice", mode: "iri" },
  [`${UI}Choice`]: { kind: "choice", mode: "iri" },
  [`${UI}ColorField`]: { kind: "text", mode: "literal" },
};

/** Group + part container classes that hold an ordered set of sub-fields. */
const GROUP_CLASSES = new Set([`${UI}Form`, `${UI}Group`]);

/**
 * First object value for `(subject, predicate)`, IRI or literal. A subject may
 * be a blank node (RDF lists, anonymous fields), so we scan the dataset rather
 * than constructing a typed subject term — the lexical value is the only key we
 * track through the walk.
 */
function obj(ds: DatasetCore, subject: string, predicate: string): Term | undefined {
  for (const q of ds.match(null, namedNode(predicate), null, null) as Iterable<Quad>) {
    if (q.subject.value === subject) return q.object;
  }
  return undefined;
}

/** First string object for `(subject, predicate)`. */
function str(ds: DatasetCore, subject: string, predicate: string): string | undefined {
  return obj(ds, subject, predicate)?.value;
}

/** All `rdf:type` IRIs of a subject (by lexical subject value). */
function typesOf(ds: DatasetCore, subject: string): Set<string> {
  const out = new Set<string>();
  for (const q of ds.match(null, namedNode(RDF_TYPE), null, null) as Iterable<Quad>) {
    if (q.subject.value === subject && q.object.termType === "NamedNode") out.add(q.object.value);
  }
  return out;
}

/**
 * Walk an RDF list head → an array of element IRIs/lexes. Cycle-guarded and
 * bounded so a malformed (cyclic / very long) list can never hang the parser.
 */
function rdfList(ds: DatasetCore, head: Term | undefined, limit = 1000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = head;
  while (cur && cur.value !== RDF_NIL && out.length < limit) {
    if (cur.termType !== "NamedNode" && cur.termType !== "BlankNode") break;
    const key = `${cur.termType}:${cur.value}`;
    if (seen.has(key)) break; // cycle
    seen.add(key);
    const first = obj(ds, cur.value, RDF_FIRST);
    if (first) out.push(first.value);
    cur = obj(ds, cur.value, RDF_REST);
  }
  return out;
}

/**
 * The ordered children of a group/form: prefer `ui:parts` (an RDF list), else
 * collect every `ui:part`. Returns child subject IRIs in document/list order.
 */
function groupParts(ds: DatasetCore, group: string): string[] {
  const partsHead = obj(ds, group, `${UI}parts`);
  if (partsHead) {
    const listed = rdfList(ds, partsHead);
    if (listed.length > 0) return listed;
  }
  const out: string[] = [];
  for (const q of ds.match(null, namedNode(`${UI}part`), null, null) as Iterable<Quad>) {
    if (q.subject.value === group) out.push(q.object.value);
  }
  return out;
}

/** Parse a single field node into a {@link FieldSpec}, or `undefined`. */
function parseField(ds: DatasetCore, node: string): FieldSpec | undefined {
  const types = typesOf(ds, node);
  let widget: { kind: FieldKind; mode: ValueMode } | undefined;
  for (const t of types) {
    if (FIELD_CLASS[t]) {
      widget = FIELD_CLASS[t];
      break;
    }
  }
  if (!widget) return undefined;

  const predicate = str(ds, node, `${UI}property`);
  if (!predicate) return undefined; // a field with no property edits nothing

  const label = str(ds, node, `${UI}label`) ?? labelFromPredicate(predicate);
  const required = str(ds, node, `${UI}required`) === "true";
  const maxLength = str(ds, node, `${UI}maxLength`);

  const options = widget.kind === "choice" ? parseOptions(ds, node) : undefined;

  return normaliseField({
    id: node,
    label,
    predicate,
    kind: widget.kind,
    mode: widget.mode,
    required,
    options,
    hint: maxLength ? `Up to ${maxLength} characters` : undefined,
  });
}

/**
 * Options for a `ui:Classifier`/`ui:Choice`: an explicit `ui:values`/`ui:choices`
 * RDF list of option IRIs (labels read from each option's `ui:label`/`rdfs:label`),
 * or none (the renderer then offers a free IRI input).
 */
function parseOptions(ds: DatasetCore, node: string): FieldSpec["options"] {
  const head = obj(ds, node, `${UI}values`) ?? obj(ds, node, `${UI}choices`);
  const ivalues = head ? rdfList(ds, head) : [];
  if (ivalues.length === 0) return undefined;
  return ivalues.map((value) => ({
    value,
    label:
      str(ds, value, `${UI}label`) ??
      str(ds, value, "http://www.w3.org/2000/01/rdf-schema#label") ??
      labelFromPredicate(value),
  }));
}

/** Derive a human label from a predicate IRI (the local name, title-cased). */
export function labelFromPredicate(predicate: string): string {
  const tail = predicate.split(/[#/]/).filter(Boolean).at(-1) ?? predicate;
  const spaced = tail
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : predicate;
}

/** Find the form's top subject: a `ui:Form`, else any `ui:Group`. */
export function findFormSubject(ds: DatasetCore): string | undefined {
  let firstGroup: string | undefined;
  for (const q of ds.match(null, namedNode(RDF_TYPE), null, null) as Iterable<Quad>) {
    if (q.object.value === `${UI}Form`) return q.subject.value;
    if (q.object.value === `${UI}Group` && !firstGroup) firstGroup = q.subject.value;
  }
  return firstGroup;
}

/**
 * Parse a Solid `ui:` form description into an ordered list of editable fields.
 * Starts from `formSubject` (or auto-discovers a `ui:Form`/`ui:Group`), then
 * flattens groups/parts depth-first in list order. Cycle-guarded across nested
 * groups. Returns `[]` when the dataset holds no recognised form.
 */
export function parseUiForm(ds: DatasetCore, formSubject?: string): FieldSpec[] {
  const root = formSubject ?? findFormSubject(ds);
  if (!root) return [];

  const fields: FieldSpec[] = [];
  const seen = new Set<string>();

  const visit = (node: string): void => {
    if (seen.has(node)) return;
    seen.add(node);
    const types = typesOf(ds, node);
    const isGroup = [...types].some((t) => GROUP_CLASSES.has(t)) || node === root;
    if (isGroup) {
      for (const child of groupParts(ds, node)) visit(child);
      return;
    }
    const field = parseField(ds, node);
    if (field) fields.push(field);
  };

  visit(root);
  return fields;
}
