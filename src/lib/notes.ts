/**
 * Notes — markdown/plain-text notes stored one-per-resource under `notes/`.
 *
 * **Class choice — `schema:TextDigitalDocument`** (not `NoteDigitalDocument`):
 * `TextDigitalDocument` is the schema.org term already in this app's Documents
 * category class list (`src/lib/categories.ts`), so notes map straight into the
 * "Documents" bucket under "My data" with no taxonomy change. schema.org has no
 * `NoteDigitalDocument`; `TextDigitalDocument` is the closest standard,
 * widely-deployed term (FAIR: prefer an existing resolvable term over minting
 * one — AGENTS.md §Data modelling).
 *
 * Fields: `schema:name` (title), `schema:text` (body), `schema:dateModified`
 * (last-edited timestamp). All RDF goes through the typed `NoteDoc` wrapper —
 * never inline quads (house rule).
 */
import {
  LiteralAs,
  LiteralFrom,
  NamedNodeAs,
  NamedNodeFrom,
  OptionalAs,
  OptionalFrom,
  SetFrom,
  TermWrapper,
} from "@rdfjs/wrapper";
import { DataFactory, Store } from "n3";
import { createStore, type ProductivityStore, type StoreConfig } from "./productivity-store.js";

const SCHEMA = "https://schema.org/";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** The RDF class a note is stamped + registered with. */
export const NOTE_CLASS = `${SCHEMA}TextDigitalDocument`;

/** Container slug under the pod root. */
export const NOTES_SLUG = "notes/";

const PREFIXES = { schema: SCHEMA } as const;

/** A note as the UI works with it (plain, serialisable — no RDF leaks out). */
export interface Note {
  /** Title — `schema:name`. */
  title: string;
  /** Body markdown/plain text — `schema:text`. */
  text: string;
  /** Last-edited time — `schema:dateModified`. */
  modified?: Date;
}

/** Typed `@rdfjs/wrapper` view of a single note's subject. */
export class NoteDoc extends TermWrapper {
  /** Live set of `rdf:type` IRIs. */
  get types(): Set<string> {
    return SetFrom.subjectPredicate(this, RDF_TYPE, NamedNodeAs.string, NamedNodeFrom.string);
  }
  /** Stamp the subject as a TextDigitalDocument (call once when minting). */
  mark(): this {
    this.types.add(NOTE_CLASS);
    return this;
  }
  get title(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}name`, LiteralAs.string);
  }
  set title(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}name`, v, LiteralFrom.string);
  }
  get text(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}text`, LiteralAs.string);
  }
  set text(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}text`, v, LiteralFrom.string);
  }
  get modified(): Date | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}dateModified`, LiteralAs.date);
  }
  set modified(v: Date | undefined) {
    OptionalAs.object(this, `${SCHEMA}dateModified`, v, LiteralFrom.dateTime);
  }
}

/** Parse a note document into a {@link Note}, or `undefined` if it is not one. */
export function parseNote(itemUrl: string, dataset: import("@rdfjs/types").DatasetCore): Note | undefined {
  const doc = new NoteDoc(`${itemUrl}#it`, dataset, DataFactory);
  if (!doc.types.has(NOTE_CLASS)) return undefined;
  return { title: doc.title ?? "", text: doc.text ?? "", modified: doc.modified };
}

/** Serialise a {@link Note} into a fresh dataset rooted at `${itemUrl}#it`. */
export function buildNote(itemUrl: string, note: Note): Store {
  const store = new Store();
  const doc = new NoteDoc(`${itemUrl}#it`, store, DataFactory).mark();
  doc.title = note.title || undefined;
  doc.text = note.text || undefined;
  doc.modified = note.modified ?? new Date();
  return store;
}

/** The store config — wires the typed parse/build into the shared CRUD. */
export const NOTES_CONFIG: StoreConfig<Note> = {
  containerSlug: NOTES_SLUG,
  forClass: NOTE_CLASS,
  prefixes: PREFIXES,
  parse: parseNote,
  build: buildNote,
};

/** Build a Notes store bound to the active pod + WebID. */
export function notesStore(opts: {
  podRoot: string;
  webId: string;
  fetchImpl?: typeof fetch;
}): ProductivityStore<Note> {
  return createStore(NOTES_CONFIG, opts);
}
