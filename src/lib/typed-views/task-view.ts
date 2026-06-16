// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Tasks (to-do) typed-view (design: `docs/typed-data-views.md` §4; extends P3).
 *
 * Targets the real shape the first-party Tasks app writes (`src/lib/tasks.ts`):
 * an iCalendar VTODO — `icaltzd:Vtodo` with `ical:summary` (title),
 * `ical:description`, `ical:due` (`xsd:dateTime`), `ical:status`
 * (`COMPLETED`/`NEEDS-ACTION`) + `ical:percentComplete` + `ical:completed` (any
 * of which means "done"), and `ical:priority` (the 0–9 iCal scale).
 *
 * **Scheme alignment (roborev correctness).** The `TaskDoc` accessors are
 * hard-coded to the `icaltzd#` predicate scheme, so this viewer matches ONLY
 * `icaltzd:Vtodo` — the class the Tasks app writes. The bare non-tz `ical#Vtodo`
 * class is NOT matched: it would match but then render untitled/incomplete
 * because its `ical#summary`/`ical#due`/… predicates are a different namespace
 * the extractor can't read. Such a VTODO keeps the generic table until `TaskDoc`
 * reads both schemes (a follow-up in `src/lib/tasks.ts`, the wrapper's home).
 *
 * Match is **type-only**: a VTODO is unambiguously a task by its class; no
 * signature-predicate rescue is needed (and `ical:summary` alone would be too
 * weak). Completion + priority are decoded via the SAME typed `TaskDoc` accessors
 * and pure helpers (`priorityFromIcal`) the Tasks app uses — never hand-built
 * quads, and never a second interpretation of the completion signals.
 *
 * Pure: extracts a plain `{ items: TaskItem[] }` model the React card renders as
 * a checkbox + title + due/priority — no raw triples. The due date stays a raw
 * ISO string so the card formats it for the user's locale (the pure layer must
 * remain locale-/timezone-neutral and serialisable).
 */
import type { DatasetCore, Quad } from "@rdfjs/types";
import { DataFactory } from "n3";
import { TaskDoc, TASK_CLASS, priorityFromIcal, type TaskPriority } from "../tasks.js";
import type { TypedViewer, ViewerContext } from "./types.js";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/**
 * The class a task subject carries. ONLY `icaltzd#Vtodo` — the scheme `TaskDoc`
 * reads. The non-tz `ical#Vtodo` is excluded so the matcher never accepts a
 * VTODO the extractor would render fieldless (see the docblock above).
 */
const TASK_CLASSES = new Set<string>([
  TASK_CLASS, // http://www.w3.org/2002/12/cal/icaltzd#Vtodo
]);

/** A single task ready to render — plain + serialisable, no RDF terms. */
export interface TaskItem {
  /** The subject IRI (stable React key; never shown raw). */
  id: string;
  /** Title (`ical:summary`); falls back to "Untitled task" when absent. */
  title: string;
  /** Notes (`ical:description`). */
  description?: string;
  /** Raw ISO-8601 due date (`ical:due`); the card formats it. */
  due?: string;
  /** Whether the task is done (any of status/percentComplete/completed signals). */
  completed: boolean;
  /** Priority band (`ical:priority`), decoded via the Tasks app's helper. */
  priority: TaskPriority;
}

/** The Tasks view-model: a list of task rows over every matching subject. */
export interface TaskModel {
  items: TaskItem[];
}

/** Does any subject carry one of the VTODO classes? (type-only, no shape rescue). */
function hasTaskSubject(ctx: ViewerContext): boolean {
  for (const t of ctx.types) {
    if (TASK_CLASSES.has(t)) return true;
  }
  return false;
}

/** Collect the subject IRIs that are tasks (typed VTODO only). */
function taskSubjects(dataset: DatasetCore): string[] {
  const subjects = new Set<string>();
  for (const quad of dataset as Iterable<Quad>) {
    if (quad.subject.termType !== "NamedNode") continue; // skip blank nodes
    if (
      quad.predicate.value === RDF_TYPE &&
      quad.object.termType === "NamedNode" &&
      TASK_CLASSES.has(quad.object.value)
    ) {
      subjects.add(quad.subject.value);
    }
  }
  return [...subjects];
}

/**
 * A VTODO is done if `status` is `COMPLETED`, OR `percentComplete` is 100, OR a
 * `completed` timestamp is present — the same RFC 5545 rule the Tasks app uses
 * (kept here so the card agrees with the list app on completion).
 */
function isComplete(doc: TaskDoc): boolean {
  return (
    (doc.status ?? "").toUpperCase() === "COMPLETED" ||
    doc.percentComplete === 100 ||
    doc.completedAt !== undefined
  );
}

/** Extract one task from a VTODO subject via the typed `TaskDoc` accessors. */
function extractTask(dataset: DatasetCore, subject: string): TaskItem {
  const doc = new TaskDoc(subject, dataset, DataFactory);
  const title = doc.summary;
  return {
    id: subject,
    title: title?.trim() ? title : "Untitled task",
    description: doc.description,
    due: doc.due?.toISOString(),
    completed: isComplete(doc),
    priority: priorityFromIcal(doc.priority),
  };
}

/** Numeric rank for sorting: higher priority sorts first. */
function priorityRank(p: TaskPriority): number {
  return { high: 3, medium: 2, low: 1, none: 0 }[p];
}

/** Epoch ms for an ISO due date, or +Infinity when absent (sorts last). */
function dueMs(item: TaskItem): number {
  if (!item.due) return Number.POSITIVE_INFINITY;
  const t = Date.parse(item.due);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/** The Tasks {@link TypedViewer}. Priority 60 — a specific class (§4.4). */
export const taskViewer: TypedViewer<TaskModel> = {
  id: "task",
  priority: 60,
  matches: hasTaskSubject,
  extract(ctx) {
    const items = taskSubjects(ctx.dataset).map((s) => extractTask(ctx.dataset, s));
    // List order (mirrors the Tasks app): incomplete before complete, then by
    // due date (soonest first; dateless sink), then priority (high first), then
    // title, then IRI as a deterministic tie-break.
    items.sort(
      (a, b) =>
        Number(a.completed) - Number(b.completed) ||
        dueMs(a) - dueMs(b) ||
        priorityRank(b.priority) - priorityRank(a.priority) ||
        (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" }) ||
        a.id.localeCompare(b.id),
    );
    return { items };
  },
};
