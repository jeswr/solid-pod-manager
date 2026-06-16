// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Issues typed-view (design: `docs/typed-data-views.md` §4; extends P3; the
 * federation linchpin — pss-77n).
 *
 * Targets the SHARED federated task shape (`@jeswr/solid-task-model`): a
 * `wf:Task` with `dct:title`, `wf:description`/`dct:description`, `dct:created`,
 * state via `rdf:type wf:Open`/`wf:Closed`, an optional `wf:assignee` WebID, and
 * `prov:endedAtTime` on close. This is the SAME contract the first-party Issues
 * tracker (`src/lib/issues.ts`) and solid-issues write — so an issue authored in
 * solid-issues renders as a friendly card here (and vice-versa), the whole point
 * of the shared model.
 *
 * RDF read goes through the shared model's typed `Task` accessor (the `./task`
 * browser-safe subpath — never `node:fs`) plus PM's `typesToState` to recover
 * the app-local three-band state (open / in-progress / closed); never hand-built
 * quads. A foreign consumer that only knows `wf:Open`/`wf:Closed` still reads the
 * card correctly — the in-progress band is a PM-local refinement layered on top.
 *
 * Match is **type-only** on `wf:Task`: the class is unambiguous and there is no
 * weaker signature predicate worth a shape-rescue.
 *
 * Pure: extracts a plain `{ items: IssueItem[] }` model the React card renders as
 * a state badge + title + assignee + created-time + a body preview — no raw
 * triples. Dates stay raw ISO strings so the card formats them in the user's
 * locale (the pure layer stays locale-/timezone-neutral and serialisable).
 */
import type { DatasetCore, Quad } from "@rdfjs/types";
import { DataFactory } from "n3";
import { Task } from "@jeswr/solid-task-model/task";
import { ISSUE_CLASS, normalizeState, typesToState, type IssueState } from "../issues.js";
import type { TypedViewer, ViewerContext } from "./types.js";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** A single issue ready to render — plain + serialisable, no RDF terms. */
export interface IssueItem {
  /** The subject IRI (stable React key; never shown raw). */
  id: string;
  /** Title (`dct:title`); falls back to "Untitled issue" when absent. */
  title: string;
  /** Body (`wf:description`/`dct:description`, read via the shared model). */
  description?: string;
  /** Lifecycle band — open / in-progress / closed. */
  state: IssueState;
  /** Raw ISO-8601 created time (`dct:created`); the card formats it. */
  created?: string;
  /** Raw ISO-8601 closed time (`prov:endedAtTime`); set on close. */
  endedAt?: string;
  /**
   * Assignee WebID (`wf:assignee`). Surfaced as a value for a compact display;
   * never auto-linked (it is a WebID IRI, not a navigable page).
   */
  assignee?: string;
}

/** The Issues view-model: a list of issue cards over every matching subject. */
export interface IssueModel {
  items: IssueItem[];
}

/** Does any subject carry the `wf:Task` class? (type-only). */
function hasIssueSubject(ctx: ViewerContext): boolean {
  return ctx.types.has(ISSUE_CLASS);
}

/** Collect the subject IRIs that are issues (typed `wf:Task` only). */
function issueSubjects(dataset: DatasetCore): string[] {
  const subjects = new Set<string>();
  for (const quad of dataset as Iterable<Quad>) {
    if (quad.subject.termType !== "NamedNode") continue; // skip blank nodes
    if (
      quad.predicate.value === RDF_TYPE &&
      quad.object.termType === "NamedNode" &&
      quad.object.value === ISSUE_CLASS
    ) {
      subjects.add(quad.subject.value);
    }
  }
  return [...subjects];
}

/**
 * Extract one issue from a `wf:Task` subject via the shared `Task` accessor.
 * State uses PM's `typesToState` (three-band, recovering the in-progress subclass
 * alongside `wf:Open`); when no canonical state type is present we default to
 * "open" (the same default the Issues store applies — `normalizeState` of an
 * absent value).
 */
function extractIssue(dataset: DatasetCore, subject: string): IssueItem {
  const doc = new Task(subject, dataset, DataFactory);
  const title = doc.title;
  const state = typesToState(doc.types) ?? normalizeState(undefined);
  return {
    id: subject,
    title: title?.trim() ? title : "Untitled issue",
    description: doc.description,
    state,
    created: doc.created?.toISOString(),
    endedAt: doc.endedAt?.toISOString(),
    assignee: doc.assignee,
  };
}

/** Sort rank by state (open first, then in-progress, then closed). */
const STATE_RANK: Record<IssueState, number> = { open: 0, "in-progress": 1, closed: 2 };

/** Epoch ms for an ISO created date, or -Infinity when absent (sorts last). */
function createdMs(item: IssueItem): number {
  if (!item.created) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(item.created);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** The Issues {@link TypedViewer}. Priority 60 — a specific class (§4.4). */
export const issueViewer: TypedViewer<IssueModel> = {
  id: "issue",
  priority: 60,
  matches: hasIssueSubject,
  extract(ctx) {
    const items = issueSubjects(ctx.dataset).map((s) => extractIssue(ctx.dataset, s));
    // Open issues first (mirrors the Issues app's sortIssues), newest-created
    // first within a band, then IRI as a deterministic tie-break.
    items.sort(
      (a, b) =>
        STATE_RANK[a.state] - STATE_RANK[b.state] ||
        createdMs(b) - createdMs(a) ||
        a.id.localeCompare(b.id),
    );
    return { items };
  },
};
