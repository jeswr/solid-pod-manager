// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Music typed-view (design: `docs/typed-data-views.md` §2.2, §4.4, P2).
 *
 * Targets the real Spotify shape this app writes (`spotify/adapter.ts` via the
 * `MusicRecording`/`MusicPlaylist` wrappers, `integrations/core/vocab.ts`):
 * `schema:MusicRecording` with `schema:name` (title), `schema:byArtist`
 * (artist text), `schema:inAlbum` (album text), `schema:duration` (ISO-8601,
 * e.g. `PT3M33S`), `schema:identifier` (Spotify id), and `schema:url` (the
 * `open.spotify.com` link). The "liked songs" / top-tracks collection shape is
 * just a multi-subject document of `MusicRecording`s — one document → a list of
 * track cards.
 *
 * Pure: extracts a plain `{ items: MusicTrack[] }` model the React card renders
 * as cover-art rows — no raw triples and no raw URLs. The `schema:url` becomes
 * an **"Open in Spotify"** action via `sourceActionFor` (the raw URL is
 * suppressed); the bare id is never shown.
 *
 * Album art: **no album-art triple is imported today** — the Spotify adapter
 * reads `album.name` only, not `album.images`. The extractor reads an image
 * triple (`schema:image` / `schema:thumbnailUrl`) **if present** so the card
 * lights up once art is imported, and the card otherwise shows a music-note
 * icon fallback. FOLLOW-UP: a one-line adapter change to also write
 * `album.images[0].url` onto `schema:image` of each `MusicRecording` would
 * populate real cover art — see the note in `spotify/adapter.ts` / docs §6 Q4.
 */
import type { DatasetCore, Quad } from "@rdfjs/types";
import { SCHEMA, CLASSES } from "../integrations/core/vocab.js";
import { sourceActionFor, type SourceMatch } from "./sources.js";
import type { TypedViewer, ViewerContext } from "./types.js";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** The class the Spotify adapter stamps on tracks. */
const MUSIC_RECORDING = CLASSES.MusicRecording;
/** Playlist sibling — a Music document may hold playlists instead of tracks. */
const MUSIC_PLAYLIST = CLASSES.MusicPlaylist;

/**
 * Legacy `http://schema.org/` form — `categories.ts` accepts both schemes, so
 * the matcher does too in case data was written against the http vocab.
 */
const MUSIC_RECORDING_HTTP = MUSIC_RECORDING.replace("https://", "http://");
const MUSIC_PLAYLIST_HTTP = MUSIC_PLAYLIST.replace("https://", "http://");

/** Signature predicate that identifies an (even untyped) recording subject. */
const BY_ARTIST = `${SCHEMA}byArtist`;

/** Image predicates the card uses *if present* (none imported today — see header). */
const IMAGE_PREDICATES = [`${SCHEMA}image`, `${SCHEMA}thumbnailUrl`] as const;

/** A single music recording ready to render — plain + serialisable, no RDF terms. */
export interface MusicTrack {
  /** The subject IRI (stable React key; never shown raw). */
  id: string;
  /** Track title (`schema:name`); falls back to "Untitled track" when absent. */
  title: string;
  /** Artist display text (`schema:byArtist`). */
  artist?: string;
  /** Album text (`schema:inAlbum`). */
  album?: string;
  /** Raw ISO-8601 duration (`schema:duration`, e.g. `PT3M33S`). */
  duration?: string;
  /**
   * Cover-art image IRI if a `schema:image`/`schema:thumbnailUrl` triple is
   * present. Today the Spotify adapter imports none, so this is normally
   * `undefined` and the card shows a music-note icon fallback. Once the adapter
   * writes `album.images[0].url`, this lights up with no card change.
   */
  imageUrl?: string;
  /**
   * The resolved "Open in Spotify" action derived from `schema:url`. When set,
   * the card renders the action and the raw URL is suppressed (§5).
   */
  source?: SourceMatch;
}

/** The Music view-model: a list of track cards over every matching subject. */
export interface MusicModel {
  items: MusicTrack[];
}

