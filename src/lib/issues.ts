// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Issues (lightweight tracker) — one `wf:Task` per resource under `issues/`.
 *
 * **Class choice.** We use the SolidOS workflow ontology term
 * `http://www.w3.org/2005/01/wf/flow#Task` (`wf:Task`) — the same family
 * SolidOS's own issue-tracker pane reads/writes, so issues created here are
 * re-readable there. Fields map to `dct:title`, `dct:description`,
 * `dct:created` (`xsd:dateTime`), state via `rdf:type wf:Open`/`wf:Closed`
 * (the canonical solid-issues model), and an optional `wf:assignee` WebID.
 *
 * **State model (federation-compatible, pss-qec).**
 * State is expressed as `rdf:type wf:Open` or `rdf:type wf:Closed` — the
 * dereferenceable, solid-issues-compatible vocabulary. The old `wf:state`
 * literal (`"open"` / `"in-progress"` / `"closed"`) is banned from new
 * writes. A **one-time read-shim** maps any surviving legacy literal:
 *   - `"closed"`            → `wf:Closed`
 *   - `"open"`/`"in-progress"` → `wf:Open` (with `"in-progress"` preserved
 *     as a separate `#status-in-progress` per-tracker subclass marker)
 * On the next conditional write the canonical types are materialised and the
 * legacy `wf:state` triple is removed (rewrite-on-write, not a perpetual shim).
 * `prov:endedAtTime` is written when an issue is closed.
 *
 * **Type-Index (pss-77n).**
 * `ISSUES_CONFIG.forClass = wf:Task` so `ProductivityStore.ensureRegistered()`
 * — called on every `create()` — registers `solid:forClass wf:Task` with an
 * `instanceContainer` of `<podRoot>issues/` in the private type index. Other
 * apps (e.g. solid-issues) that enumerate `wf:Task` registrations will discover
 * PM's issues container, and PM will discover theirs.
 *
 * SAME-POD ONLY: like Tasks/Bookmarks this is plain typed-CRUD on the owner's
 * own pod — no cross-pod posting, no inbox sends, no SSRF surface.
 *
 * Mirrors `tasks.ts`/`bookmarks.ts`: a typed `@rdfjs/wrapper` doc, a pure
 * parse/build pair, a `StoreConfig`, and a store factory. Pure sort/group
 * helpers are separated from I/O so the list UI logic is unit-testable without
 * a pod (house rule: never hand-build quads).
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

const WF = "http://www.w3.org/2005/01/wf/flow#";
const DCT = "http://purl.org/dc/terms/";
const PROV = "http://www.w3.org/ns/prov#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** The RDF class an issue is stamped + registered with. */
export const ISSUE_CLASS = `${WF}Task`;

/**
 * Canonical state type IRIs (federation D2 — dereferenceable, solid-issues
 * compatible). These are `rdf:type` values on the issue subject, NOT literals.
 */
export const WF_OPEN = `${WF}Open`;
export const WF_CLOSED = `${WF}Closed`;

/**
 * Per-tracker fragment class for "in-progress" (intended rdfs:subClassOf wf:Open).
 * Written as a second `rdf:type` alongside `wf:Open` to distinguish the
 * in-progress band without ambiguity (D4 — per-tracker fragment scheme).
 *
 * The IRI is in the PM's own solid-test namespace. solid-issues sees only
 * `wf:Open` and treats it as open (correct federation behaviour); PM reads both
 * types to recover the three-band distinction locally.
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
  /** Body — `dct:description`. */
  description?: string;
  /** Lifecycle state — expressed via `rdf:type wf:Open`/`wf:Closed`. */
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
   * On the next conditional write, the caller should pass `rewriteLegacy: true`
   * to `buildIssue` to materialise canonical types and drop the literal.
   * NOT part of the UI data model — consumers should check this field only to
   * decide whether a rewrite is needed.
   */
  _legacyStateLiteral?: string;
}

/** Typed `@rdfjs/wrapper` view of a single issue's subject. */
export class IssueDoc extends TermWrapper {
  get types(): Set<string> {
    return SetFrom.subjectPredicate(this, RDF_TYPE, NamedNodeAs.string, NamedNodeFrom.string);
  }

  mark(): this {
    this.types.add(ISSUE_CLASS);
    return this;
  }

  get title(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${DCT}title`, LiteralAs.string);
  }
  set title(v: string | undefined) {
    OptionalAs.object(this, `${DCT}title`, v, LiteralFrom.string);
  }

  get description(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${DCT}description`, LiteralAs.string);
  }
  set description(v: string | undefined) {
    OptionalAs.object(this, `${DCT}description`, v, LiteralFrom.string);
  }

  get created(): Date | undefined {
    return OptionalFrom.subjectPredicate(this, `${DCT}created`, LiteralAs.date);
  }
  set created(v: Date | undefined) {
    OptionalAs.object(this, `${DCT}created`, v, LiteralFrom.dateTime);
  }

  /**
   * `prov:endedAtTime` — written when an issue transitions to closed.
   * Enables federation consumers to sort/filter by completion time.
   */
  get endedAt(): Date | undefined {
    return OptionalFrom.subjectPredicate(this, `${PROV}endedAtTime`, LiteralAs.date);
  }
  set endedAt(v: Date | undefined) {
    OptionalAs.object(this, `${PROV}endedAtTime`, v, LiteralFrom.dateTime);
  }

  /** `wf:assignee` — an agent WebID (object property). */
  get assignee(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${WF}assignee`, NamedNodeAs.string);
  }
  set assignee(v: string | undefined) {
    OptionalAs.object(this, `${WF}assignee`, v, NamedNodeFrom.string);
  }

  /**
   * Legacy `wf:state` literal accessor — used by the read-shim only.
   * New writes MUST NOT use this; it is kept here so the shim can read it via
   * the same typed-accessor path (house rule: never hand-inspect quads).
   */
  get legacyStateLiteral(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${WF}state`, LiteralAs.string);
  }
  /**
   * Clear the legacy `wf:state` literal — called during rewrite-on-write to
   * remove the banned literal while leaving all other triples intact.
   */
  clearLegacyStateLiteral(): void {
    OptionalAs.object(this, `${WF}state`, undefined, LiteralFrom.string);
  }
}

