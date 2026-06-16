// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Issues (lightweight tracker) — one `wf:Task` per resource under `issues/`.
 *
 * **Shared federated model (federation linchpin).** The RDF read/write of an
 * issue now goes through the SHARED `@jeswr/solid-task-model` package
 * (`Task` / `parseTask` / `buildTask`), the single data contract every suite app
 * agrees on. solid-issues writes/reads the SAME predicates through the same
 * package, so a task created in solid-issues shows up in PM (and vice-versa).
 * Critically, the shared builder co-writes BOTH `wf:description` AND
 * `dct:description`, so solid-issues' `wf:description`-first reader no longer
 * misses a PM-authored body, and PM no longer misses a solid-issues body.
 *
 * **Class choice.** The class is `http://www.w3.org/2005/01/wf/flow#Task`
 * (`wf:Task`) — the same family SolidOS's own issue-tracker pane reads/writes.
 * Fields map to `dct:title`, `wf:description` + `dct:description`, `dct:created`
 * (`xsd:dateTime`), state via `rdf:type wf:Open`/`wf:Closed`, and an optional
 * `wf:assignee` WebID — all via the shared model's typed accessors.
 *
 * **App-local refinement — the three-band state (PM-specific, layered on top).**
 * The shared wire state is a BINARY open/closed so it federates cleanly. PM
 * carries an extra "in-progress" band as a PM-scoped `rdf:type` subclass
 * ({@link WF_IN_PROGRESS_CLASS}) ALONGSIDE `wf:Open`. A foreign consumer (e.g.
 * solid-issues) sees only `wf:Open` → "open" and is correct; PM reads the extra
 * subclass to recover the three-band distinction locally. This refinement is
 * applied on top of the shared `buildTask`/`parseTask` output — the shared model
 * never knows about it (pss-qec D4 — per-tracker fragment scheme).
 *
 * **State model (federation-compatible, pss-qec).**
 * State is `rdf:type wf:Open` / `rdf:type wf:Closed` (the shared model owns this).
 * The old `wf:state` literal (`"open"` / `"in-progress"` / `"closed"`) is banned
 * from new writes. A **one-time read-shim** maps any surviving legacy literal:
 *   - `"closed"`            → closed
 *   - `"open"`/`"in-progress"` → open (with `"in-progress"` preserved as the
 *     `#status-in-progress` subclass marker)
 * On the next conditional write the canonical types are materialised (the shared
 * builder always writes fresh) and the legacy `wf:state` triple is dropped.
 * `prov:endedAtTime` is written when an issue is closed (shared model).
 *
 * **Type-Index (pss-77n).**
 * `ISSUES_CONFIG.forClass = wf:Task` so `ProductivityStore.ensureRegistered()`
 * registers `solid:forClass wf:Task` with an `instanceContainer` of
 * `<podRoot>issues/` in the private type index. Other apps (e.g. solid-issues)
 * that enumerate `wf:Task` registrations discover PM's issues container, and PM
 * discovers theirs.
 *
 * SAME-POD ONLY: like Tasks/Bookmarks this is plain typed-CRUD on the owner's own
 * pod — no cross-pod posting, no inbox sends, no SSRF surface.
 *
 * RDF read/write is the shared model's typed `@rdfjs/wrapper` accessors —
 * never hand-built quads (house rule).
 */
import { DataFactory, Store } from "n3";
// The shared federated task model — imported from the `./task` SUBPATH (the
// browser-safe entry that never touches `node:fs`; the main entry re-exports
// `taskShapeTtl`, which reads the shape file with `node:fs` and cannot be bundled
// into PM's static client export). SHACL validation uses the vendored shape text
// (see src/lib/shacl/shape-registry.ts), not the node:fs-using `taskShapeTtl`.
import {
  buildTask,
  isAssignedTo,
  parseTask,
  Task,
  taskSubject,
  type TaskData,
} from "@jeswr/solid-task-model/task";
import {
  createStore,
  type ProductivityStore,
  type StoredItem,
  type StoreConfig,
} from "./productivity-store.js";

