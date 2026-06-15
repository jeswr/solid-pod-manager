// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Auto-form generator (Wave 5 §2 fallback). When a subject has no `ui:` form
 * description and no first-party edit map, generate an editing form by
 * inspecting the subject's own statements: one field per distinct predicate,
 * with the widget kind inferred from the object terms (IRI → url, typed literal
 * → date/number/boolean, `mailto:`/`tel:` IRI → email/phone, otherwise text).
 *
 * This is the "edit anything" floor: it turns the generic RDF triple table into
 * an editable form without a schema. It deliberately SKIPS structural
 * predicates (`rdf:type`) so the editor never lets a user retype the subject by
 * accident, and it preserves the document's predicate order for stable UI.
 *
 * Pure + node-testable. The renderer + writer are shared with the UI-form and
 * edit-map paths, so an auto-form round-trips through the same
 * preserve-unrelated-triples engine.
 */
import type { DatasetCore, Quad } from "@rdfjs/types";
import {
  type FieldSpec,
  type FieldKind,
  type ValueMode,
  XSD_BOOLEAN,
  XSD_DATE,
  XSD_DATETIME,
  XSD_DECIMAL,
  XSD_INTEGER,
  normaliseField,
} from "./field-types.js";
import { labelFromPredicate } from "./ui-form.js";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const XSD_FLOAT = "http://www.w3.org/2001/XMLSchema#float";
const XSD_DOUBLE = "http://www.w3.org/2001/XMLSchema#double";

/** Predicates we never auto-generate an editor for (structural / dangerous). */
const SKIP_PREDICATES = new Set([RDF_TYPE]);

/** Infer (kind, mode, datatype) from an object term. */
function inferWidget(object: Quad["object"]): {
  kind: FieldKind;
  mode: ValueMode;
  datatype?: string;
} {
  if (object.termType === "NamedNode") {
    if (object.value.startsWith("mailto:")) return { kind: "email", mode: "mailto" };
    if (object.value.startsWith("tel:")) return { kind: "tel", mode: "tel" };
    return { kind: "url", mode: "iri" };
  }
  if (object.termType === "Literal") {
    const dt = object.datatype?.value;
    switch (dt) {
      case XSD_DATE:
        return { kind: "date", mode: "literal", datatype: dt };
      case XSD_DATETIME:
        return { kind: "datetime", mode: "literal", datatype: dt };
      case XSD_INTEGER:
        return { kind: "number", mode: "literal", datatype: dt };
      case XSD_DECIMAL:
      case XSD_FLOAT:
      case XSD_DOUBLE:
        return { kind: "decimal", mode: "literal", datatype: dt ?? XSD_DECIMAL };
      case XSD_BOOLEAN:
        return { kind: "boolean", mode: "literal", datatype: dt };
      default: {
        // A long literal gets a textarea; everything else a single line.
        const long = object.value.length > 80 || object.value.includes("\n");
        return { kind: long ? "textarea" : "text", mode: "literal" };
      }
    }
  }
  // Blank-node objects (nested structures) — not auto-editable; treat as text.
  return { kind: "text", mode: "literal" };
}

/**
 * Generate an editable form for `subject` from its own statements. One field per
 * distinct (non-skipped) predicate, in first-seen order. The widget is inferred
 * from the FIRST object seen for each predicate. Returns `[]` when the subject
 * has no editable statements.
 */
export function autoFormFor(ds: DatasetCore, subject: string): FieldSpec[] {
  const fields: FieldSpec[] = [];
  const seen = new Set<string>();

  for (const q of ds.match(null, null, null, null) as Iterable<Quad>) {
    if (q.subject.value !== subject) continue;
    const predicate = q.predicate.value;
    if (SKIP_PREDICATES.has(predicate) || seen.has(predicate)) continue;
    seen.add(predicate);
    const widget = inferWidget(q.object);
    fields.push(
      normaliseField({
        id: predicate,
        label: labelFromPredicate(predicate),
        predicate,
        kind: widget.kind,
        mode: widget.mode,
        datatype: widget.datatype,
      }),
    );
  }

  return fields;
}

/** True iff `subject` has at least one auto-editable statement. */
export function hasAutoForm(ds: DatasetCore, subject: string): boolean {
  for (const q of ds.match(null, null, null, null) as Iterable<Quad>) {
    if (q.subject.value === subject && !SKIP_PREDICATES.has(q.predicate.value)) return true;
  }
  return false;
}
