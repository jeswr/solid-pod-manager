// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Events typed-view (design: `docs/typed-data-views.md` §2.2, P3).
 *
 * Targets the real shape this app writes for events (`CalendarEvent` in
 * `integrations/core/vocab.ts`, used by `google-calendar/adapter.ts` and the
 * Google Takeout file adapter): `schema:Event` with `schema:name` (title),
 * `schema:startDate` / `schema:endDate` (ISO-8601 dateTime literals),
 * `schema:location` (free text), and `schema:url` (the source page — the
 * calendar `htmlLink`). It is also the first-party Calendar shape.
 *
 * Pure: extracts a plain `{ items: CalendarEventItem[] }` model the React card
 * renders as date/location/title rows — no raw triples and no raw URLs. The
 * `schema:url` becomes an **"Open in Google Calendar"** action via
 * `sourceActionFor`; the raw URL is suppressed (§5). The start/end stay as the
 * raw ISO strings so the card formats them in the user's locale (the pure layer
 * must remain locale- and timezone-neutral and serialisable).
 */
import type { DatasetCore, Quad } from "@rdfjs/types";
import { SCHEMA, CLASSES } from "../integrations/core/vocab.js";
import { sourceActionFor, type SourceMatch } from "./sources.js";
import type { TypedViewer, ViewerContext } from "./types.js";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** The class the calendar adapters stamp on events. */
const EVENT = CLASSES.Event;
/** Legacy `http://schema.org/` form — `categories.ts` accepts both schemes. */
const EVENT_HTTP = EVENT.replace("https://", "http://");

const START_DATE = `${SCHEMA}startDate`;
const END_DATE = `${SCHEMA}endDate`;

/** A single event ready to render — plain + serialisable, no RDF terms. */
export interface CalendarEventItem {
  /** The subject IRI (stable React key; never shown raw). */
  id: string;
  /** Event title (`schema:name`); falls back to "Untitled event" when absent. */
  title: string;
  /** Raw ISO-8601 start (`schema:startDate`); the card formats it for display. */
  startDate?: string;
  /** Raw ISO-8601 end (`schema:endDate`). */
  endDate?: string;
  /** Free-text location (`schema:location`). */
  location?: string;
  /** Free-text description (`schema:description`). */
  description?: string;
  /**
   * The resolved "Open in Google Calendar" action derived from `schema:url`.
   * When set, the card renders the action and the raw URL is suppressed (§5).
   */
  source?: SourceMatch;
}

/** The Events view-model: a list of event cards over every matching subject. */
export interface EventModel {
  items: CalendarEventItem[];
}

/** Is `t` the event class (either scheme)? */
function isEventType(t: string): boolean {
  return t === EVENT || t === EVENT_HTTP;
}

/**
 * Does any subject look like an event? Matches on `schema:Event` type (primary,
 * either scheme), or — for untyped data — the presence of the
 * `schema:startDate` signature predicate (the shape rescue, §4.3). Kept to a
 * cheap set lookup + a single predicate scan.
 */
function hasEventSubject(ctx: ViewerContext): boolean {
  for (const t of ctx.types) {
    if (isEventType(t)) return true;
  }
  for (const quad of ctx.dataset as Iterable<Quad>) {
    if (quad.predicate.value === START_DATE) return true;
  }
  return false;
}

/** Collect the subject IRIs that are events (typed `schema:Event` or startDate-shaped). */
function eventSubjects(dataset: DatasetCore): string[] {
  const subjects = new Set<string>();
  for (const quad of dataset as Iterable<Quad>) {
    if (quad.subject.termType !== "NamedNode") continue; // skip blank nodes
    const p = quad.predicate.value;
    if (
      p === RDF_TYPE &&
      quad.object.termType === "NamedNode" &&
      (quad.object.value === EVENT || quad.object.value === EVENT_HTTP)
    ) {
      subjects.add(quad.subject.value);
    } else if (p === START_DATE) {
      subjects.add(quad.subject.value);
    }
  }
  return [...subjects];
}

/** First literal object for `subject predicate` (e.g. title, dates, location). */
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

/** First IRI object for `subject predicate` (e.g. schema:url). */
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

/** Extract one event from an event subject. */
function extractEvent(dataset: DatasetCore, subject: string): CalendarEventItem {
  const title = literal(dataset, subject, `${SCHEMA}name`);
  return {
    id: subject,
    title: title?.trim() ? title : "Untitled event",
    startDate: literal(dataset, subject, START_DATE),
    endDate: literal(dataset, subject, END_DATE),
    location: literal(dataset, subject, `${SCHEMA}location`),
    description: literal(dataset, subject, `${SCHEMA}description`),
    // schema:url → "Open in Google Calendar"; raw URL suppressed (§5).
    source: sourceActionFor(iri(dataset, subject, `${SCHEMA}url`)),
  };
}

/** Epoch ms for an ISO date string, or +Infinity when absent/unparsable (sorts last). */
function startMs(item: CalendarEventItem): number {
  if (!item.startDate) return Number.POSITIVE_INFINITY;
  const t = Date.parse(item.startDate);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/** The Events {@link TypedViewer}. Priority 60 — a specific class (§4.4). */
export const eventViewer: TypedViewer<EventModel> = {
  id: "event",
  priority: 60,
  matches: hasEventSubject,
  extract(ctx) {
    const items = eventSubjects(ctx.dataset).map((s) => extractEvent(ctx.dataset, s));
    // Chronological order (soonest first); dateless events sink to the end,
    // then IRI as a deterministic tie-break.
    items.sort((a, b) => startMs(a) - startMs(b) || a.id.localeCompare(b.id));
    return { items };
  },
};