const WF = "http://www.w3.org/2005/01/wf/flow#";
const DCT = "http://purl.org/dc/terms/";
const PROV = "http://www.w3.org/ns/prov#";

/** The RDF class an issue is stamped + registered with (the shared `wf:Task`). */
export const ISSUE_CLASS = `${WF}Task`;

/**
 * Canonical state type IRIs (federation D2 — dereferenceable, solid-issues
 * compatible). The shared model owns writing these via `rdf:type`; re-exported
 * here as PM's public state-IRI surface for the tests and the in-progress logic.
 */
export const WF_OPEN = `${WF}Open`;
export const WF_CLOSED = `${WF}Closed`;

/**
 * Per-tracker fragment class for "in-progress" (intended rdfs:subClassOf wf:Open).
 * Written as a second `rdf:type` ALONGSIDE the shared `wf:Open` to distinguish
 * the in-progress band — an APP-LOCAL refinement layered on the shared model
 * (D4 — per-tracker fragment scheme).
 *
 * The IRI is in the PM's own solid-test namespace. solid-issues / any foreign
 * consumer sees only `wf:Open` and treats it as open (correct federation
 * behaviour); PM reads both types to recover the three-band distinction locally.
 */
export const WF_IN_PROGRESS_CLASS =
  "https://pod-manager.solid-test.jeswr.org/ns/issues#status-in-progress";

/** Container slug under the pod root. */
export const ISSUES_SLUG = "issues/";

const PREFIXES = { wf: WF, dct: DCT, prov: PROV } as const;

/** Issue lifecycle states the UI offers. */
export type IssueState = "open" | "in-progress" | "closed";

const ISSUE_STATES: readonly IssueState[] = ["open", "in-progress", "closed"];

/** Normalise an arbitrary state string to a known band (default open). */
export function normalizeState(value: string | undefined): IssueState {
  const v = (value ?? "").toLowerCase().trim();
  return (ISSUE_STATES as readonly string[]).includes(v) ? (v as IssueState) : "open";
}

/** An issue as the UI works with it (plain, serialisable). */
export interface Issue {
  /** Title — `dct:title`. */
  title: string;
  /** Body — co-written as `wf:description` + `dct:description` (shared model). */
  description?: string;
  /** Lifecycle state — expressed via `rdf:type wf:Open`/`wf:Closed` (+ subclass). */
  state: IssueState;
  /** Created timestamp — `dct:created`. */
  created?: Date;
  /**
   * Closed timestamp — `prov:endedAtTime`. Set automatically on close.
   * `undefined` for open/in-progress issues or legacy issues not yet rewritten.
   */
  endedAt?: Date;
  /** Optional assignee WebID — `wf:assignee`. */
  assignee?: string;
  /**
   * Set by the read-shim when a legacy `wf:state` literal was found and mapped.
   * On the next conditional write, rebuilding via {@link buildIssue} materialises
   * canonical types and drops the literal (the shared builder always builds
   * fresh). NOT part of the UI data model — consumers check this field only to
   * decide whether a rewrite is needed.
   */
  _legacyStateLiteral?: string;
}

/**
 * Map a PM {@link IssueState} to the shared model's binary {@link TaskData}
 * state. open/in-progress → "open" (the in-progress band is layered separately
 * as the {@link WF_IN_PROGRESS_CLASS} subclass); closed → "closed".
 */
export function stateToTaskState(state: IssueState): TaskData["state"] {
  return state === "closed" ? "closed" : "open";
}

/**
 * Map a state value to the canonical `rdf:type` IRIs PM stamps on an issue.
 * (Kept for tests + callers that reason about the raw types.)
 *   - open         → [`wf:Open`]
 *   - in-progress  → [`wf:Open`, `#status-in-progress`]
 *   - closed       → [`wf:Closed`]
 */
export function stateToTypes(state: IssueState): string[] {
  if (state === "closed") return [WF_CLOSED];
  if (state === "in-progress") return [WF_OPEN, WF_IN_PROGRESS_CLASS];
  return [WF_OPEN];
}