/** Is `t` one of the music classes (either scheme)? */
function isMusicType(t: string): boolean {
  return (
    t === MUSIC_RECORDING ||
    t === MUSIC_PLAYLIST ||
    t === MUSIC_RECORDING_HTTP ||
    t === MUSIC_PLAYLIST_HTTP
  );
}

/**
 * Does any subject look like music? Matches on `schema:MusicRecording` /
 * `schema:MusicPlaylist` type (primary, either scheme), or — for untyped data —
 * the presence of the `schema:byArtist` signature predicate (the shape rescue,
 * §4.3). Kept to a cheap set lookup + a single predicate scan.
 */
function hasMusicSubject(ctx: ViewerContext): boolean {
  for (const t of ctx.types) {
    if (isMusicType(t)) return true;
  }
  for (const quad of ctx.dataset as Iterable<Quad>) {
    if (quad.predicate.value === BY_ARTIST) return true;
  }
  return false;
}

/** Collect the subject IRIs that are music recordings (typed or `byArtist`-shaped). */
function recordingSubjects(dataset: DatasetCore): string[] {
  const subjects = new Set<string>();
  for (const quad of dataset as Iterable<Quad>) {
    if (quad.subject.termType !== "NamedNode") continue; // skip blank nodes
    const p = quad.predicate.value;
    if (
      p === RDF_TYPE &&
      quad.object.termType === "NamedNode" &&
      (quad.object.value === MUSIC_RECORDING || quad.object.value === MUSIC_RECORDING_HTTP)
    ) {
      subjects.add(quad.subject.value);
    } else if (p === BY_ARTIST) {
      subjects.add(quad.subject.value);
    }
  }
  return [...subjects];
}

/** First literal object for `subject predicate` (e.g. title, artist, duration). */
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

/** First IRI object for `subject predicate` (e.g. schema:url, schema:image). */
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

/**
 * Cover-art IRI for a subject, if any image triple is present (`schema:image`
 * or `schema:thumbnailUrl`, IRI or literal). Returns `undefined` today since no
 * adapter imports art — the card then shows the icon fallback.
 */
function imageFor(dataset: DatasetCore, subject: string): string | undefined {
  for (const predicate of IMAGE_PREDICATES) {
    const asIri = iri(dataset, subject, predicate);
    if (asIri) return asIri;
    const asLiteral = literal(dataset, subject, predicate);
    if (asLiteral) return asLiteral;
  }
  return undefined;
}

/** Extract one track from a recording subject. */
function extractTrack(dataset: DatasetCore, subject: string): MusicTrack {
  const title = literal(dataset, subject, `${SCHEMA}name`);
  return {
    id: subject,
    title: title?.trim() ? title : "Untitled track",
    artist: literal(dataset, subject, BY_ARTIST),
    album: literal(dataset, subject, `${SCHEMA}inAlbum`),
    duration: literal(dataset, subject, `${SCHEMA}duration`),
    imageUrl: imageFor(dataset, subject),
    // schema:url → "Open in Spotify"; raw URL is suppressed by the card (§5).
    source: sourceActionFor(iri(dataset, subject, `${SCHEMA}url`)),
  };
}

/**
 * Humanise an ISO-8601 track duration (`PT3M33S` → `3:33`, `PT1H2M3S` →
 * `1:02:03`) for display. Pure + serialisable-friendly; the card calls it.
 * Returns `undefined` for absent or unparsable input (the card then omits it).
 * Only the H/M/S components are read (tracks never carry days).
 */
export function humanizeDuration(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso.trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2] ?? 0);
  const s = Number(m[3] ?? 0);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(min)}:${pad(s)}` : `${min}:${pad(s)}`;
}

/** The Music {@link TypedViewer}. Priority 70 — a specific class (§4.4). */
export const musicViewer: TypedViewer<MusicModel> = {
  id: "music",
  priority: 70,
  matches: hasMusicSubject,
  extract(ctx) {
    const items = recordingSubjects(ctx.dataset).map((s) => extractTrack(ctx.dataset, s));
    // Stable, human order: by title, then IRI as a deterministic tie-break.
    items.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    return { items };
  },
};
