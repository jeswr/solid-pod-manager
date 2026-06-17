// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Tracker-document metadata — READ ONLY.
 *
 * A `wf:Tracker` configuration node is the SolidOS issue-tracker config document
 * on the other end of a `wf:Task`'s `wf:tracker` link: it declares the tracker's
 * title, its issue class, the state-store container where its issues live, the
 * declared category dimensions, the assignable-agent group, and the WORKFLOW
 * (the `#status-*` state classes + their allowed transitions). The Pod Manager's
 * Issues container can carry such a config at `<issuesContainer>index.ttl#this`
 * (the SolidOS / solid-issues convention — the same `index.ttl#this` shape PM
 * already probes for chat channels). When present, this module surfaces that
 * config in the Issues read path so the user sees the tracker's metadata.
 *
 * **READ PATH ONLY (scope guard).** This module never WRITES or BUILDS a tracker
 * doc — that is a later builder's job. It only PROBES + PARSES an existing
 * `index.ttl` and returns a plain, serialisable {@link TrackerMeta}.
 *
 * **Typed data, never raw RDF (the #61 convention).** The RDF read goes through
 * the SHARED `@jeswr/solid-task-model` package's typed `parseTracker` accessor —
 * imported from the CLIENT-SAFE `./tracker` SUBEXPORT (it imports no `node:fs`,
 * so it bundles into PM's static client export; the barrel `.` pulls `node:fs`
 * via `shape.ts` and would BREAK the Next static export, so we NEVER import the
 * tracker types from the barrel). solid-issues and the SolidOS pane read/write
 * the SAME `wf:Tracker` triples through the same model, so a tracker configured
 * in one app is a fully-readable, valid tracker in PM.
 *
 * **Same-pod read (NOT the foreign-origin boundary).** The `index.ttl` lives in
 * the USER'S OWN pod (the Issues container), so the read uses the app's normal
 * authenticated pod read ({@link freshRdf} → the auth-patched global fetch) like
 * every other productivity read — NOT the native-fetch third-party boundary,
 * which is reserved for THIRD-PARTY origins (the WebID index, Matrix, the forum).
 */
import { RdfFetchError } from "@jeswr/fetch-rdf";
// CLIENT-SAFE subexport — see the module doc: `@jeswr/solid-task-model/tracker`
// imports no `node:fs`, so it bundles into PM's static export; the barrel `.`
// pulls `node:fs` (via shape.ts) and must NEVER be imported for the tracker types.
import {
  canTransition,
  parseTracker,
  statusState,
  type TrackerData,
  type WorkflowDef,
  type WorkflowStatus,
} from "@jeswr/solid-task-model/tracker";
import { freshRdf } from "./rdf-read.js";

/** The config-document leaf within a tracker container (SolidOS convention). */
export const TRACKER_DOC_LEAF = "index.ttl";

/**
 * The bare SWR cache key prefix for a tracker's metadata. Lives here (the
 * non-React lib) so BOTH the React hook ({@link file://../components/use-tracker.ts})
 * AND the non-React prefetch layer ({@link file://./prefetch.ts}) build the SAME
 * key without the prefetch path importing a `"use client"` module (mirrors how
 * `assignedTasksKey` lives in the durable layer, not the hook).
 */
export const TRACKER_KEY_PREFIX = "tracker:";

/** Build the bare cache key for a tracker container (`tracker:<containerUrl>`). */
export function trackerKey(containerUrl: string): string {
  return `${TRACKER_KEY_PREFIX}${containerUrl}`;
}

/**
 * The tracker document URL for a container: `<container>index.ttl`. The container
 * MUST end in `/` (the productivity store guarantees this for its `container`).
 */
export function trackerDocUrl(containerUrl: string): string {
  return `${containerUrl}${TRACKER_DOC_LEAF}`;
}

/**
 * A workflow state for display: the slug, its human label, whether it is a
 * terminal (closed) state, its open/closed resolution, and the slugs it may
 * transition to under the tracker's workflow.
 */
export interface TrackerWorkflowState {
  /** The status slug (the `#status-<slug>` class fragment). */
  slug: string;
  /** Human label (`rdfs:label`), falling back to the slug. */
  label: string;
  /** A terminal status resolves to closed; otherwise open. */
  terminal: boolean;
  /** The open/closed resolution (`statusState` of the workflow). */
  resolution: "open" | "closed";
  /** The slugs this state may transition to (excludes itself). */
  transitionsTo: string[];
}

/**
 * Tracker-document metadata as the UI consumes it — a plain, serialisable object
 * (safe to cache in the SWR layer). Built from the shared {@link TrackerData}.
 */
export interface TrackerMeta {
  /** The tracker document URL (`<container>index.ttl`). */
  docUrl: string;
  /** `dct:title` — the tracker's title (may be empty). */
  title: string;
  /** `wf:issueClass` — the class the tracker's issues carry (defaults to `wf:Task`). */
  issueClass: string;
  /** `wf:stateStore` — the container/resource holding the tracker's issue resources. */
  stateStore?: string;
  /** `wf:issueCategory` — declared category/dimension class IRIs. */
  categories: string[];
  /** `wf:assigneeGroup` member WebIDs (the assignable agents). */
  groupMembers: string[];
  /** The configured workflow states (ordered, with transitions resolved). */
  workflowStates: TrackerWorkflowState[];
}

/**
 * Convert a parsed {@link WorkflowDef} into the ordered display states, resolving
 * each state's open/closed disposition and its allowed transition targets via the
 * shared {@link statusState} / {@link canTransition} (so the same workflow logic
 * applies in PM as in every other app — never re-implemented).
 */
export function toWorkflowStates(workflow: WorkflowDef): TrackerWorkflowState[] {
  return workflow.statuses.map((status: WorkflowStatus) => ({
    slug: status.slug,
    label: status.label,
    terminal: status.terminal,
    resolution: statusState(workflow, status.slug),
    transitionsTo: workflow.statuses
      .filter((other) => other.slug !== status.slug && canTransition(workflow, status.slug, other.slug))
      .map((other) => other.slug),
  }));
}

/**
 * A short, human-readable label for an IRI for display: the fragment (`#frag`)
 * if present, else the last non-empty path segment, falling back to the whole
 * IRI. Used to render category / issue-class IRIs compactly (the full IRI is
 * still available as a title/href). Returns the input unchanged if it is not a
 * parseable absolute URL.
 */
export function shortIriLabel(iri: string): string {
  let url: URL;
  try {
    url = new URL(iri);
  } catch {
    return iri;
  }
  if (url.hash) return url.hash.slice(1);
  const segments = url.pathname.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : iri;
}

/** Map the shared {@link TrackerData} into the UI's {@link TrackerMeta}. */
export function toTrackerMeta(docUrl: string, data: TrackerData): TrackerMeta {
  return {
    docUrl,
    title: data.title ?? "",
    // `parseTracker` always resolves `issueClass` (defaults to wf:Task), but the
    // type is `string | undefined`; keep the same default at the seam.
    issueClass: data.issueClass ?? "http://www.w3.org/2005/01/wf/flow#Task",
    stateStore: data.stateStore,
    categories: data.categories ?? [],
    groupMembers: data.groupMembers ?? [],
    workflowStates: data.workflow ? toWorkflowStates(data.workflow) : [],
  };
}

/**
 * Read the tracker metadata for an Issues container, or `undefined` if the
 * container has NO tracker config document.
 *
 * Probes `<containerUrl>index.ttl` (a FRESH read) and parses it via the shared
 * {@link parseTracker}:
 *   - `404` (the doc is genuinely absent) → `undefined` (no tracker configured;
 *     PM's Issues container is plain `wf:Task` CRUD without an explicit tracker).
 *   - `403` / `5xx` / network / parse error → the error PROPAGATES (an ambiguous
 *     read — the doc could exist but be unreadable — fails closed, like chat's
 *     index probe; the caller surfaces it as an error/retry rather than silently
 *     claiming "no tracker").
 *   - `200` but NOT a `wf:Tracker` at `index.ttl#this` → `undefined`
 *     (`parseTracker` returns `undefined`); the doc exists but isn't a tracker
 *     config (e.g. a LongChat index in a repurposed container), so there is no
 *     tracker metadata to show.
 *   - `200` AND a `wf:Tracker` → the parsed {@link TrackerMeta}.
 *
 * @param containerUrl - the Issues container URL (MUST end in `/`).
 * @param fetchImpl - test-only override; **omit in production** so the
 *   auth-patched global fetch runs (this is a SAME-POD authenticated read).
 */
export async function readTrackerMeta(
  containerUrl: string,
  fetchImpl?: typeof fetch,
): Promise<TrackerMeta | undefined> {
  const docUrl = trackerDocUrl(containerUrl);
  let dataset: import("@rdfjs/types").DatasetCore;
  try {
    ({ dataset } = await freshRdf(docUrl, fetchImpl));
  } catch (e) {
    // A genuinely absent config doc → no tracker configured (the positive,
    // unambiguous "none" signal). Everything else (403/5xx/parse/network) is
    // ambiguous → fail closed by re-throwing, never silently "no tracker".
    if (e instanceof RdfFetchError && e.status === 404) return undefined;
    throw e;
  }
  const data = parseTracker(docUrl, dataset);
  if (!data) return undefined; // doc exists but is not a wf:Tracker config
  return toTrackerMeta(docUrl, data);
}
