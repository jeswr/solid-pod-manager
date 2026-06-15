// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Bookmarks — one `bookmark:Bookmark` per resource under `bookmarks/`.
 *
 * **Vocabulary.** The W3C bookmark ontology
 * (`http://www.w3.org/2002/01/bookmark#`): type `bookmark:Bookmark`,
 * `bookmark:recalls` → the bookmarked URL (an IRI, the canonical predicate),
 * `dct:title` → the title, `dct:description` → an optional note, and
 * `bookmark:hasTopic` → free-text tags (one literal per tag). This is exactly
 * the shape the read-only typed-view card already renders
 * (`src/lib/typed-views/bookmark-view.ts`), so CRUD-created bookmarks light up
 * the same card under "My data" and are re-readable by SolidOS's bookmark pane.
 *
 * Mirrors `contacts.ts`: a typed `@rdfjs/wrapper` doc, a pure parse/build pair,
 * a `StoreConfig`, and a store factory (house rule: never hand-build quads).
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

const BOOKMARK = "http://www.w3.org/2002/01/bookmark#";
const DCT = "http://purl.org/dc/terms/";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** The RDF class a bookmark is stamped + registered with. */
export const BOOKMARK_CLASS = `${BOOKMARK}Bookmark`;

/** Container slug under the pod root. */
export const BOOKMARKS_SLUG = "bookmarks/";

const PREFIXES = { bookmark: BOOKMARK, dct: DCT } as const;

/** A bookmark as the UI works with it (plain, serialisable). */
export interface Bookmark {
  /** Title — `dct:title`. */
  title: string;
  /** Bookmarked URL (an absolute http(s) IRI) — `bookmark:recalls`. */
  url: string;
  /** Optional note — `dct:description`. */
  description?: string;
  /** Free-text tags — `bookmark:hasTopic` (deduped, order-preserving). */
  tags: string[];
}

/** Typed `@rdfjs/wrapper` view of a single bookmark's subject. */
export class BookmarkDoc extends TermWrapper {
  get types(): Set<string> {
    return SetFrom.subjectPredicate(this, RDF_TYPE, NamedNodeAs.string, NamedNodeFrom.string);
  }
  mark(): this {
    this.types.add(BOOKMARK_CLASS);
    return this;
  }
  get title(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${DCT}title`, LiteralAs.string);
  }
  set title(v: string | undefined) {
    OptionalAs.object(this, `${DCT}title`, v, LiteralFrom.string);
  }
  /** `bookmark:recalls` as an IRI (the bookmarked URL). */
  get recalls(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${BOOKMARK}recalls`, NamedNodeAs.string);
  }
  set recalls(v: string | undefined) {
    OptionalAs.object(this, `${BOOKMARK}recalls`, v, NamedNodeFrom.string);
  }
  get description(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${DCT}description`, LiteralAs.string);
  }
  set description(v: string | undefined) {
    OptionalAs.object(this, `${DCT}description`, v, LiteralFrom.string);
  }
  /** `bookmark:hasTopic` — zero or more free-text topic literals (tags). */
  get topics(): Set<string> {
    return SetFrom.subjectPredicate(this, `${BOOKMARK}hasTopic`, LiteralAs.string, LiteralFrom.string);
  }
}

/** Lower-cases, trims and dedupes a tag list, dropping blanks (order-preserving). */
export function normaliseTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Parse a comma/space-separated tag string into a clean tag list. */
export function parseTagsInput(input: string): string[] {
  return normaliseTags(input.split(/[,\n]/));
}

/** Parse a bookmark document into a {@link Bookmark}, or `undefined` if not one. */
export function parseBookmark(
  itemUrl: string,
  dataset: import("@rdfjs/types").DatasetCore,
): Bookmark | undefined {
  const doc = new BookmarkDoc(`${itemUrl}#it`, dataset, DataFactory);
  if (!doc.types.has(BOOKMARK_CLASS)) return undefined;
  return {
    title: doc.title ?? "",
    url: doc.recalls ?? "",
    description: doc.description,
    tags: normaliseTags([...doc.topics].sort((a, b) => a.localeCompare(b))),
  };
}

/** Serialise a {@link Bookmark} into a fresh dataset rooted at `${itemUrl}#it`. */
export function buildBookmark(itemUrl: string, bookmark: Bookmark): Store {
  const store = new Store();
  const doc = new BookmarkDoc(`${itemUrl}#it`, store, DataFactory).mark();
  doc.title = bookmark.title || undefined;
  doc.recalls = bookmark.url || undefined;
  doc.description = bookmark.description || undefined;
  for (const tag of normaliseTags(bookmark.tags)) doc.topics.add(tag);
  return store;
}

/** The store config — wires the typed parse/build into the shared CRUD. */
export const BOOKMARKS_CONFIG: StoreConfig<Bookmark> = {
  containerSlug: BOOKMARKS_SLUG,
  forClass: BOOKMARK_CLASS,
  prefixes: PREFIXES,
  parse: parseBookmark,
  build: buildBookmark,
};

/** Build a Bookmarks store bound to the active pod + WebID. */
export function bookmarksStore(opts: {
  podRoot: string;
  webId: string;
  fetchImpl?: typeof fetch;
}): ProductivityStore<Bookmark> {
  return createStore(BOOKMARKS_CONFIG, opts);
}

/** The display host of a bookmark's URL (for favicons/sublines); `undefined` if unparseable. */
export function bookmarkHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}
