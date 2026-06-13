// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import {
  parseIssue,
  buildIssue,
  normalizeState,
  isWebId,
  sortIssues,
  openCount,
  ISSUE_CLASS,
  type Issue,
} from "./issues.js";
import type { StoredItem } from "./productivity-store.js";

const url = "https://pod.example/alice/issues/i.ttl";

describe("normalizeState", () => {
  it("accepts known states case-insensitively, defaults unknown to open", () => {
    expect(normalizeState("Closed")).toBe("closed");
    expect(normalizeState("in-progress")).toBe("in-progress");
    expect(normalizeState("OPEN")).toBe("open");
    expect(normalizeState("wat")).toBe("open");
    expect(normalizeState(undefined)).toBe("open");
  });
});

describe("isWebId", () => {
  it("only accepts absolute http(s) URLs", () => {
    expect(isWebId("https://bob.example/profile#me")).toBe(true);
    expect(isWebId("http://x/y")).toBe(true);
    expect(isWebId("ftp://x/y")).toBe(false);
    expect(isWebId("not a url")).toBe(false);
    expect(isWebId(undefined)).toBe(false);
  });
});

describe("buildIssue / parseIssue round-trip", () => {
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
    expect(round).toEqual<Issue>({
      title: "Login button misaligned",
      description: "Off by 4px on mobile",
      state: "in-progress",
      created,
      assignee: "https://bob.example/profile#me",
    });
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
