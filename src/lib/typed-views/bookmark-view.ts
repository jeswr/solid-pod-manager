// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Bookmarks typed-view (design: `docs/typed-data-views.md` §2.2, P3).
 *
 * **No integration writes bookmarks today** — `bookmark:Bookmark`
 * (`http://www.w3.org/2002/01/bookmark#Bookmark`) is registered in the Documents
 * category (`categories.ts`) but only externally-authored data carries it. So
 * this viewer targets the **generic interop shape** that standard Solid bookmark
 * apps (and SolidOS) write:
 *
 * - type `bookmark:Bookmark`,
 * - `bookmark:recalls` → the bookmarked URL (the canonical predicate),
 * - `dct:title` / `dc:title` → the title.
 *
 * It also accepts `schema:url` as the link (the predicate every integration in
 * this app uses for provenance, and the one named in the P3 task) and
 * `rdfs:label` / `schema:name` as title fallbacks, so a bookmark written by any
 * common app renders well rather than dropping to the raw triple table.
 *
 * Pure: extracts a plain `{ items: Bookmark[] }` model the React card renders as
 * a title + favicon + **Open** action — no raw triples. The bookmarked URL is
 * surfaced as a safe outbound link, never as a data row (§5).
 */
import type { DatasetCore, Quad } from "@rdfjs/types";
import { SCHEMA } from "../integrations/core/vocab.js";
import { safeLinkHref } from "../pod-scope.js";
import type { TypedViewer, ViewerContext } from "./types.js";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const BOOKMARK = "http://www.w3.org/2002/01/bookmark#";
const DCT = "http://purl.org/dc/terms/";
const DC = "http://purl.org/dc/elements/1.1/";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";

/** The class generic Solid bookmark apps stamp. */
const BOOKMARK_CLASS = `${BOOKMARK}Bookmark`;
/** The canonical "the URL this bookmark recalls" predicate. */
const RECALLS = `${BOOKMARK}recalls`;

/** Title predicates, in preference order. */
const TITLE_PREDICATES = [`${DCT}title`, `${DC}title`, `${RDFS}label`, `${SCHEMA}name`] as const;
/** Link predicates, in preference order (`bookmark:recalls` is canonical). */
const LINK_PREDICATES = [RECALLS, `${SCHEMA}url`] as const;

/** A single bookmark ready to render — plain + serialisable, no RDF terms. */
export interface Bookmark {
  /** The subject IRI (stable React key; never shown raw). */
  id: string;
  /** Title; falls back to the link's host, then "Untitled bookmark". */
  title: string;
  /** The safe outbound href (http(s) only); `undefined` if absent/unsafe. */
  href?: string;
  /** The link host, for the favicon + a compact display under the title. */
  host?: string;
}

/** The Bookmarks view-model: a list of bookmark cards over every matching subject. */
export interface BookmarkModel {
  items: Bookmark[];
}

/**
 * Does any subject look like a bookmark? Matches on `bookmark:Bookmark` type
 * (primary), or — for untyped data — the presence of the `bookmark:recalls`
 * signature predicate (the shape rescue, §4.3). `schema:url` alone is *not* a
 * rescue signal: too many shapes carry it (every integration writes it for
 * provenance), so an unqualified `schema:url` would over-match.
 */
function hasBookmarkSubject(ctx: ViewerContext): boolean {
  if (ctx.types.has(BOOKMARK_CLASS)) return true;
  for (const quad of ctx.dataset as Iterable<Quad>) {
    if (quad.predicate.value === RECALLS) return true;
  }
  return false;
}

/** Collect the subject IRIs that are bookmarks (typed or `bookmark:recalls`-shaped). */
function bookmarkSubjects(dataset: DatasetCore): string[] {
  const subjects = new Set<string>();
  for (const quad of dataset as Iterable<Quad>) {
    if (quad.subject.termType !== "NamedNode") continue; // skip blank nodes
    const p = quad.predicate.value;
    if (p === RDF_TYPE && quad.object.termType === "NamedNode" && quad.object.value === BOOKMARK_CLASS) {
      subjects.add(quad.subject.value);
    } else if (p === RECALLS) {
      subjects.add(quad.subject.value);
    }
  }
  return [...subjects];
}

/** First literal object for `subject predicate`. */
function literal(dataset: DatasetCore, subject: string, predicate: string): string | undefined {
  for (const quad of dataset as Iterable<Quad>) {
    if (
      quad.subject.value === subject &&
      quad.predicate.value === predicate &&
      quad.object.termType === "Literal"
    ) {
      return quad.object.value;
    }
  }
  return undefined;
}

/**
 * First object value for `subject predicate`, whether it is an IRI or a literal
 * (bookmark apps vary: some write `bookmark:recalls` as a `<…>` IRI, some as a
 * string literal).
 */
function objectValue(dataset: DatasetCore, subject: string, predicate: string): string | undefined {
  for (const quad of dataset as Iterable<Quad>) {
    if (
      quad.subject.value === subject &&
      quad.predicate.value === predicate &&
      (quad.object.termType === "NamedNode" || quad.object.termType === "Literal")
    ) {
      return quad.object.value;
    }
  }
  return undefined;
}

/** The first present title across the preference list. */
function titleFor(dataset: DatasetCore, subject: string): string | undefined {
  for (const p of TITLE_PREDICATES) {
    const t = literal(dataset, subject, p);
    if (t?.trim()) return t;
  }
  return undefined;
}

/** The first present, *safe* http(s) link across the preference list. */
function linkFor(dataset: DatasetCore, subject: string): string | undefined {
  for (const p of LINK_PREDICATES) {
    const v = objectValue(dataset, subject, p);
    if (v) {
      const safe = safeLinkHref(v);
      if (safe) {
        try {
          const proto = new URL(safe).protocol;
          if (proto === "http:" || proto === "https:") return safe;
        } catch {
          // not a navigable absolute URL — skip
        }
      }
    }
  }
  return undefined;
}

/** Host of a safe URL, for the favicon + a compact display line. */
function hostOf(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href).host;
  } catch {
    return undefined;
  }
}

/** Extract one bookmark from a bookmark subject. */
function extractBookmark(dataset: DatasetCore, subject: string): Bookmark {
  const href = linkFor(dataset, subject);
  const host = hostOf(href);
  const title = titleFor(dataset, subject);
  return {
    id: subject,
    // Title → the host (e.g. "github.com") → a last-resort constant.
    title: title ?? host ?? "Untitled bookmark",
    href,
    host,
  };
}

/** The Bookmarks {@link TypedViewer}. Priority 60 — a specific class (§4.4). */
export const bookmarkViewer: TypedViewer<BookmarkModel> = {
  id: "bookmark",
  priority: 60,
  matches: hasBookmarkSubject,
  extract(ctx) {
    const items = bookmarkSubjects(ctx.dataset).map((s) => extractBookmark(ctx.dataset, s));
    // Stable, human order: by title, then IRI as a deterministic tie-break.
    items.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    return { items };
  },
};
