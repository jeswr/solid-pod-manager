// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Notes typed-view (design: `docs/typed-data-views.md` §4; extends the P3 set).
 *
 * Targets the real shape the first-party Notes app writes (`src/lib/notes.ts`):
 * `schema:TextDigitalDocument` with `schema:name` (title), `schema:text` (body
 * markdown/plain text), `schema:dateModified` (last-edited timestamp); the
 * broader `schema:DigitalDocument` parent class is accepted too.
 *
 * **Scheme alignment (roborev correctness).** `NoteDoc` reads the
 * `https://schema.org/` predicate scheme, so this viewer matches ONLY the
 * `https://schema.org/` note classes — the scheme the Notes app writes. The
 * legacy `http://schema.org/` class is NOT matched: it would match but then
 * render with a missing title/body/date because its `http://schema.org/name`,
 * `text`, `dateModified` predicates are a different namespace the extractor
 * can't read. An http-scheme note keeps the generic table until `NoteDoc` reads
 * both schemes (a follow-up in `src/lib/notes.ts`, the wrapper's home).
 *
 * Match is **type-only** (no signature-predicate shape-rescue): `schema:text` /
 * `schema:name` are far too generic to rescue an untyped subject without
 * over-matching every document-shaped resource — only a properly-typed note
 * renders as a note card; anything else falls through to the generic table.
 *
 * Pure: extracts a plain `{ items: NoteItem[] }` model the React card renders as
 * a title + relative-time + a body preview — no raw triples. The body stays the
 * raw text (the card truncates/formats); the modified date stays a raw ISO
 * string so the card can format it in the user's locale (the pure layer must
 * remain locale-/timezone-neutral and serialisable). Never hand-build triples.
 */
import type { DatasetCore, Quad } from "@rdfjs/types";
import { DataFactory } from "n3";
import { NoteDoc, NOTE_CLASS } from "../notes.js";
import type { TypedViewer, ViewerContext } from "./types.js";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const SCHEMA = "https://schema.org/";

/**
 * The classes a note subject may carry — ONLY the `https://schema.org/` scheme
 * `NoteDoc` reads, plus the broader `DigitalDocument` parent. The legacy
 * `http://schema.org/` classes are excluded so the matcher never accepts a note
 * the extractor would render fieldless (see the docblock above).
 */
const NOTE_CLASSES = new Set<string>([
  NOTE_CLASS, // https://schema.org/TextDigitalDocument
  `${SCHEMA}DigitalDocument`,
]);

/** A single note ready to render — plain + serialisable, no RDF terms. */
export interface NoteItem {
  /** The subject IRI (stable React key; never shown raw). */
  id: string;
  /** Title (`schema:name`); falls back to "Untitled note" when absent. */
  title: string;
  /** Body markdown/plain text (`schema:text`). */
  text?: string;
  /** Raw ISO-8601 last-edited time (`schema:dateModified`); the card formats it. */
  modified?: string;
}

/** The Notes view-model: a list of note cards over every matching subject. */
export interface NoteModel {
  items: NoteItem[];
}

/** Does any subject carry one of the note classes? (type-only, no shape rescue). */
function hasNoteSubject(ctx: ViewerContext): boolean {
  for (const t of ctx.types) {
    if (NOTE_CLASSES.has(t)) return true;
  }
  return false;
}

/** Collect the subject IRIs that are notes (typed only). */
function noteSubjects(dataset: DatasetCore): string[] {
  const subjects = new Set<string>();
  for (const quad of dataset as Iterable<Quad>) {
    if (quad.subject.termType !== "NamedNode") continue; // skip blank nodes
    if (
      quad.predicate.value === RDF_TYPE &&
      quad.object.termType === "NamedNode" &&
      NOTE_CLASSES.has(quad.object.value)
    ) {
      subjects.add(quad.subject.value);
    }
  }
  return [...subjects];
}

/**
 * Extract one note from a note subject via the typed `NoteDoc` accessors (never
 * hand-built quads). The shared `NoteDoc.modified` returns a `Date`; we surface
 * its ISO string so the model stays serialisable and locale-neutral.
 */
function extractNote(dataset: DatasetCore, subject: string): NoteItem {
  const doc = new NoteDoc(subject, dataset, DataFactory);
  const title = doc.title;
  return {
    id: subject,
    title: title?.trim() ? title : "Untitled note",
    text: doc.text,
    modified: doc.modified?.toISOString(),
  };
}

/** Epoch ms for an ISO modified date, or -Infinity when absent (sorts last). */
function modifiedMs(item: NoteItem): number {
  if (!item.modified) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(item.modified);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** The Notes {@link TypedViewer}. Priority 60 — a specific class (§4.4). */
export const noteViewer: TypedViewer<NoteModel> = {
  id: "note",
  priority: 60,
  matches: hasNoteSubject,
  extract(ctx) {
    const items = noteSubjects(ctx.dataset).map((s) => extractNote(ctx.dataset, s));
    // Most-recently-edited first; undated notes sink to the end, then IRI as a
    // deterministic tie-break.
    items.sort((a, b) => modifiedMs(b) - modifiedMs(a) || a.id.localeCompare(b.id));
    return { items };
  },
};
