// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Table-of-class view (SolidOS-parity A5 — "all instances of this rdf:type").
 *
 * SolidOS renders a table listing every instance of an `rdf:type` with a column
 * per distinct predicate (capping members to keep it readable). This is the pure,
 * node-testable extractor: given a parsed dataset and a chosen `rdf:type` IRI, it
 * produces a plain `{ columns, rows }` model the React table renders. No RDF
 * terms leak out; values carry just enough to render safely (literal vs IRI, plus
 * datatype/language so the human-readable formatter (A2) can be applied).
 *
 * Pure + DOM-free. The render component lives in
 * `src/components/typed-views/class-table.tsx`.
 */
import type { DatasetCore, Quad } from "@rdfjs/types";
import { localName } from "../resource-view.js";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** Default cap on members shown — SolidOS uses ~15; we surface a count + note. */
export const DEFAULT_MEMBER_CAP = 50;

/** A single cell value, with the bits the render layer needs for safety + A2. */
export interface ClassCellValue {
  value: string;
  kind: "named" | "literal";
  datatype?: string;
  language?: string;
}

/** A column = one predicate that appears on at least one instance. */
export interface ClassColumn {
  /** The predicate IRI (stable key). */
  predicate: string;
  /** Friendly local-name label. */
  label: string;
}

/** A row = one instance subject + its values per column. */
export interface ClassRow {
  /** The subject IRI (stable React key; the row's identity). */
  subject: string;
  /** Friendly subject label (local name). */
  label: string;
  /** Values keyed by predicate IRI; absent predicate → no cell value. */
  cells: Record<string, ClassCellValue[]>;
}

/** The table model for a class. */
export interface ClassTableModel {
  /** The class IRI being tabulated. */
  classIri: string;
  /** Friendly class label. */
  classLabel: string;
  /** Ordered columns (rdf:type excluded — every row has it, so it's noise). */
  columns: ClassColumn[];
  /** The rows, up to the cap. */
  rows: ClassRow[];
  /** Total instances found (may exceed `rows.length` when capped). */
  total: number;
  /** Whether `rows` was truncated by the cap. */
  truncated: boolean;
}

/** Every distinct `rdf:type` IRI present in the dataset, sorted by label. */
export function classesInDataset(dataset: DatasetCore): ClassColumn[] {
  const seen = new Set<string>();
  for (const quad of dataset as Iterable<Quad>) {
    if (quad.predicate.value === RDF_TYPE && quad.object.termType === "NamedNode") {
      seen.add(quad.object.value);
    }
  }
  return [...seen]
    .map((iri) => ({ predicate: iri, label: localName(iri) || iri }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Count distinct named-node instances per `rdf:type` IRI. */
function instanceCounts(dataset: DatasetCore): Map<string, Set<string>> {
  const counts = new Map<string, Set<string>>();
  for (const quad of dataset as Iterable<Quad>) {
    if (
      quad.predicate.value === RDF_TYPE &&
      quad.object.termType === "NamedNode" &&
      quad.subject.termType === "NamedNode"
    ) {
      (counts.get(quad.object.value) ?? counts.set(quad.object.value, new Set()).get(quad.object.value)!).add(
        quad.subject.value,
      );
    }
  }
  return counts;
}

/**
 * The class worth tabulating (A5): the `rdf:type` with the most instances, but
 * only when it has at least `min` (default 2) — a table of one row is just the
 * card. Ties broken by class IRI for determinism. `undefined` when no class
 * clears the threshold (the caller then offers no "Table" mode).
 */
export function dominantTabulatableClass(
  dataset: DatasetCore,
  min = 2,
): string | undefined {
  let best: { iri: string; count: number } | undefined;
  for (const [iri, subjects] of instanceCounts(dataset)) {
    const count = subjects.size;
    if (count < min) continue;
    if (
      best === undefined ||
      count > best.count ||
      (count === best.count && iri.localeCompare(best.iri) < 0)
    ) {
      best = { iri, count };
    }
  }
  return best?.iri;
}

/** The subjects that are instances of `classIri`. */
function instancesOf(dataset: DatasetCore, classIri: string): string[] {
  const subjects = new Set<string>();
  for (const quad of dataset as Iterable<Quad>) {
    if (
      quad.predicate.value === RDF_TYPE &&
      quad.object.termType === "NamedNode" &&
      quad.object.value === classIri &&
      quad.subject.termType === "NamedNode"
    ) {
      subjects.add(quad.subject.value);
    }
  }
  return [...subjects];
}

function cellValue(quad: Quad): ClassCellValue {
  const o = quad.object;
  if (o.termType === "NamedNode") return { value: o.value, kind: "named" };
  if (o.termType === "Literal") {
    return {
      value: o.value,
      kind: "literal",
      datatype: o.datatype?.value,
      language: o.language ? o.language : undefined,
    };
  }
  return { value: o.value, kind: "literal" };
}

/**
 * Build the table model for `classIri` over `dataset`. Columns are the union of
 * predicates across the instances (minus `rdf:type`), ordered by label; rows are
 * capped at `cap` (default {@link DEFAULT_MEMBER_CAP}) with `total`/`truncated`
 * reported so the UI can show "showing 50 of 120". Deterministic ordering keeps
 * snapshots stable.
 */
export function buildClassTable(
  dataset: DatasetCore,
  classIri: string,
  cap: number = DEFAULT_MEMBER_CAP,
): ClassTableModel {
  const subjects = instancesOf(dataset, classIri).sort((a, b) => a.localeCompare(b));
  const total = subjects.length;
  const chosen = cap >= 0 ? subjects.slice(0, cap) : subjects;
  const chosenSet = new Set(chosen);

  // Gather cells for the chosen subjects in a single pass, tracking which
  // predicates appear so columns are exactly the populated ones.
  const cellsBySubject = new Map<string, Record<string, ClassCellValue[]>>();
  const predicates = new Set<string>();
  for (const s of chosen) cellsBySubject.set(s, {});

  for (const quad of dataset as Iterable<Quad>) {
    if (quad.subject.termType !== "NamedNode") continue;
    if (!chosenSet.has(quad.subject.value)) continue;
    const p = quad.predicate.value;
    if (p === RDF_TYPE) continue; // every row has it — exclude as a column
    predicates.add(p);
    const row = cellsBySubject.get(quad.subject.value)!;
    (row[p] ??= []).push(cellValue(quad));
  }

  const columns: ClassColumn[] = [...predicates]
    .map((predicate) => ({ predicate, label: localName(predicate) || predicate }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const rows: ClassRow[] = chosen.map((subject) => ({
    subject,
    label: localName(subject) || subject,
    cells: cellsBySubject.get(subject) ?? {},
  }));

  return {
    classIri,
    classLabel: localName(classIri) || classIri,
    columns,
    rows,
    total,
    truncated: total > chosen.length,
  };
}