/**
 * Map a state value to the canonical `rdf:type` IRIs.
 *
 * Returns an array of IRI strings to add as `rdf:type` on the issue subject:
 *   - open         → [`wf:Open`]
 *   - in-progress  → [`wf:Open`, `wf:flow#Task#status-in-progress`]
 *   - closed       → [`wf:Closed`]
 */
export function stateToTypes(state: IssueState): string[] {
  if (state === "closed") return [WF_CLOSED];
  if (state === "in-progress") return [WF_OPEN, WF_IN_PROGRESS_CLASS];
  return [WF_OPEN];
}

/**
 * Infer the PM {@link IssueState} from the `rdf:type` set on an issue subject.
 * Returns `undefined` when no canonical state type is present (caller falls
 * through to the legacy-shim path).
 */
export function typesToState(types: ReadonlySet<string>): IssueState | undefined {
  if (types.has(WF_CLOSED)) return "closed";
  if (types.has(WF_IN_PROGRESS_CLASS)) return "in-progress";
  if (types.has(WF_OPEN)) return "open";
  return undefined;
}

/**
 * Parse an issue document into an {@link Issue}, or `undefined` if not one.
 *
 * **Read-shim (pss-qec):** if the issue carries a legacy `wf:state` literal
 * but no canonical `wf:Open`/`wf:Closed` type, the shim maps:
 *   - `"closed"` → state `"closed"`
 *   - anything else (including `"in-progress"`) → state `"open"` / `"in-progress"`
 * The mapped state is returned normally. The raw literal is surfaced as
 * `_legacyStateLiteral` so the next conditional write can trigger a
 * rewrite-on-write (one-time migration, not perpetual).
 */
export function parseIssue(
  itemUrl: string,
  dataset: import("@rdfjs/types").DatasetCore,
): Issue | undefined {
  const doc = new IssueDoc(`${itemUrl}#it`, dataset, DataFactory);
  if (!doc.types.has(ISSUE_CLASS)) return undefined;

  // Primary: canonical typed state.
  let state = typesToState(doc.types);
  let legacyStateLiteral: string | undefined;

  if (state === undefined) {
    // Shim: fall back to legacy wf:state literal.
    const lit = doc.legacyStateLiteral;
    if (lit !== undefined) {
      state = normalizeState(lit);
      legacyStateLiteral = lit;
    } else {
      // No state at all — default to open.
      state = "open";
    }
  }

  const issue: Issue = {
    title: doc.title ?? "",
    description: doc.description,
    state,
    created: doc.created,
    endedAt: doc.endedAt,
    assignee: doc.assignee,
  };
  if (legacyStateLiteral !== undefined) {
    issue._legacyStateLiteral = legacyStateLiteral;
  }
  return issue;
}

/**
 * Serialise an {@link Issue} into a fresh dataset rooted at `${itemUrl}#it`.
 *
 * **Rewrite-on-write (pss-qec):** when `opts.rewriteLegacy` is `true`, the
 * function reads the existing dataset, removes any legacy `wf:state` literal,
 * and writes the canonical typed state. Pass this flag when updating an issue
 * whose `_legacyStateLiteral` is set (one-time migration on the first edit).
 *
 * Normal (new) issues: state is always written as `rdf:type wf:Open` or
 * `rdf:type wf:Closed`; no `wf:state` literal is emitted.
 */
export function buildIssue(
  itemUrl: string,
  issue: Issue,
  opts: { rewriteLegacy?: boolean } = {},
): Store {
  const store = new Store();
  const doc = new IssueDoc(`${itemUrl}#it`, store, DataFactory).mark();

  doc.title = issue.title || undefined;
  doc.description = issue.description || undefined;
  doc.created = issue.created ?? new Date();

  // Write canonical state types (pss-qec D2).
  for (const typeIri of stateToTypes(issue.state)) {
    doc.types.add(typeIri);
  }

  // prov:endedAtTime on close (cheap + federation-useful).
  if (issue.state === "closed") {
    doc.endedAt = issue.endedAt ?? new Date();
  }

  // Rewrite-on-write: if migrating from legacy, the old dataset is NOT passed
  // here (we always build from a fresh Store), so no legacy triple survives.
  // The `rewriteLegacy` flag is for future callers that might pass in an
  // existing store — documented but unused in this implementation since we
  // always build fresh (the `build` function returns a new Store every time).
  // The flag is accepted to keep the API consistent with the design spec.
  void opts.rewriteLegacy;

  // Only persist an assignee that looks like an absolute http(s) WebID — never
  // coerce arbitrary text into a NamedNode (keeps the graph well-formed).
  doc.assignee = isWebId(issue.assignee) ? issue.assignee : undefined;
  return store;
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
   * ADVISORY SHACL validation is ON for issues (ADR-0014 Phase 1): the PM
   * writes `wf:Task` and the vendored solid-issues `issue.ttl` shape checks
   * federation compatibility. A violation surfaces a non-blocking warning — it
   * NEVER blocks or rejects the write (the form-level title/assignee checks
   * remain the hard guards). Issues are the first opted-in write-type; other
   * stores leave `validate` unset (off) until a matching shape is vendored.
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
