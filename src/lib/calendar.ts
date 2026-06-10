/**
 * Calendar — events stored one-per-resource under `calendar/`.
 *
 * Class: `schema:Event` — the exact term already in this app's Calendar
 * category class list (`src/lib/categories.ts`), so events map into the
 * "Calendar" bucket under "My data".
 *
 * Fields: `schema:name`, `schema:startDate`, `schema:endDate`,
 * `schema:location` (plain text — schema.org allows Text for location),
 * `schema:description`. Dates are `xsd:dateTime` literals.
 *
 * Pure grouping/agenda helpers (sortByStart, groupByMonth, monthMatrix) are
 * separated from I/O so the UI's agenda + month-grid logic is unit-testable
 * without a pod.
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
import {
  createStore,
  type ProductivityStore,
  type StoredItem,
  type StoreConfig,
} from "./productivity-store.js";

const SCHEMA = "https://schema.org/";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** The RDF class an event is stamped + registered with. */
export const EVENT_CLASS = `${SCHEMA}Event`;

/** Container slug under the pod root. */
export const CALENDAR_SLUG = "calendar/";

const PREFIXES = { schema: SCHEMA } as const;

/** An event as the UI works with it (plain, serialisable). */
export interface CalendarEvent {
  /** Title — `schema:name`. */
  name: string;
  /** Start — `schema:startDate`. */
  start: Date;
  /** End — `schema:endDate` (optional; open-ended events omit it). */
  end?: Date;
  /** Place — `schema:location` (free text). */
  location?: string;
  /** Notes — `schema:description`. */
  description?: string;
}

/** Typed `@rdfjs/wrapper` view of a single event's subject. */
export class EventDoc extends TermWrapper {
  get types(): Set<string> {
    return SetFrom.subjectPredicate(this, RDF_TYPE, NamedNodeAs.string, NamedNodeFrom.string);
  }
  mark(): this {
    this.types.add(EVENT_CLASS);
    return this;
  }
  get name(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}name`, LiteralAs.string);
  }
  set name(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}name`, v, LiteralFrom.string);
  }
  get start(): Date | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}startDate`, LiteralAs.date);
  }
  set start(v: Date | undefined) {
    OptionalAs.object(this, `${SCHEMA}startDate`, v, LiteralFrom.dateTime);
  }
  get end(): Date | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}endDate`, LiteralAs.date);
  }
  set end(v: Date | undefined) {
    OptionalAs.object(this, `${SCHEMA}endDate`, v, LiteralFrom.dateTime);
  }
  get location(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}location`, LiteralAs.string);
  }
  set location(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}location`, v, LiteralFrom.string);
  }
  get description(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}description`, LiteralAs.string);
  }
  set description(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}description`, v, LiteralFrom.string);
  }
}

/**
 * Parse an event document into a {@link CalendarEvent}, or `undefined` if it is
 * not one (or has no start date — a start is the minimum for a usable event).
 */
export function parseEvent(
  itemUrl: string,
  dataset: import("@rdfjs/types").DatasetCore,
): CalendarEvent | undefined {
  const doc = new EventDoc(`${itemUrl}#it`, dataset, DataFactory);
  if (!doc.types.has(EVENT_CLASS)) return undefined;
  const start = doc.start;
  if (!start) return undefined;
  return {
    name: doc.name ?? "",
    start,
    end: doc.end,
    location: doc.location,
    description: doc.description,
  };
}

/** Serialise a {@link CalendarEvent} into a fresh dataset rooted at `${itemUrl}#it`. */
export function buildEvent(itemUrl: string, event: CalendarEvent): Store {
  const store = new Store();
  const doc = new EventDoc(`${itemUrl}#it`, store, DataFactory).mark();
  doc.name = event.name || undefined;
  doc.start = event.start;
  doc.end = event.end;
  doc.location = event.location || undefined;
  doc.description = event.description || undefined;
  return store;
}

/** The store config — wires the typed parse/build into the shared CRUD. */
export const CALENDAR_CONFIG: StoreConfig<CalendarEvent> = {
  containerSlug: CALENDAR_SLUG,
  forClass: EVENT_CLASS,
  prefixes: PREFIXES,
  parse: parseEvent,
  build: buildEvent,
};

/** Build a Calendar store bound to the active pod + WebID. */
export function calendarStore(opts: {
  podRoot: string;
  webId: string;
  fetchImpl?: typeof fetch;
}): ProductivityStore<CalendarEvent> {
  return createStore(CALENDAR_CONFIG, opts);
}

// ── Pure agenda / month-grid helpers (no I/O — unit-testable) ──────────────

type EventItem = StoredItem<CalendarEvent>;

/** Sort events ascending by start time (chronological agenda order). */
export function sortByStart(items: EventItem[]): EventItem[] {
  return [...items].sort((a, b) => a.data.start.getTime() - b.data.start.getTime());
}

/** Stable `YYYY-MM` key for an event's start month (local time). */
export function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** Stable `YYYY-MM-DD` key for a date (local time). */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

/** A day's worth of events for the agenda view. */
export interface AgendaDay {
  /** `YYYY-MM-DD` key. */
  key: string;
  /** Midnight of the day (local). */
  date: Date;
  events: EventItem[];
}

/**
 * Group events into chronological day buckets for an agenda list. Each day is
 * sorted by start time; days are returned earliest-first.
 */
export function groupByDay(items: EventItem[]): AgendaDay[] {
  const byKey = new Map<string, AgendaDay>();
  for (const item of sortByStart(items)) {
    const start = item.data.start;
    const key = dayKey(start);
    let day = byKey.get(key);
    if (!day) {
      day = { key, date: new Date(start.getFullYear(), start.getMonth(), start.getDate()), events: [] };
      byKey.set(key, day);
    }
    day.events.push(item);
  }
  return [...byKey.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** One cell of a month grid. */
export interface MonthCell {
  date: Date;
  /** False for the leading/trailing days that belong to an adjacent month. */
  inMonth: boolean;
  events: EventItem[];
}

/**
 * Build a 6-row × 7-column month matrix (weeks start Sunday) for the month
 * containing `anchor`, with each cell carrying that day's events. Always 42
 * cells so the grid never reflows between months.
 */
export function monthMatrix(anchor: Date, items: EventItem[]): MonthCell[][] {
  const byDay = new Map<string, EventItem[]>();
  for (const item of items) {
    const k = dayKey(item.data.start);
    const list = byDay.get(k) ?? [];
    list.push(item);
    byDay.set(k, list);
  }

  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const gridStart = new Date(first);
  gridStart.setDate(1 - first.getDay()); // back up to the Sunday on/before the 1st

  const weeks: MonthCell[][] = [];
  const cursor = new Date(gridStart);
  for (let w = 0; w < 6; w++) {
    const week: MonthCell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(cursor);
      const dayEvents = sortByStart(byDay.get(dayKey(date)) ?? []);
      week.push({ date, inMonth: date.getMonth() === anchor.getMonth(), events: dayEvents });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}
