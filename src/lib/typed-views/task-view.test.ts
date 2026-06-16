// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
//
// Targets the shape the first-party Tasks app writes (`src/lib/tasks.ts`): an
// iCal VTODO `icaltzd:Vtodo` with ical:summary/description/due/status/priority.
// Fixtures are built with the real `buildTask` so the viewer agrees with the app
// on the completion + priority encoding, not a hand-rolled approximation.
import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import { buildTask } from "../tasks.js";
import { buildContact } from "../contacts.js";
import { taskViewer, type TaskModel } from "./task-view.js";
import { buildViewerContext, selectTypedViewer } from "./select.js";
import type { ViewerContext } from "./types.js";

const URL = "https://alice.example/tasks/t.ttl";

async function ctxFromTurtle(turtle: string, url = URL): Promise<ViewerContext> {
  const ds = await parseRdf(turtle, "text/turtle", { baseIRI: url });
  return buildViewerContext(url, ds);
}

function realTaskCtx(overrides: Partial<Parameters<typeof buildTask>[1]> = {}): ViewerContext {
  const ds = buildTask(URL, {
    title: "Write report",
    description: "Draft the Q2 report",
    due: new Date("2026-06-20T17:00:00Z"),
    completed: false,
    priority: "high",
    ...overrides,
  });
  return buildViewerContext(URL, ds);
}

describe("taskViewer.matches", () => {
  it("matches an icaltzd:Vtodo document (what the Tasks app writes)", () => {
    expect(taskViewer.matches(realTaskCtx())).toBe(true);
  });

  it("does NOT match the bare ical:Vtodo namespace (TaskDoc reads icaltzd only — fieldless otherwise)", async () => {
    const c = await ctxFromTurtle(
      `@prefix ical: <http://www.w3.org/2002/12/cal/ical#>. <${URL}#it> a ical:Vtodo ; ical:summary "X" .`,
    );
    expect(taskViewer.matches(c)).toBe(false);
  });

  it("does NOT match an untyped subject carrying only ical:summary (no over-match)", async () => {
    const c = await ctxFromTurtle(
      `@prefix ical: <http://www.w3.org/2002/12/cal/icaltzd#>. <${URL}#x> ical:summary "loose" .`,
    );
    expect(taskViewer.matches(c)).toBe(false);
  });

  it("does not match an unrelated (contacts) document", () => {
    const ds = buildContact(URL, { fn: "Ada Lovelace" });
    expect(taskViewer.matches(buildViewerContext(URL, ds))).toBe(false);
  });
});

describe("taskViewer.extract", () => {
  it("extracts title/description, raw ISO due, completed=false and the priority band", () => {
    const { items } = taskViewer.extract(realTaskCtx());
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Write report");
    expect(items[0].description).toBe("Draft the Q2 report");
    expect(items[0].completed).toBe(false);
    expect(items[0].priority).toBe("high");
    expect(Number.isNaN(Date.parse(items[0].due ?? ""))).toBe(false);
  });

  it("reads completion from the Tasks app's COMPLETED/percentComplete encoding", () => {
    const item = taskViewer.extract(realTaskCtx({ completed: true })).items[0];
    expect(item.completed).toBe(true);
  });

  it("never leaks a raw RDF term", () => {
    const item = taskViewer.extract(realTaskCtx()).items[0];
    expect(item).not.toHaveProperty("dataset");
    expect(item).not.toHaveProperty("quad");
    expect(typeof item.title).toBe("string");
    expect(typeof item.completed).toBe("boolean");
  });

  it("falls back to 'Untitled task' when ical:summary is absent", async () => {
    const c = await ctxFromTurtle(
      `@prefix ical: <http://www.w3.org/2002/12/cal/icaltzd#>. <${URL}#it> a ical:Vtodo ; ical:status "NEEDS-ACTION" .`,
    );
    expect(taskViewer.extract(c).items[0].title).toBe("Untitled task");
  });

  it("orders incomplete before complete, then by due date soonest first", async () => {
    const c = await ctxFromTurtle(
      `@prefix ical: <http://www.w3.org/2002/12/cal/icaltzd#>.
       <${URL}#done> a ical:Vtodo ; ical:summary "Done" ; ical:status "COMPLETED" .
       <${URL}#late> a ical:Vtodo ; ical:summary "Later" ; ical:due "2026-12-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
       <${URL}#soon> a ical:Vtodo ; ical:summary "Soon" ; ical:due "2026-06-20T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .`,
    );
    expect(taskViewer.extract(c).items.map((t) => t.title)).toEqual(["Soon", "Later", "Done"]);
  });
});

describe("selection precedence (Task vs others)", () => {
  it("a task document selects the task viewer", () => {
    expect(selectTypedViewer(realTaskCtx())?.id).toBe("task");
  });

  it("task viewer sits at priority 60", () => {
    expect(taskViewer.priority).toBe(60);
  });

  it("a contacts document does not select the task viewer", () => {
    const ds = buildContact(URL, { fn: "Grace Hopper" });
    const _m: TaskModel = taskViewer.extract(buildViewerContext(URL, ds));
    expect(_m.items).toEqual([]);
  });
});