/**
 * Infer the PM {@link IssueState} from the `rdf:type` set on an issue subject.
 * The shared binary state is refined by the PM-local in-progress subclass:
 *   - `wf:Closed`                       → "closed"
 *   - `wf:Open` + `#status-in-progress` → "in-progress"
 *   - `wf:Open`                         → "open"
 * Returns `undefined` when no canonical state type is present (caller falls
 * through to the legacy-shim path).
 */
export function typesToState(types: ReadonlySet<string>): IssueState | undefined {
  if (types.has(WF_CLOSED)) return "closed";
  if (types.has(WF_IN_PROGRESS_CLASS)) return "in-progress";
  if (types.has(WF_OPEN)) return "open";
  return undefined;
}

/** True for an absolute http(s) URL usable as a WebID object. */
export function isWebId(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Read the legacy `wf:state` literal from a dataset via the shared `Task`
 * wrapper's `rdf:type`-agnostic store, WITHOUT hand-inspecting quads. The shared
 * model has no `wf:state` accessor (the literal is banned), so the shim reads it
 * through a tiny scoped match against the dataset for the single subject — still
 * via the n3 `Store.getObjects` typed API (not a regex on serialised RDF).
 */
function legacyStateLiteral(
  subject: string,
  dataset: import("@rdfjs/types").DatasetCore,
): string | undefined {
  // Build a Store view if needed; getObjects works on any DatasetCore-backed n3
  // Store. The caller passes the same dataset the shared parser read.
  const store = dataset instanceof Store ? dataset : new Store([...dataset]);
  const objects = store.getObjects(
    DataFactory.namedNode(subject),
    DataFactory.namedNode(`${WF}state`),
    null,
  );
  const lit = objects.find((o) => o.termType === "Literal");
  return lit?.value;
}

/**
 * Parse an issue document into an {@link Issue}, or `undefined` if not one.
 *
 * Delegates the RDF read to the shared {@link parseTask} (which reads BOTH
 * `wf:description` and `dct:description`, the assignee, timestamps and the binary
 * state), then layers PM's app-local in-progress band on top: if the subject also
 * carries the {@link WF_IN_PROGRESS_CLASS} subclass alongside `wf:Open`, the band
 * is "in-progress" rather than "open".
 *
 * **Read-shim (pss-qec):** if the document carries a legacy `wf:state` literal
 * but no canonical `wf:Open`/`wf:Closed` type, the shim maps it to a band and
 * surfaces the raw literal as `_legacyStateLiteral` so the next conditional write
 * triggers a rewrite-on-write (one-time migration, not perpetual).
 */
export function parseIssue(
  itemUrl: string,
  dataset: import("@rdfjs/types").DatasetCore,
): Issue | undefined {
  // Shared model read — returns undefined for a non-`wf:Task` document.
  const task = parseTask(itemUrl, dataset);
  if (!task) return undefined;

  // Recover PM's three-band state from the `rdf:type` set: shared model already
  // resolved wf:Open/wf:Closed (→ task.state), but the in-progress subclass is
  // PM-local, so we read the type set ourselves via the shared Task wrapper.
  const doc = new Task(taskSubject(itemUrl), dataset, DataFactory);
  let state: IssueState | undefined = typesToState(doc.types);
  let legacyLit: string | undefined;

  if (state === undefined) {
    // Shim: no canonical state type → fall back to the legacy wf:state literal.
    const lit = legacyStateLiteral(taskSubject(itemUrl), dataset);
    if (lit !== undefined) {
      state = normalizeState(lit);
      legacyLit = lit;
    } else {
      state = "open"; // No state at all — default to open.
    }
  }

  const issue: Issue = {
    title: task.title,
    description: task.description,
    state,
    created: task.created,
    endedAt: task.endedAt,
    assignee: task.assignee,
  };
  if (legacyLit !== undefined) issue._legacyStateLiteral = legacyLit;
  return issue;
}

/**
 * Serialise an {@link Issue} into a fresh dataset rooted at `${itemUrl}#it`.
 *
 * Delegates the RDF write to the shared {@link buildTask} (which co-writes
 * `wf:description` + `dct:description`, the binary `wf:Open`/`wf:Closed` state,
 * `prov:endedAtTime` on close, and a validated `wf:assignee`), then layers PM's
 * app-local in-progress subclass on top for the in-progress band.
 *
 * **Rewrite-on-write (pss-qec):** the shared builder always builds from a FRESH
 * store, so no legacy `wf:state` literal ever survives a rebuild — the
 * `rewriteLegacy` flag is accepted for API/spec consistency but is a no-op (a
 * rebuilt document is canonical by construction).
 */
export function buildIssue(
  itemUrl: string,
  issue: Issue,
  opts: { rewriteLegacy?: boolean } = {},
): Store {
  const data: TaskData = {
    title: issue.title,
    description: issue.description || undefined,
    state: stateToTaskState(issue.state),
    created: issue.created ?? new Date(),
    // Only persist a WebID assignee (the shared builder also drops a non-WebID,
    // but be explicit so the data model stays well-formed at the seam).
    assignee: isWebId(issue.assignee) ? issue.assignee : undefined,
  };
  if (issue.state === "closed") data.endedAt = issue.endedAt;

  const store = buildTask(itemUrl, data) as Store;

  // App-local refinement: stamp the in-progress subclass ALONGSIDE wf:Open so PM
  // recovers the band on read; a foreign consumer still sees wf:Open → open.
  if (issue.state === "in-progress") {
    new Task(taskSubject(itemUrl), store, DataFactory).types.add(WF_IN_PROGRESS_CLASS);
  }

  // Rebuilt documents are canonical by construction (fresh store), so no legacy
  // wf:state literal can survive — the flag is accepted for API consistency.
  void opts.rewriteLegacy;
  return store;
}

/** Open issues first (open, then in-progress, then closed); newest first within. */
export function sortIssues(items: readonly StoredItem<Issue>[]): StoredItem<Issue>[] {
  const rank: Record<IssueState, number> = { open: 0, "in-progress": 1, closed: 2 };
  return [...items].sort((a, b) => {
    const r = rank[a.data.state] - rank[b.data.state];
    if (r !== 0) return r;
    const ta = a.data.created?.getTime() ?? 0;
    const tb = b.data.created?.getTime() ?? 0;
    return tb - ta;
  });
}

/** Count of issues not yet closed. */
export function openCount(items: readonly StoredItem<Issue>[]): number {
  return items.filter((i) => i.data.state !== "closed").length;
}

/**
 * Does `assignee` name `webId`? Delegates to the shared {@link isAssignedTo} so
 * the "assigned to me" comparison is identical across every suite app — a task
 * assigned (via `wf:assignee`) in solid-issues surfaces in PM by the SAME rule.
 */
export function isAssignedToWebId(assignee: string | undefined, webId: string): boolean {
  return isAssignedTo(assignee, webId);
}

/** The store config — wires the typed parse/build into the shared CRUD. */
export const ISSUES_CONFIG: StoreConfig<Issue> = {
  containerSlug: ISSUES_SLUG,
  /**
   * forClass = wf:Task (federation pss-77n): ProductivityStore.ensureRegistered()
   * calls ensureTypeRegistrations({ forClass: wf:Task, container: issues/ }) so
   * other apps enumerating wf:Task instance-containers discover this pod's issues.
   */
  forClass: ISSUE_CLASS,
  prefixes: PREFIXES,
  parse: parseIssue,
  build: buildIssue,
  /**
   * ADVISORY SHACL validation is ON for issues (ADR-0014 Phase 1): the PM writes
   * `wf:Task` and the SHARED `@jeswr/solid-task-model` task shape checks
   * federation compatibility (it constrains BOTH `wf:description` and
   * `dct:description`, the assignee, and the binary state). A violation surfaces
   * a non-blocking warning — it NEVER blocks or rejects the write.
   */
  validate: true,
};

/** Build an Issues store bound to the active pod + WebID. */
export function issuesStore(opts: {
  podRoot: string;
  webId: string;
  fetchImpl?: typeof fetch;
  /** Where an advisory SHACL violation surfaces (a toast); never blocks. */
  onAdvisory?: import("./shacl/advisory.js").AdvisoryHandler;
}): ProductivityStore<Issue> {
  return createStore(ISSUES_CONFIG, opts);
}
