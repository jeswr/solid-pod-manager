// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Tasks (to-do) — one `icaltzd:Vtodo` per resource under `tasks/`.
 *
 * **Class choice.** We use the iCalendar VTODO term
 * `http://www.w3.org/2002/12/cal/icaltzd#Vtodo` — the same `icaltzd` family the
 * Calendar app already declares for events in `categories.ts`
 * (`icaltzd#Vevent`). Picking the iCal vocabulary (rather than
 * `schema:Action`/`ToDoList`) means a task round-trips cleanly to a `.ics`
 * `VTODO` for import/export (`src/lib/ical.ts`) and is re-readable by SolidOS's
 * task pane, which is also iCal-based.
 *
 * Fields map to iCal properties: `ical:summary` (title), `ical:description`,
 * `ical:due` (`xsd:dateTime`), `ical:status` (`NEEDS-ACTION` / `COMPLETED`) +
 * `ical:percentComplete`, `ical:priority` (`0`–`9`, iCal's scale).
 *
 * Mirrors the structure of `calendar.ts` / `contacts.ts`: a typed
 * `@rdfjs/wrapper` doc, a pure parse/build pair, a `StoreConfig`, and a store
 * factory. Pure sort/group helpers are separated from I/O so the list UI logic
 * is unit-testable without a pod (house rule: never hand-build quads).
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

const ICAL = "http://www.w3.org/2002/12/cal/icaltzd#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** The RDF class a task is stamped + registered with. */
export const TASK_CLASS = `${ICAL}Vtodo`;

/** Container slug under the pod root. */
export const TASKS_SLUG = "tasks/";

const PREFIXES = { ical: ICAL } as const;

/** Task priority bands the UI offers, mapped to the iCal 0–9 priority scale. */
export type TaskPriority = "none" | "low" | "medium" | "high";

/** iCal stores priority as 0 (undefined) / 1–4 (high) / 5 (medium) / 6–9 (low). */
const PRIORITY_TO_ICAL: Record<TaskPriority, number | undefined> = {
  none: undefined,
  high: 1,
  medium: 5,
  low: 9,
};

/** Map an iCal numeric priority back to a UI band (RFC 5545 §3.8.1.9 bands). */
export function priorityFromIcal(value: number | undefined): TaskPriority {
  if (value === undefined || value === 0) return "none";
  if (value <= 4) return "high";
  if (value === 5) return "medium";
  return "low";
}

/** Map a UI priority band to its iCal numeric value (`undefined` for "none"). */
export function priorityToIcal(priority: TaskPriority): number | undefined {
  return PRIORITY_TO_ICAL[priority];
}

/** A task as the UI works with it (plain, serialisable). */
export interface Task {
  /** Title — `ical:summary`. */
  title: string;
  /** Notes — `ical:description`. */
  description?: string;
  /** Due date/time — `ical:due` (optional). */
  due?: Date;
  /** Whether the task is done — `ical:status` `COMPLETED` vs `NEEDS-ACTION`. */
  completed: boolean;
  /** Priority band — `ical:priority`. */
  priority: TaskPriority;
}

/** Typed `@rdfjs/wrapper` view of a single task's subject. */
export class TaskDoc extends TermWrapper {
  get types(): Set<string> {
    return SetFrom.subjectPredicate(this, RDF_TYPE, NamedNodeAs.string, NamedNodeFrom.string);
  }
  mark(): this {
    this.types.add(TASK_CLASS);
    return this;
  }
  get summary(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${ICAL}summary`, LiteralAs.string);
  }
  set summary(v: string | undefined) {
    OptionalAs.object(this, `${ICAL}summary`, v, LiteralFrom.string);
  }
  get description(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${ICAL}description`, LiteralAs.string);
  }
  set description(v: string | undefined) {
    OptionalAs.object(this, `${ICAL}description`, v, LiteralFrom.string);
  }
  get due(): Date | undefined {
    return OptionalFrom.subjectPredicate(this, `${ICAL}due`, LiteralAs.date);
  }
  set due(v: Date | undefined) {
    OptionalAs.object(this, `${ICAL}due`, v, LiteralFrom.dateTime);
  }
  /** `ical:status` — `COMPLETED` / `NEEDS-ACTION` / `IN-PROCESS` etc. */
  get status(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${ICAL}status`, LiteralAs.string);
  }
  set status(v: string | undefined) {
    OptionalAs.object(this, `${ICAL}status`, v, LiteralFrom.string);
  }
  get priority(): number | undefined {
    return OptionalFrom.subjectPredicate(this, `${ICAL}priority`, LiteralAs.number);
  }
  set priority(v: number | undefined) {
    OptionalAs.object(this, `${ICAL}priority`, v, LiteralFrom.integer);
  }
  /** `ical:percentComplete` — `100` is "done" even without `status` (RFC 5545). */
  get percentComplete(): number | undefined {
    return OptionalFrom.subjectPredicate(this, `${ICAL}percentComplete`, LiteralAs.number);
  }
  set percentComplete(v: number | undefined) {
    OptionalAs.object(this, `${ICAL}percentComplete`, v, LiteralFrom.integer);
  }
  /** `ical:completed` — a completion timestamp; its presence also means "done". */
  get completedAt(): Date | undefined {
    return OptionalFrom.subjectPredicate(this, `${ICAL}completed`, LiteralAs.date);
  }
  set completedAt(v: Date | undefined) {
    OptionalAs.object(this, `${ICAL}completed`, v, LiteralFrom.dateTime);
  }
}

/**
 * A VTODO is done if its `status` is `COMPLETED`, OR `percentComplete` is 100,
 * OR a `completed` timestamp is present — different apps signal completion
 * differently (RFC 5545 §3.8.1.11 / §3.8.1.8 / §3.8.2.1).
 */
function isTaskComplete(opts: {
  status?: string;
  percentComplete?: number;
  completedAt?: Date;
}): boolean {
  return (
    (opts.status ?? "").toUpperCase() === "COMPLETED" ||
    opts.percentComplete === 100 ||
    opts.completedAt !== undefined
  );
}

/** Parse a task document into a {@link Task}, or `undefined` if it is not one. */
export function parseTask(
  itemUrl: string,
  dataset: import("@rdfjs/types").DatasetCore,
): Task | undefined {
  const doc = new TaskDoc(`${itemUrl}#it`, dataset, DataFactory);
  if (!doc.types.has(TASK_CLASS)) return undefined;
  return {
    title: doc.summary ?? "",
    description: doc.description,
    due: doc.due,
    completed: isTaskComplete({
      status: doc.status,
      percentComplete: doc.percentComplete,
      completedAt: doc.completedAt,
    }),
    priority: priorityFromIcal(doc.priority),
  };
}

/** Serialise a {@link Task} into a fresh dataset rooted at `${itemUrl}#it`. */
export function buildTask(itemUrl: string, task: Task): Store {
  const store = new Store();
  const doc = new TaskDoc(`${itemUrl}#it`, store, DataFactory).mark();
  doc.summary = task.title || undefined;
  doc.description = task.description || undefined;
  doc.due = task.due;
  // Write all three completion signals consistently so other apps agree.
  doc.status = task.completed ? "COMPLETED" : "NEEDS-ACTION";
  doc.percentComplete = task.completed ? 100 : undefined;
  doc.priority = priorityToIcal(task.priority);
  return store;
}

/** The store config — wires the typed parse/build into the shared CRUD. */
export const TASKS_CONFIG: StoreConfig<Task> = {
  containerSlug: TASKS_SLUG,
  forClass: TASK_CLASS,
  prefixes: PREFIXES,
  parse: parseTask,
  build: buildTask,
};

/** Build a Tasks store bound to the active pod + WebID. */
export function tasksStore(opts: {
  podRoot: string;
  webId: string;
  fetchImpl?: typeof fetch;
}): ProductivityStore<Task> {
  return createStore(TASKS_CONFIG, opts);
}

// ── Pure ordering helpers (no I/O — unit-testable) ─────────────────────────

type TaskItem = StoredItem<Task>;

/** Numeric rank for sorting: higher priority sorts first. */
function priorityRank(p: TaskPriority): number {
  return { high: 3, medium: 2, low: 1, none: 0 }[p];
}

/**
 * Order tasks for the list view: incomplete before complete, then by due date
 * (soonest first; tasks with no due date sink below dated ones), then by
 * priority (high first), then title. Deterministic and total.
 */
export function sortTasks(items: TaskItem[]): TaskItem[] {
  return [...items].sort((a, b) => {
    const ta = a.data;
    const tb = b.data;
    if (ta.completed !== tb.completed) return ta.completed ? 1 : -1;
    const da = ta.due?.getTime();
    const db = tb.due?.getTime();
    if (da !== db) {
      if (da === undefined) return 1;
      if (db === undefined) return -1;
      return da - db;
    }
    const pr = priorityRank(tb.priority) - priorityRank(ta.priority);
    if (pr !== 0) return pr;
    return (ta.title || "").localeCompare(tb.title || "", undefined, { sensitivity: "base" });
  });
}

/** A task is overdue if it has a due date in the past and is not yet complete. */
export function isOverdue(task: Task, now: Date = new Date()): boolean {
  return !task.completed && task.due !== undefined && task.due.getTime() < now.getTime();
}
