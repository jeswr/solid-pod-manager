// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Photos typed-view (design: `docs/typed-data-views.md` §2.2, P3).
 *
 * Targets the real shape this app writes for images (`MediaItem` in
 * `integrations/core/vocab.ts`, used by `google-photos/adapter.ts` and
 * `pinterest/adapter.ts`): `schema:ImageObject` with `schema:name` (filename /
 * pin title), `schema:contentUrl` (the platform-hosted asset — `baseUrl` for
 * Google Photos, the image variant url for Pinterest), `schema:url` (the source
 * page — `productUrl` / the pin page), `schema:width` / `schema:height`, and a
 * capture/publish date (`schema:dateCreated` / `schema:datePublished`).
 *
 * `MediaItem` also stamps `schema:VideoObject` for videos; this viewer is for
 * **photographs**, so it matches `schema:ImageObject` only (and the schema.org
 * `Photograph` alias) — a video document keeps the generic table for now.
 *
 * Pure: extracts a plain `{ items: Photo[] }` model the React card renders as a
 * thumbnail grid from `schema:contentUrl` — no raw triples and no raw URLs. The
 * `schema:url` becomes an **"Open in <source>"** action via `sourceActionFor`
 * (Google Photos / Pinterest); the raw URL is suppressed (§5).
 */
import type { DatasetCore, Quad } from "@rdfjs/types";
import { SCHEMA, CLASSES } from "../integrations/core/vocab.js";
import { sourceActionFor, type SourceMatch } from "./sources.js";
import type { TypedViewer, ViewerContext } from "./types.js";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** The class the photo adapters stamp on images. */
const IMAGE_OBJECT = CLASSES.ImageObject;
/** schema.org's `Photograph` is a sibling people sometimes use for stills. */
const PHOTOGRAPH = `${SCHEMA}Photograph`;
/** The video sibling — `MediaItem` also writes `schema:contentUrl` on videos, so the shape rescue must exclude them. */
const VIDEO_OBJECT = CLASSES.VideoObject;
const VIDEO_OBJECT_HTTP = VIDEO_OBJECT.replace("https://", "http://");

/**
 * Legacy `http://schema.org/` form — `categories.ts` accepts both schemes, so
 * the matcher does too in case data was written against the http vocab.
 */
const IMAGE_OBJECT_HTTP = IMAGE_OBJECT.replace("https://", "http://");
const PHOTOGRAPH_HTTP = PHOTOGRAPH.replace("https://", "http://");

/** Signature predicate that identifies an (even untyped) hosted image subject. */
const CONTENT_URL = `${SCHEMA}contentUrl`;

/** A single photo ready to render — plain + serialisable, no RDF terms. */
export interface Photo {
  /** The subject IRI (stable React key; never shown raw). */
  id: string;
  /** Display caption (`schema:name`); falls back to "Untitled photo" when absent. */
  title: string;
  /** The hosted asset IRI (`schema:contentUrl`) — the thumbnail src. */
  contentUrl?: string;
  /** Pixel width if stated (`schema:width`). */
  width?: number;
  /** Pixel height if stated (`schema:height`). */
  height?: number;
  /**
   * The resolved "Open in <source>" action derived from `schema:url`. When set,
   * the card renders the action and the raw URL is suppressed (§5).
   */
  source?: SourceMatch;
}

/** The Photos view-model: a grid of photos over every matching subject. */
export interface PhotoModel {
  items: Photo[];
}

/** Is `t` one of the photo classes (either scheme)? */
function isPhotoType(t: string): boolean {
  return (
    t === IMAGE_OBJECT ||
    t === PHOTOGRAPH ||
    t === IMAGE_OBJECT_HTTP ||
    t === PHOTOGRAPH_HTTP
  );
}

/**
 * Does any subject look like a photo? Matches on `schema:ImageObject` /
 * `schema:Photograph` type (primary, either scheme), or — for untyped data —
 * the presence of the `schema:contentUrl` signature predicate (the shape
 * rescue, §4.3). Kept to a cheap set lookup + a single predicate scan.
 */
function hasPhotoSubject(ctx: ViewerContext): boolean {
  for (const t of ctx.types) {
    if (isPhotoType(t)) return true;
  }
  for (const quad of ctx.dataset as Iterable<Quad>) {
    if (quad.predicate.value === CONTENT_URL) return true;
  }
  return false;
}

/**
 * Collect the subject IRIs that are photos: typed `ImageObject`/`Photograph`,
 * or — for untyped data — `schema:contentUrl`-shaped. Subjects explicitly typed
 * `schema:VideoObject` are excluded even though `MediaItem` writes
 * `schema:contentUrl` on them too (a mixed photo+video document keeps the videos
 * out of this photo grid; videos fall to the generic table for now).
 */
function photoSubjects(dataset: DatasetCore): string[] {
  const subjects = new Set<string>();
  const videos = new Set<string>();
  for (const quad of dataset as Iterable<Quad>) {
    if (quad.subject.termType !== "NamedNode") continue; // skip blank nodes
    const p = quad.predicate.value;
    if (p === RDF_TYPE && quad.object.termType === "NamedNode") {
      const o = quad.object.value;
      if (o === IMAGE_OBJECT || o === IMAGE_OBJECT_HTTP || o === PHOTOGRAPH || o === PHOTOGRAPH_HTTP) {
        subjects.add(quad.subject.value);
      } else if (o === VIDEO_OBJECT || o === VIDEO_OBJECT_HTTP) {
        videos.add(quad.subject.value);
      }
    } else if (p === CONTENT_URL) {
      subjects.add(quad.subject.value);
    }
  }
  for (const v of videos) subjects.delete(v);
  return [...subjects];
}

/** First literal object for `subject predicate` (e.g. title). */
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

/** First IRI object for `subject predicate` (e.g. schema:contentUrl, schema:url). */
function iri(dataset: DatasetCore, subject: string, predicate: string): string | undefined {
  for (const quad of dataset as Iterable<Quad>) {
    if (
      quad.subject.value === subject &&
      quad.predicate.value === predicate &&
      quad.object.termType === "NamedNode"
    ) {
      return quad.object.value;
    }
  }
  return undefined;
}

/** First integer-ish literal for `subject predicate` (e.g. width/height). */
function integer(dataset: DatasetCore, subject: string, predicate: string): number | undefined {
  const raw = literal(dataset, subject, predicate);
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Extract one photo from an image subject. */
function extractPhoto(dataset: DatasetCore, subject: string): Photo {
  const title = literal(dataset, subject, `${SCHEMA}name`);
  return {
    id: subject,
    title: title?.trim() ? title : "Untitled photo",
    contentUrl: iri(dataset, subject, CONTENT_URL),
    width: integer(dataset, subject, `${SCHEMA}width`),
    height: integer(dataset, subject, `${SCHEMA}height`),
    // schema:url → "Open in Google Photos"/"Open in Pinterest"; raw URL suppressed (§5).
    source: sourceActionFor(iri(dataset, subject, `${SCHEMA}url`)),
  };
}

/** The Photos {@link TypedViewer}. Priority 60 — a specific class (§4.4). */
export const photoViewer: TypedViewer<PhotoModel> = {
  id: "photo",
  priority: 60,
  matches: hasPhotoSubject,
  extract(ctx) {
    const items = photoSubjects(ctx.dataset).map((s) => extractPhoto(ctx.dataset, s));
    // Stable, human order: by title, then IRI as a deterministic tie-break.
    items.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    return { items };
  },
};
