/**
 * Turn a parsed RDF resource into a flat, human-readable property view for the
 * "structured data" viewer (DESIGN.md §4). We walk the dataset's quads directly
 * here (a generic property table over arbitrary RDF) — `@solid/object`'s typed
 * wrappers cover *known* shapes; this is the safe generic for everything else.
 *
 * Pure (operates on an already-parsed `DatasetCore`), so it is fully unit
 * testable with a `parseRdf` fixture and never performs I/O.
 */
import type { DatasetCore, Quad, Term } from "@rdfjs/types";

/** One predicate → its values, for display. */
export interface PropertyEntry {
  /** Full predicate IRI. */
  predicate: string;
  /** Short, friendly predicate label (the IRI's local name). */
  label: string;
  /** Display values (literals as their text, IRIs as the IRI). */
  values: PropertyValue[];
}

export interface PropertyValue {
  value: string;
  /** `named` (a link/IRI) or `literal` (text/number/date). */
  kind: "named" | "literal";
  /**
   * For `literal` values: the datatype IRI (e.g. `xsd:dateTime`), enabling
   * human-readable formatting (A2) in the render layer. Absent on named nodes.
   */
  datatype?: string;
  /** For `literal` values: a BCP-47 language tag (`rdf:langString`), if any. */
  language?: string;
}

/** All properties of one subject. */
export interface PropertyGroup {
  /** Subject IRI (or blank-node label). */
  subject: string;
  /** Friendly subject label — the primary subject is highlighted by callers. */
  label: string;
  /** Whether this is the resource's primary subject (the document or its #me). */
  primary: boolean;
  properties: PropertyEntry[];
}

/** Shorten an IRI to its local name (after the last `#` or `/`). */
export function localName(iri: string): string {
  const hash = iri.lastIndexOf("#");
  if (hash >= 0 && hash < iri.length - 1) return iri.slice(hash + 1);
  const slash = iri.lastIndexOf("/");
  if (slash >= 0 && slash < iri.length - 1) return iri.slice(slash + 1);
  return iri;
}

function termValue(term: Term): PropertyValue {
  if (term.termType === "NamedNode") return { value: term.value, kind: "named" };
  if (term.termType === "Literal") {
    const language = term.language ? term.language : undefined;
    return {
      value: term.value,
      kind: "literal",
      datatype: term.datatype?.value,
      language,
    };
  }
  // Blank nodes (and the variable/default-graph terms that never appear as
  // object values here) render as their label, like literals.
  return { value: term.value, kind: "literal" };
}

/**
 * Group a dataset's quads by subject, then by predicate, ordered with the
 * primary subject first. The primary subject is the resource URL itself or its
 * `#me`/`#this` fragment, whichever is present.
 */
export function readResourceProperties(
  resourceUrl: string,
  dataset: DatasetCore,
): PropertyGroup[] {
  const bySubject = new Map<string, Map<string, PropertyValue[]>>();

  for (const quad of dataset as Iterable<Quad>) {
    const subject = quad.subject.value;
    const predicate = quad.predicate.value;
    const predicates = bySubject.get(subject) ?? new Map<string, PropertyValue[]>();
    const values = predicates.get(predicate) ?? [];
    values.push(termValue(quad.object));
    predicates.set(predicate, values);
    bySubject.set(subject, predicates);
  }

  const primaryCandidates = new Set([
    resourceUrl,
    `${resourceUrl}#me`,
    `${resourceUrl}#this`,
    `${resourceUrl}#it`,
  ]);

  const groups: PropertyGroup[] = [];
  for (const [subject, predicates] of bySubject) {
    const properties: PropertyEntry[] = [...predicates].map(([predicate, values]) => ({
      predicate,
      label: localName(predicate),
      values,
    }));
    properties.sort((a, b) => a.label.localeCompare(b.label));
    groups.push({
      subject,
      label: localName(subject) || subject,
      primary: primaryCandidates.has(subject),
      properties,
    });
  }

  // Primary subject(s) first, then alphabetical by label.
  groups.sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return groups;
}
