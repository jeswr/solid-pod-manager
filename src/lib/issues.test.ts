// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { DataFactory, Store } from "n3";
import {
  parseIssue,
  buildIssue,
  isAssignedToWebId,
  normalizeState,
  isWebId,
  sortIssues,
  openCount,
  stateToTypes,
  typesToState,
  ISSUE_CLASS,
  ISSUES_CONFIG,
  ISSUES_SLUG,
  WF_OPEN,
  WF_CLOSED,
  WF_IN_PROGRESS_CLASS,
  type Issue,
} from "./issues.js";
// The SHARED federated model — used here to PRODUCE bytes the way solid-issues
// (and any other suite app) does, then assert PM reads them back identically.
import { buildTask, serializeTask } from "@jeswr/solid-task-model/task";
import { Parser } from "n3";
import type { StoredItem } from "./productivity-store.js";

const url = "https://pod.example/alice/issues/i.ttl";
const subjectUrl = `${url}#it`;
const WF = "http://www.w3.org/2005/01/wf/flow#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

// ---------------------------------------------------------------------------
// Helper: build a legacy dataset that uses the old wf:state literal.
// This simulates issues written by the old PM before pss-qec migration.
// ---------------------------------------------------------------------------
function buildLegacyIssue(
  itemUrl: string,
  issue: { title: string; stateLiteral: string; assignee?: string },
): Store {
  const store = new Store();
  const { namedNode, literal, quad, defaultGraph } = DataFactory;
  const subject = namedNode(`${itemUrl}#it`);
  store.addQuad(quad(subject, namedNode(RDF_TYPE), namedNode(ISSUE_CLASS), defaultGraph()));
  store.addQuad(
    quad(
      subject,
      namedNode("http://purl.org/dc/terms/title"),
      literal(issue.title),
      defaultGraph(),
    ),
  );
  store.addQuad(
    quad(
      subject,
      namedNode(`${WF}state`),
      literal(issue.stateLiteral),
      defaultGraph(),
    ),
  );
  if (issue.assignee) {
    store.addQuad(
      quad(
        subject,
        namedNode(`${WF}assignee`),
        namedNode(issue.assignee),
        defaultGraph(),
      ),
    );
  }
  return store;
}

