// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Issues (lightweight tracker) — one `wf:Task` per resource under `issues/`.
 *
 * **Class choice.** We use the SolidOS workflow ontology term
 * `http://www.w3.org/2005/01/wf/flow#Task` (`wf:Task`) — the same family
 * SolidOS's own issue-tracker pane reads/writes, so issues created here are
 * re-readable there. Fields map to `dct:title`, `dct:description`,
 * `dct:created` (`xsd:dateTime`), a `wf:state` status literal
 * (`open` / `in-progress` / `closed`), and an optional `wf:assignee` WebID.
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
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** The RDF class an issue is stamped + registered with. */
export const ISSUE_CLASS = `${WF}Task`;

/** Container slug under the pod root. */
export const ISSUES_SLUG = "issues/";

const PREFIXES = { wf: WF, dct: DCT } as const;

/** Issue lifecycle states the UI offers, stored as the `wf:state` literal. */
export type IssueState = "open" | "in-progress" | "closed";

const ISSUE_STATES: readonly IssueState[] = ["open", "in-progress", "closed"];

/** Normalise an arbitrary stored state literal to a known band (default open). */
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
  /** Lifecycle state — `wf:state`. */
  state: IssueState;
  /** Created timestamp — `dct:created`. */
  created?: Date;
  /** Optional assignee WebID — `wf:assignee`. */
  assignee?: string;
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
  get state(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${WF}state`, LiteralAs.string);
  }
  set state(v: string | undefined) {
    OptionalAs.object(this, `${WF}state`, v, LiteralFrom.string);
  }
  get created(): Date | undefined {
    return OptionalFrom.subjectPredicate(this, `${DCT}created`, LiteralAs.date);
  }
  set created(v: Date | undefined) {
    OptionalAs.object(this, `${DCT}created`, v, LiteralFrom.dateTime);
  }
  /** `wf:assignee` — an agent WebID (object property). */
  get assignee(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${WF}assignee`, NamedNodeAs.string);
  }
  set assignee(v: string | undefined) {
    OptionalAs.object(this, `${WF}assignee`, v, NamedNodeFrom.string);
  }
}

/** Parse an issue document into an {@link Issue}, or `undefined` if not one. */
export function parseIssue(
  itemUrl: string,
  dataset: import("@rdfjs/types").DatasetCore,
): Issue | undefined {
  const doc = new IssueDoc(`${itemUrl}#it`, dataset, DataFactory);
  if (!doc.types.has(ISSUE_CLASS)) return undefined;
  return {
    title: doc.title ?? "",
    description: doc.description,
    state: normalizeState(doc.state),
    created: doc.created,
    assignee: doc.assignee,
  };
}

/** Serialise an {@link Issue} into a fresh dataset rooted at `${itemUrl}#it`. */
export function buildIssue(itemUrl: string, issue: Issue): Store {
  const store = new Store();
  const doc = new IssueDoc(`${itemUrl}#it`, store, DataFactory).mark();
  doc.title = issue.title || undefined;
  doc.description = issue.description || undefined;
  doc.state = issue.state;
  doc.created = issue.created ?? new Date();
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
  forClass: ISSUE_CLASS,
  prefixes: PREFIXES,
  parse: parseIssue,
  build: buildIssue,
};

/** Build an Issues store bound to the active pod + WebID. */
export function issuesStore(opts: {
  podRoot: string;
  webId: string;
  fetchImpl?: typeof fetch;
}): ProductivityStore<Issue> {
  return createStore(ISSUES_CONFIG, opts);
}
