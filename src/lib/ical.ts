// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * iCalendar (RFC 5545) import/export for the Calendar (`VEVENT`) and Tasks
 * (`VTODO`) apps.
 *
 * **Why a focused in-repo (de)serialiser, not a dependency.** The bounded field
 * set we round-trip (summary/description/location/dtstart/dtend/due/status/
 * priority) is a small, well-specified slice of RFC 5545. A hand-written parser
 * for *this slice* — with correct line-unfolding, value-escaping and the two
 * date forms — is far smaller and safer to review than pulling a general iCal
 * library (and its transitive surface) into a Solid client. The package
 * guardrail was run before defaulting to this approach; we add no parser dep.
 *
 * Pure (no I/O, no RDF): operates on the plain `CalendarEvent` / `Task` shapes
 * the apps already use, so it round-trips through the same types the
 * `ProductivityStore` reads and writes.
 *
 * **Timezone scope (known limitation).** We export every date-time in UTC (the
 * `…Z` form), which round-trips losslessly. On *import* we handle three value
 * forms: UTC (`…Z`), floating local date-time, and date-only (`VALUE=DATE`). A
 * value qualified by a `TZID` parameter (e.g. `DTSTART;TZID=Europe/London:…`)
 * is read as floating wall-clock in the *importer's* local zone, because
 * resolving named zones needs a timezone database we deliberately do not pull
 * in. For a foreign-zone import this can shift the time by the zone offset; the
 * data is preserved, never dropped. Most app-authored and UTC exports are
 * unaffected. A tz-aware import is a follow-up if real exports need it.
 */
import type { CalendarEvent } from "./calendar.js";
import { type Task, type TaskPriority, priorityFromIcal, priorityToIcal } from "./tasks.js";
import { foldContentLine } from "./line-fold.js";

const PRODID = "-//Solid Pod Manager//EN";

// ── value escaping (RFC 5545 §3.3.11) ──────────────────────────────────────

/** Escape a TEXT value: backslash, semicolon, comma, newline (CR/CRLF → `\n`). */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n?/g, "\n") // normalise CR / CRLF to a single LF first
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

/** Reverse {@link escapeText} for a parsed TEXT value. */
function unescapeText(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\" && i + 1 < value.length) {
      const n = value[++i];
      out += n === "n" || n === "N" ? "\n" : n;
    } else {
      out += c;
    }
  }
  return out;
}

// ── date/time (UTC form, RFC 5545 §3.3.5) ──────────────────────────────────

/** Format a `Date` as a UTC iCal date-time, e.g. `20260701T093000Z`. */
export function formatICalDate(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
  );
}

/**
 * Parse an iCal date or date-time value into a `Date`. Accepts the UTC form
 * (`…Z`), floating local date-time, and date-only (`YYYYMMDD`). Returns
 * `undefined` for an unparseable value.
 */
export function parseICalDate(value: string): Date | undefined {
  const v = value.trim();
  let m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (m) {
    const [, y, mo, d, h, mi, s, z] = m;
    return buildChecked(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s), !!z);
  }
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) {
    return buildChecked(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, 0, false);
  }
  return undefined;
}

/**
 * Construct a `Date` from calendar fields, rejecting out-of-range values.
 * `new Date()` silently rolls over (`20260231` → 3 Mar); we read the fields back
 * and require they match what was parsed, so a malformed value is rejected
 * rather than imported at the wrong instant.
 */
function buildChecked(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  second: number,
  utc: boolean,
): Date | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  if (hour > 23 || minute > 59 || second > 60) return undefined; // 60 allows a leap second
  const date = utc
    ? new Date(Date.UTC(year, month - 1, day, hour, minute, second))
    : new Date(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(date.getTime())) return undefined;
  const get = utc
    ? [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes()]
    : [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()];
  // Second may legitimately normalise (leap second → :00 next minute is rare);
  // validate the stable fields. A rolled-over day/month means the input was invalid.
  if (get[0] !== year || get[1] !== month || get[2] !== day || get[3] !== hour || get[4] !== minute) {
    return undefined;
  }
  return date;
}

// ── line folding (RFC 5545 §3.1) ───────────────────────────────────────────