// ---------------------------------------------------------------------------
// normalizeState
// ---------------------------------------------------------------------------
describe("normalizeState", () => {
  it("accepts known states case-insensitively, defaults unknown to open", () => {
    expect(normalizeState("Closed")).toBe("closed");
    expect(normalizeState("in-progress")).toBe("in-progress");
    expect(normalizeState("OPEN")).toBe("open");
    expect(normalizeState("wat")).toBe("open");
    expect(normalizeState(undefined)).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// isWebId
// ---------------------------------------------------------------------------
describe("isWebId", () => {
  it("only accepts absolute http(s) URLs", () => {
    expect(isWebId("https://bob.example/profile#me")).toBe(true);
    expect(isWebId("http://x/y")).toBe(true);
    expect(isWebId("ftp://x/y")).toBe(false);
    expect(isWebId("not a url")).toBe(false);
    expect(isWebId(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// stateToTypes / typesToState — round-trip helpers (pss-qec)
// ---------------------------------------------------------------------------
describe("stateToTypes / typesToState", () => {
  it.each([
    ["open", [WF_OPEN]],
    ["in-progress", [WF_OPEN, WF_IN_PROGRESS_CLASS]],
    ["closed", [WF_CLOSED]],
  ] as const)("stateToTypes('%s') → %j", (state, expected) => {
    expect(stateToTypes(state)).toEqual(expected);
  });

  it("typesToState correctly reads canonical types", () => {
    expect(typesToState(new Set([WF_OPEN]))).toBe("open");
    expect(typesToState(new Set([WF_OPEN, WF_IN_PROGRESS_CLASS]))).toBe("in-progress");
    expect(typesToState(new Set([WF_CLOSED]))).toBe("closed");
    expect(typesToState(new Set([ISSUE_CLASS]))).toBeUndefined();
    expect(typesToState(new Set())).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildIssue / parseIssue — canonical typed-state round-trips (pss-qec)
// ---------------------------------------------------------------------------
describe("buildIssue / parseIssue — canonical typed state", () => {
  it("preserves title, description, state, created and a WebID assignee", () => {
    const created = new Date("2026-06-13T10:00:00.000Z");
    const ds = buildIssue(url, {
      title: "Login button misaligned",
      description: "Off by 4px on mobile",
      state: "in-progress",
      created,
      assignee: "https://bob.example/profile#me",
    });
    const round = parseIssue(url, ds);
    expect(round).toMatchObject<Partial<Issue>>({
      title: "Login button misaligned",
      description: "Off by 4px on mobile",
      state: "in-progress",
      created,
      assignee: "https://bob.example/profile#me",
    });
    // No legacy state literal on new writes.
    expect(round?._legacyStateLiteral).toBeUndefined();
  });

  it("stamps the wf:Task class and defaults created when omitted", () => {
    const ds = buildIssue(url, { title: "x", state: "open" });
    expect(parseIssue(url, ds)?.created).toBeInstanceOf(Date);
    // class present
    const hasType = [...ds].some(
      (q) => q.predicate.value.endsWith("#type") && q.object.value === ISSUE_CLASS,
    );
    expect(hasType).toBe(true);
  });

  it("writes wf:Open type for open state — no wf:state literal", () => {
    const ds = buildIssue(url, { title: "x", state: "open" });
    const hasOpen = [...ds].some((q) => q.object.value === WF_OPEN);
    const hasLiteral = [...ds].some((q) => q.predicate.value === `${WF}state`);
    expect(hasOpen).toBe(true);
    expect(hasLiteral).toBe(false);
  });

  it("writes wf:Open + in-progress subclass for in-progress state", () => {
    const ds = buildIssue(url, { title: "x", state: "in-progress" });
    const types = [...ds]
      .filter((q) => q.predicate.value === RDF_TYPE)
      .map((q) => q.object.value);
    expect(types).toContain(WF_OPEN);
    expect(types).toContain(WF_IN_PROGRESS_CLASS);
    // No wf:Closed on an open issue.
    expect(types).not.toContain(WF_CLOSED);
  });

  it("writes wf:Closed type and prov:endedAtTime for closed state", () => {
    const ds = buildIssue(url, { title: "x", state: "closed" });
    const types = [...ds]
      .filter((q) => q.predicate.value === RDF_TYPE)
      .map((q) => q.object.value);
    expect(types).toContain(WF_CLOSED);
    expect(types).not.toContain(WF_OPEN);
    // prov:endedAtTime is set.
    const hasEndedAt = [...ds].some((q) =>
      q.predicate.value === "http://www.w3.org/ns/prov#endedAtTime",
    );
    expect(hasEndedAt).toBe(true);
    // parseIssue surfaces endedAt.
    expect(parseIssue(url, ds)?.endedAt).toBeInstanceOf(Date);
  });

  it("preserves a caller-supplied endedAt on close", () => {
    const endedAt = new Date("2026-06-15T12:00:00.000Z");
    const ds = buildIssue(url, { title: "x", state: "closed", endedAt });
    expect(parseIssue(url, ds)?.endedAt?.toISOString()).toBe(endedAt.toISOString());
  });

  it("does NOT write prov:endedAtTime for open/in-progress states", () => {
    for (const state of ["open", "in-progress"] as const) {
      const ds = buildIssue(url, { title: "x", state });
      const hasEndedAt = [...ds].some((q) =>
        q.predicate.value === "http://www.w3.org/ns/prov#endedAtTime",
      );
      expect(hasEndedAt).toBe(false);
    }
  });

  it("drops a non-WebID assignee rather than writing a malformed node", () => {
    const ds = buildIssue(url, { title: "x", state: "open", assignee: "just a name" });
    expect(parseIssue(url, ds)?.assignee).toBeUndefined();
  });

  it("returns undefined for a document that is not an issue", () => {
    const ds = buildIssue(url, { title: "x", state: "open" });
    // a different subject / no type => not parseable as this item
    expect(parseIssue("https://pod.example/alice/issues/other.ttl", ds)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Legacy read-shim (pss-qec) — mapping old wf:state literals to typed state
// ---------------------------------------------------------------------------
describe("read-shim: legacy wf:state literal → typed state", () => {
  it("maps 'open' literal → state:'open', surfaces _legacyStateLiteral", () => {
    const ds = buildLegacyIssue(url, { title: "Old issue", stateLiteral: "open" });
    const issue = parseIssue(url, ds);
    expect(issue?.state).toBe("open");
    expect(issue?._legacyStateLiteral).toBe("open");
  });

  it("maps 'in-progress' literal → state:'in-progress', surfaces _legacyStateLiteral", () => {
    const ds = buildLegacyIssue(url, { title: "Old issue", stateLiteral: "in-progress" });
    const issue = parseIssue(url, ds);
    expect(issue?.state).toBe("in-progress");
    expect(issue?._legacyStateLiteral).toBe("in-progress");
  });

  it("maps 'closed' literal → state:'closed', surfaces _legacyStateLiteral", () => {
    const ds = buildLegacyIssue(url, { title: "Old WIP", stateLiteral: "closed" });
    const issue = parseIssue(url, ds);
    expect(issue?.state).toBe("closed");
    expect(issue?._legacyStateLiteral).toBe("closed");
  });

  it("maps unknown legacy literal → 'open', surfaces _legacyStateLiteral", () => {
    const ds = buildLegacyIssue(url, { title: "Weird", stateLiteral: "blocked" });
    const issue = parseIssue(url, ds);
    expect(issue?.state).toBe("open");
    expect(issue?._legacyStateLiteral).toBe("blocked");
  });

  it("rewrite-on-write removes the legacy literal (one-time migration)", () => {
    // Simulate: read a legacy issue, migrate its state, rebuild with buildIssue.
    const legacyDs = buildLegacyIssue(url, { title: "Migrated", stateLiteral: "in-progress" });
    const parsed = parseIssue(url, legacyDs);
    expect(parsed?._legacyStateLiteral).toBe("in-progress");

    // On the next write we build a fresh canonical document.
    const newDs = buildIssue(url, { ...parsed!, _legacyStateLiteral: undefined });
    const migrated = parseIssue(url, newDs);
    // State is preserved.
    expect(migrated?.state).toBe("in-progress");
    // No legacy literal on the rebuilt document.
    expect(migrated?._legacyStateLiteral).toBeUndefined();
    // No wf:state triple in the new store.
    const hasLegacyLiteral = [...newDs].some((q) => q.predicate.value === `${WF}state`);
    expect(hasLegacyLiteral).toBe(false);
    // Canonical types are present.
    const types = [...newDs]
      .filter((q) => q.predicate.value === RDF_TYPE)
      .map((q) => q.object.value);
    expect(types).toContain(WF_OPEN);
    expect(types).toContain(WF_IN_PROGRESS_CLASS);
  });

  it("canonical typed state takes precedence over legacy literal when both present", () => {
    // Edge case: a document with BOTH wf:type and wf:state literal (e.g. from
    // a partial migration). Canonical wins; no shim is applied.
    const store = buildLegacyIssue(url, { title: "Mixed", stateLiteral: "closed" });
    // Also add canonical wf:Open type.
    const { namedNode, quad, defaultGraph } = DataFactory;
    store.addQuad(
      quad(namedNode(subjectUrl), namedNode(RDF_TYPE), namedNode(WF_OPEN), defaultGraph()),
    );
    const issue = parseIssue(url, store);
    // Canonical wins: wf:Open → "open", NOT "closed".
    expect(issue?.state).toBe("open");
    // Shim is NOT triggered because canonical type is present.
    expect(issue?._legacyStateLiteral).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Type-Index / wf:Task registration (pss-77n)
// ---------------------------------------------------------------------------
describe("ISSUES_CONFIG type-index registration (pss-77n)", () => {
  it("forClass is wf:Task so ensureRegistered() will register wf:Task instanceContainer", () => {
    // The actual I/O is tested in type-index-write.test.ts.
    // Here we assert the constant that drives it is correct (the value that
    // ProductivityStore.ensureRegistered() passes to ensureTypeRegistrations).
    expect(ISSUES_CONFIG.forClass).toBe("http://www.w3.org/2005/01/wf/flow#Task");
  });

  it("containerSlug is issues/ — the discoverable instance container slug", () => {
    expect(ISSUES_CONFIG.containerSlug).toBe(ISSUES_SLUG);
    expect(ISSUES_SLUG).toBe("issues/");
  });
});

// ---------------------------------------------------------------------------
// sortIssues / openCount
// ---------------------------------------------------------------------------
describe("sortIssues / openCount", () => {
  const item = (title: string, state: Issue["state"], iso: string): StoredItem<Issue> => ({
    url: `${url}#${title}`,
    etag: null,
    data: { title, state, created: new Date(iso) },
  });

  it("orders open → in-progress → closed, newest first within a band", () => {
    const items = [
      item("old-open", "open", "2026-06-01T00:00:00Z"),
      item("closed", "closed", "2026-06-10T00:00:00Z"),
      item("new-open", "open", "2026-06-09T00:00:00Z"),
      item("wip", "in-progress", "2026-06-05T00:00:00Z"),
    ];
    expect(sortIssues(items).map((i) => i.data.title)).toEqual([
      "new-open",
      "old-open",
      "wip",
      "closed",
    ]);
  });

  it("counts everything not closed", () => {
    const items = [
      item("a", "open", "2026-06-01T00:00:00Z"),
      item("b", "in-progress", "2026-06-01T00:00:00Z"),
      item("c", "closed", "2026-06-01T00:00:00Z"),
    ];
    expect(openCount(items)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// CROSS-APP ROUND-TRIP — the federation linchpin (shared @jeswr/solid-task-model)
//
// solid-issues and PM now read/write the SAME predicates through the SAME
// package. The two interop guarantees this asserts:
//   (1) A task solid-issues writes — its wire format uses `wf:description` for
//       the body and `wf:assignee` for the assignee — reads in PM as
//       assigned-to-me WITH THE BODY PRESENT (solid-issues' wf:-only body is no
//       longer missed, because the shared parser reads BOTH wf: and dct:).
//   (2) A task PM writes co-writes BOTH `wf:description` and `dct:description`,
//       so solid-issues' `wf:description`-first reader finds PM's body too.
// ---------------------------------------------------------------------------
describe("cross-app round-trip (shared task model federation)", () => {
  const me = "https://me.solidcommunity.net/profile/card#me";
  const issueUrl = "https://friend.pod/issues/bug-42.ttl";
  const subject = `${issueUrl}#it`;
  const DCT_PFX = "http://purl.org/dc/terms/";

  const WF_DESCRIPTION = `${WF}description`;
  const DCT_DESCRIPTION = `${DCT_PFX}description`;
  const FOREIGN_BODY = "Off by 4px in the 320px breakpoint";

  /**
   * Produce the bytes of a LEGACY / FOREIGN solid-issues document whose body
   * lives ONLY under `wf:description` (NOT `dct:description`) — the exact
   * compatibility case that matters: a producer that predates the dual-predicate
   * convergence. We build via the shared `serializeTask` (the real producer) and
   * then strip the `dct:description` triple from the parsed graph, so the
   * fixture genuinely carries `wf:description` alone. Returns the parsed dataset
   * PM will read.
   */
  async function foreignWfOnlyDataset(): Promise<Store> {
    const ttl = await serializeTask(issueUrl, {
      title: "Login button overflows on mobile",
      description: FOREIGN_BODY,
      state: "open",
      assignee: me,
    });
    const store = new Store(new Parser({ baseIRI: issueUrl }).parse(ttl));
    // Strip dct:description so the body exists ONLY under wf:description — the
    // genuine wf:-only foreign wire format this test must guard.
    store.removeQuads(
      store.getQuads(subject, DataFactory.namedNode(DCT_DESCRIPTION), null, null),
    );
    return store;
  }

  it("a solid-issues-written task (wf:description-only body + wf:assignee=me) reads in PM as assigned-to-me with the body present", async () => {
    const dataset = await foreignWfOnlyDataset();

    // The fixture carries the body ONLY under wf:description (the legacy/foreign
    // predicate) and NOT under dct:description — so this genuinely exercises the
    // path where PM must read a wf:-only foreign body, not the dual-predicate one.
    const wfBodies = dataset
      .getObjects(subject, DataFactory.namedNode(WF_DESCRIPTION), null)
      .map((o) => o.value);
    const dctBodies = dataset
      .getObjects(subject, DataFactory.namedNode(DCT_DESCRIPTION), null)
      .map((o) => o.value);
    expect(wfBodies).toEqual([FOREIGN_BODY]);
    expect(dctBodies).toEqual([]); // no dct:description — the body is wf:-only

    // PM reads those bytes via its (now shared-model-backed) parser.
    const issue = parseIssue(issueUrl, dataset);

    expect(issue).toBeDefined();
    // Body present — the wf:description-only body is NOT dropped on PM's read.
    expect(issue?.description).toBe(FOREIGN_BODY);
    expect(issue?.title).toBe("Login button overflows on mobile");
    expect(issue?.state).toBe("open");
    // Assigned to me — surfaced via the SHARED isAssignedTo comparison.
    expect(issue?.assignee).toBe(me);
    expect(isAssignedToWebId(issue?.assignee, me)).toBe(true);
  });

  it("a task PM writes co-writes BOTH wf:description and dct:description (solid-issues' wf:-first reader finds the body)", () => {
    const ds = buildIssue(issueUrl, {
      title: "Add OAuth login",
      description: "Behind a feature flag",
      state: "in-progress",
      assignee: me,
    });

    // Both description predicates carry the body — solid-issues reads
    // wf:description first; a dct:-only PM write would be missed without this.
    const bodies = [...ds]
      .filter((q) => q.subject.value === subject && q.object.value === "Behind a feature flag")
      .map((q) => q.predicate.value)
      .sort();
    expect(bodies).toEqual([`${DCT_PFX}description`, `${WF}description`]);

    // The shared binary state is wf:Open (a foreign reader sees "open"), with
    // PM's in-progress subclass layered ON TOP — the app-local refinement.
    const types = [...ds]
      .filter((q) => q.subject.value === subject && q.predicate.value === RDF_TYPE)
      .map((q) => q.object.value);
    expect(types).toContain(WF_OPEN); // foreign consumer → "open" (correct)
    expect(types).toContain(WF_IN_PROGRESS_CLASS); // PM recovers "in-progress"
    expect(types).not.toContain(WF_CLOSED);

    // PM reads its own write back as in-progress with the body + assignee.
    const round = parseIssue(issueUrl, ds);
    expect(round?.state).toBe("in-progress");
    expect(round?.description).toBe("Behind a feature flag");
    expect(round?.assignee).toBe(me);
  });

  it("a closed task PM writes is readable by a foreign (wf:Closed) reader and carries prov:endedAtTime", () => {
    const ds = buildIssue(issueUrl, { title: "Done", state: "closed", assignee: me });
    const built = buildTask(issueUrl, { title: "Done", state: "closed", assignee: me });
    // PM's closed write produces the SAME canonical wf:Closed state the shared
    // builder does (no in-progress subclass), so a foreign reader agrees.
    const pmTypes = [...ds]
      .filter((q) => q.predicate.value === RDF_TYPE)
      .map((q) => q.object.value)
      .sort();
    const sharedTypes = [...built]
      .filter((q) => q.predicate.value === RDF_TYPE)
      .map((q) => q.object.value)
      .sort();
    expect(pmTypes).toEqual(sharedTypes);
    expect(pmTypes).toContain(WF_CLOSED);
    // prov:endedAtTime stamped on close.
    expect(parseIssue(issueUrl, ds)?.endedAt).toBeInstanceOf(Date);
  });
});
