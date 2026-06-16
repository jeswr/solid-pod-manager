// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
//
// Targets the SHARED federated `wf:Task` shape (`@jeswr/solid-task-model`) the
// Issues tracker (`src/lib/issues.ts`) + solid-issues both write. Fixtures are
// built with the real `buildIssue`, so the viewer is verified to round-trip the
// three-band state (open/in-progress/closed), the assignee, and the body the
// shared model co-writes — the federation linchpin, not a hand-rolled shape.
import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import { buildIssue, type Issue } from "../issues.js";
import { buildContact } from "../contacts.js";
import { issueViewer, type IssueModel } from "./issue-view.js";
import { buildViewerContext, selectTypedViewer } from "./select.js";
import type { ViewerContext } from "./types.js";

const URL = "https://alice.example/issues/i.ttl";
const ALICE = "https://alice.example/profile/card#me";

async function ctxFromTurtle(turtle: string, url = URL): Promise<ViewerContext> {
  const ds = await parseRdf(turtle, "text/turtle", { baseIRI: url });
  return buildViewerContext(url, ds);
}

function realIssueCtx(overrides: Partial<Issue> = {}): ViewerContext {
  const ds = buildIssue(URL, {
    title: "Login is broken",
    description: "500 on submit",
    state: "open",
    created: new Date("2026-06-11T09:00:00Z"),
    assignee: ALICE,
    ...overrides,
  });
  return buildViewerContext(URL, ds);
}

describe("issueViewer.matches", () => {
  it("matches a wf:Task document (the shared federated class)", () => {
    expect(issueViewer.matches(realIssueCtx())).toBe(true);
  });

  it("matches a wf:Task written by another producer (solid-issues parity)", async () => {
    const c = await ctxFromTurtle(
      `@prefix wf: <http://www.w3.org/2005/01/wf/flow#>.
       @prefix dct: <http://purl.org/dc/terms/>.
       <${URL}#it> a wf:Task, wf:Open ; dct:title "Foreign issue" .`,
    );
    expect(issueViewer.matches(c)).toBe(true);
  });

  it("does not match an unrelated (contacts) document", () => {
    const ds = buildContact(URL, { fn: "Ada Lovelace" });
    expect(issueViewer.matches(buildViewerContext(URL, ds))).toBe(false);
  });
});

describe("issueViewer.extract", () => {
  it("extracts title/description/assignee + raw ISO created from real buildIssue output", () => {
    const { items } = issueViewer.extract(realIssueCtx());
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Login is broken");
    expect(items[0].description).toBe("500 on submit");
    expect(items[0].assignee).toBe(ALICE);
    expect(Number.isNaN(Date.parse(items[0].created ?? ""))).toBe(false);
  });

  it("recovers the three-band state — open / in-progress / closed", () => {
    expect(issueViewer.extract(realIssueCtx({ state: "open" })).items[0].state).toBe("open");
    expect(issueViewer.extract(realIssueCtx({ state: "in-progress" })).items[0].state).toBe(
      "in-progress",
    );
    const closed = issueViewer.extract(
      realIssueCtx({ state: "closed", endedAt: new Date("2026-06-12T09:00:00Z") }),
    ).items[0];
    expect(closed.state).toBe("closed");
    expect(closed.endedAt).toBeDefined();
  });

  it("a foreign wf:Open (no in-progress subclass) reads as 'open'", async () => {
    const c = await ctxFromTurtle(
      `@prefix wf: <http://www.w3.org/2005/01/wf/flow#>.
       @prefix dct: <http://purl.org/dc/terms/>.
       <${URL}#it> a wf:Task, wf:Open ; dct:title "Foreign" .`,
    );
    expect(issueViewer.extract(c).items[0].state).toBe("open");
  });

  it("never leaks a raw RDF term", () => {
    const item = issueViewer.extract(realIssueCtx()).items[0];
    expect(item).not.toHaveProperty("dataset");
    expect(item).not.toHaveProperty("quad");
    expect(typeof item.title).toBe("string");
    expect(typeof item.state).toBe("string");
  });

  it("falls back to 'Untitled issue' when dct:title is absent", async () => {
    const c = await ctxFromTurtle(
      `@prefix wf: <http://www.w3.org/2005/01/wf/flow#>. <${URL}#it> a wf:Task, wf:Open .`,
    );
    expect(issueViewer.extract(c).items[0].title).toBe("Untitled issue");
  });

  it("orders open issues before closed ones", async () => {
    const c = await ctxFromTurtle(
      `@prefix wf: <http://www.w3.org/2005/01/wf/flow#>.
       @prefix dct: <http://purl.org/dc/terms/>.
       <${URL}#closed> a wf:Task, wf:Closed ; dct:title "Closed one" .
       <${URL}#open> a wf:Task, wf:Open ; dct:title "Open one" .`,
    );
    expect(issueViewer.extract(c).items.map((i) => i.title)).toEqual(["Open one", "Closed one"]);
  });
});

describe("selection precedence (Issue vs others)", () => {
  it("an issue document selects the issue viewer", () => {
    expect(selectTypedViewer(realIssueCtx())?.id).toBe("issue");
  });

  it("issue viewer sits at priority 60", () => {
    expect(issueViewer.priority).toBe(60);
  });

  it("a contacts document does not select the issue viewer", () => {
    const ds = buildContact(URL, { fn: "Grace Hopper" });
    const _m: IssueModel = issueViewer.extract(buildViewerContext(URL, ds));
    expect(_m.items).toEqual([]);
  });
});
