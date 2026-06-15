// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { DataFactory, Store } from "n3";
import {
  parseIssue,
  buildIssue,
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