/** Unfold the raw text: join continuation lines (leading space/tab) into one. */
function unfold(text: string): string[] {
  // Strip a leading UTF-8 BOM so the first line is `BEGIN:VCALENDAR`.
  const raw = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

/** Emit a `NAME:value` property line, escaped + folded. */
function prop(name: string, value: string): string {
  return foldContentLine(`${name}:${escapeText(value)}`);
}

/** Split a content line into its property name, parameter segment, and value. */
function splitLine(line: string): { name: string; params: string; value: string } | undefined {
  const idx = line.indexOf(":");
  if (idx < 0) return undefined;
  const namePart = line.slice(0, idx);
  const value = line.slice(idx + 1);
  const segs = namePart.split(";");
  const name = segs[0].trim().toUpperCase();
  const params = segs.slice(1).join(";").toUpperCase();
  return { name, params, value };
}

// ── export ─────────────────────────────────────────────────────────────────

/**
 * A short, stable hash (FNV-1a, base36) of the parts that identify a component.
 * Deterministic so the *same* event/task exports to the *same* UID every time —
 * calendar clients dedupe and track updates by UID, so a random UID would create
 * a duplicate on every re-import.
 */
function stableHash(parts: readonly string[]): string {
  let h = 0x811c9dc5;
  const input = parts.join("|");
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** A stable, RFC-valid UID for an exported component (derived, no PII leaked raw). */
function uid(kind: string, idParts: readonly string[]): string {
  return `${kind}-${stableHash(idParts)}@solid-pod-manager`;
}

/**
 * Pick the UID seed: the resource's own pod URL when available (stable +
 * globally unique per item, so two same-titled events keep distinct UIDs), else
 * fall back to the content fields (best effort for ad-hoc exports).
 */
function eventBlock(event: CalendarEvent, sourceUrl?: string): string[] {
  const id = sourceUrl
    ? uid("event", [sourceUrl])
    : uid("event", [event.name, formatICalDate(event.start), event.end ? formatICalDate(event.end) : ""]);
  const lines = ["BEGIN:VEVENT", prop("UID", id), prop("DTSTAMP", formatICalDate(new Date()))];
  if (event.name) lines.push(prop("SUMMARY", event.name));
  lines.push(prop("DTSTART", formatICalDate(event.start)));
  if (event.end) lines.push(prop("DTEND", formatICalDate(event.end)));
  if (event.location) lines.push(prop("LOCATION", event.location));
  if (event.description) lines.push(prop("DESCRIPTION", event.description));
  lines.push("END:VEVENT");
  return lines;
}

function todoBlock(task: Task, sourceUrl?: string): string[] {
  const id = sourceUrl
    ? uid("task", [sourceUrl])
    : uid("task", [task.title, task.due ? formatICalDate(task.due) : ""]);
  const lines = ["BEGIN:VTODO", prop("UID", id), prop("DTSTAMP", formatICalDate(new Date()))];
  if (task.title) lines.push(prop("SUMMARY", task.title));
  if (task.description) lines.push(prop("DESCRIPTION", task.description));
  if (task.due) lines.push(prop("DUE", formatICalDate(task.due)));
  lines.push(prop("STATUS", task.completed ? "COMPLETED" : "NEEDS-ACTION"));
  // Emit PERCENT-COMPLETE too so clients that read only that field agree.
  lines.push(prop("PERCENT-COMPLETE", task.completed ? "100" : "0"));
  const pr = priorityToIcal(task.priority);
  if (pr !== undefined) lines.push(prop("PRIORITY", String(pr)));
  lines.push("END:VTODO");
  return lines;
}

/** An exportable item plus its optional stable source URL (for a stable UID). */
export interface ExportItem<T> {
  data: T;
  /** The item's pod resource URL — used as the UID seed when present. */
  url?: string;
}

/**
 * Serialise events + tasks into a single `.ics` `VCALENDAR` document. Items may
 * be passed as plain shapes or as `{ data, url }` — when a `url` is given it
 * seeds a stable, collision-free UID (recommended; pass the `StoredItem`).
 */
export function exportICal(opts: {
  events?: readonly (CalendarEvent | ExportItem<CalendarEvent>)[];
  tasks?: readonly (Task | ExportItem<Task>)[];
}): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${PRODID}`, "CALSCALE:GREGORIAN"];
  for (const e of opts.events ?? []) {
    const { data, url } = asExportItem<CalendarEvent>(e, "start");
    lines.push(...eventBlock(data, url));
  }
  for (const t of opts.tasks ?? []) {
    const { data, url } = asExportItem<Task>(t, "title");
    lines.push(...todoBlock(data, url));
  }
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

/** Normalise a plain shape or an `{ data, url }` wrapper into an `ExportItem`. */
function asExportItem<T>(item: T | ExportItem<T>, dataKey: keyof T): ExportItem<T> {
  // A wrapper has `data` but not the data's own discriminating key at top level.
  if (item && typeof item === "object" && "data" in item && !(dataKey in (item as object))) {
    return item as ExportItem<T>;
  }
  return { data: item as T };
}

// ── import ───────────────────────────────────────────────────────────────

/** The components parsed out of an `.ics` document. */
export interface ParsedICal {
  events: CalendarEvent[];
  tasks: Task[];
  /**
   * How many components carried a recurrence rule (`RRULE`/`RDATE`/`EXDATE`).
   * We import the single base occurrence (not the whole series — expanding
   * recurrences needs a rule engine we deliberately do not pull in), and the UI
   * surfaces this count so the user knows repeats were not expanded.
   */
  recurringCount: number;
  /**
   * How many components carried a `TZID`-qualified date (e.g.
   * `DTSTART;TZID=America/New_York:…`). Those values are read as the importer's
   * local wall-clock (no embedded tz database — see the module doc), so the UI
   * surfaces this count to warn the time may be offset.
   */
  timezoneQualifiedCount: number;
  /**
   * How many components were all-day (`VALUE=DATE`, e.g. `DTSTART;VALUE=DATE:…`).
   * The app's event/task model has no all-day flag, so these import as a timed
   * event at local midnight and re-export as a UTC date-time — the UI surfaces
   * this count to warn the all-day semantics aren't preserved.
   */
  dateOnlyCount: number;
}

/** Recurrence properties we detect (and warn about) but do not expand. */
const RECURRENCE_PROPS = new Set(["RRULE", "RDATE", "EXDATE"]);

/** A scratch bag of the properties we care about while scanning one component. */
type Bag = Map<string, string>;

function bagEvent(bag: Bag): CalendarEvent | undefined {
  const start = bag.has("DTSTART") ? parseICalDate(bag.get("DTSTART") as string) : undefined;
  if (!start) return undefined; // an event needs a start to be usable
  const end = bag.has("DTEND") ? parseICalDate(bag.get("DTEND") as string) : undefined;
  return {
    name: unescapeText(bag.get("SUMMARY") ?? ""),
    start,
    end,
    location: bag.has("LOCATION") ? unescapeText(bag.get("LOCATION") as string) : undefined,
    description: bag.has("DESCRIPTION") ? unescapeText(bag.get("DESCRIPTION") as string) : undefined,
  };
}

function bagTask(bag: Bag): Task {
  const due = bag.has("DUE") ? parseICalDate(bag.get("DUE") as string) : undefined;
  const status = (bag.get("STATUS") ?? "").toUpperCase();
  const priorityNum = bag.has("PRIORITY") ? Number(bag.get("PRIORITY")) : undefined;
  const priority: TaskPriority = priorityFromIcal(
    priorityNum !== undefined && Number.isFinite(priorityNum) ? priorityNum : undefined,
  );
  // A VTODO is done via STATUS:COMPLETED, PERCENT-COMPLETE:100, or a COMPLETED
  // timestamp — apps signal completion differently (RFC 5545).
  const percent = bag.has("PERCENT-COMPLETE") ? Number(bag.get("PERCENT-COMPLETE")) : undefined;
  const completed = status === "COMPLETED" || percent === 100 || bag.has("COMPLETED");
  return {
    title: unescapeText(bag.get("SUMMARY") ?? ""),
    description: bag.has("DESCRIPTION") ? unescapeText(bag.get("DESCRIPTION") as string) : undefined,
    due,
    completed,
    priority,
  };
}

/**
 * Parse an `.ics` document into events + tasks. Resilient: unknown components
 * and properties are ignored, and a malformed component is skipped rather than
 * failing the whole parse.
 */
export function importICal(text: string): ParsedICal {
  const events: CalendarEvent[] = [];
  const tasks: Task[] = [];
  let recurringCount = 0;
  let timezoneQualifiedCount = 0;
  let dateOnlyCount = 0;
  // A component stack so nested components (e.g. a `VALARM` inside a `VEVENT`)
  // don't leak their properties up: we only capture properties whose immediate
  // enclosing component is the VEVENT/VTODO itself.
  const stack: string[] = [];
  let current: "VEVENT" | "VTODO" | null = null;
  let bag: Bag = new Map();
  let recurringHere = false;
  let tzHere = false;
  let dateOnlyHere = false;

  for (const line of unfold(text)) {
    const parsed = splitLine(line);
    if (!parsed) continue;
    const { name, params, value } = parsed;

    if (name === "BEGIN") {
      const comp = value.trim().toUpperCase();
      stack.push(comp);
      if ((comp === "VEVENT" || comp === "VTODO") && current === null) {
        current = comp;
        bag = new Map();
        recurringHere = false;
        tzHere = false;
        dateOnlyHere = false;
      }
      continue;
    }
    if (name === "END") {
      const comp = value.trim().toUpperCase();
      stack.pop();
      if (comp === current) {
        if (current === "VEVENT") {
          const e = bagEvent(bag);
          if (e) {
            events.push(e);
            if (recurringHere) recurringCount += 1;
            if (tzHere) timezoneQualifiedCount += 1;
            if (dateOnlyHere) dateOnlyCount += 1;
          }
        } else if (current === "VTODO") {
          tasks.push(bagTask(bag));
          if (recurringHere) recurringCount += 1;
          if (tzHere) timezoneQualifiedCount += 1;
          if (dateOnlyHere) dateOnlyCount += 1;
        }
        current = null;
      }
      continue;
    }
    // Only capture properties that are direct children of the active
    // VEVENT/VTODO (top of the stack), never of a nested component.
    if (current && stack[stack.length - 1] === current) {
      if (RECURRENCE_PROPS.has(name)) recurringHere = true;
      // TZID / VALUE=DATE on a date property: the value is zone-qualified or
      // all-day. Both are imported best-effort and flagged for a UI warning.
      if (name === "DTSTART" || name === "DTEND" || name === "DUE") {
        if (params.includes("TZID=")) tzHere = true;
        // VALUE=DATE exactly (not VALUE=DATE-TIME): an all-day date.
        if (/(?:^|;)VALUE=DATE(?:;|$)/.test(params)) dateOnlyHere = true;
      }
      if (!bag.has(name)) bag.set(name, value); // first occurrence wins
    }
  }

  return { events, tasks, recurringCount, timezoneQualifiedCount, dateOnlyCount };
}
