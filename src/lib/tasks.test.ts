// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import {
  parseTask,
  buildTask,
  tasksStore,
  sortTasks,
  isOverdue,
  priorityFromIcal,
  priorityToIcal,
  TASK_CLASS,
  type Task,
} from "./tasks.js";
import {
  createMemoryPod,
  parseTurtle,
  TEST_POD_ROOT,
  TEST_WEBID,
} from "./integrations/core/testing.js";
import type { StoredItem } from "./productivity-store.js";

const url = `${TEST_POD_ROOT}tasks/t.ttl`;

describe("priority mapping", () => {
  it("maps UI bands to/from the iCal 0-9 scale", () => {
    expect(priorityToIcal("none")).toBeUndefined();
    expect(priorityToIcal("high")).toBe(1);
    expect(priorityToIcal("medium")).toBe(5);
    expect(priorityToIcal("low")).toBe(9);
    expect(priorityFromIcal(undefined)).toBe("none");
    expect(priorityFromIcal(0)).toBe("none");
    expect(priorityFromIcal(1)).toBe("high");
    expect(priorityFromIcal(4)).toBe("high");
    expect(priorityFromIcal(5)).toBe("medium");
    expect(priorityFromIcal(9)).toBe("low");
  });
});

describe("buildTask / parseTask round-trip", () => {
  it("preserves title, description, due, completed and priority", () => {
    const due = new Date("2026-07-01T09:30:00Z");
    const ds = buildTask(url, {
      title: "Write report",
      description: "Q2 numbers",
      due,
      completed: false,
      priority: "high",
    });
    const t = parseTask(url, ds);
    expect(t?.title).toBe("Write report");
    expect(t?.description).toBe("Q2 numbers");
    expect(t?.due?.getTime()).toBe(due.getTime());
    expect(t?.completed).toBe(false);
    expect(t?.priority).toBe("high");
  });

  it("stamps icaltzd:Vtodo and COMPLETED status", () => {
    const ds = buildTask(url, { title: "Done", completed: true, priority: "none" });
    expect([...ds].some((q) => q.object.value === TASK_CLASS)).toBe(true);
    const t = parseTask(url, ds);
    expect(t?.completed).toBe(true);
    expect(t?.priority).toBe("none");
  });

  it("handles a minimal task (title only)", () => {
    const ds = buildTask(url, { title: "Buy milk", completed: false, priority: "none" });
    const t = parseTask(url, ds);
    expect(t?.title).toBe("Buy milk");
    expect(t?.due).toBeUndefined();
    expect(t?.description).toBeUndefined();
  });

  it("returns undefined for a non-task document", () => {
    const ds = buildTask(url, { title: "X", completed: false, priority: "none" });
    expect(parseTask(`${TEST_POD_ROOT}tasks/other.ttl`, ds)).toBeUndefined();
  });

  it("treats percentComplete=100 or a completed timestamp as done", () => {
    const ICAL = "http://www.w3.org/2002/12/cal/icaltzd#";
    const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
    // percentComplete=100 without STATUS:COMPLETED.
    const percentDoc = parseTurtle(
      `<${url}#it> <${RDF_TYPE}> <${ICAL}Vtodo> ; <${ICAL}summary> "P" ; <${ICAL}percentComplete> 100 .`,
      url,
    );
    expect(parseTask(url, percentDoc)?.completed).toBe(true);
    // A completed timestamp without STATUS:COMPLETED.
    const completedDoc = parseTurtle(
      `<${url}#it> <${RDF_TYPE}> <${ICAL}Vtodo> ; <${ICAL}summary> "C" ; <${ICAL}completed> "2026-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .`,
      url,
    );
    expect(parseTask(url, completedDoc)?.completed).toBe(true);
  });
});

function item(data: Task): StoredItem<Task> {
  return { url: `${TEST_POD_ROOT}tasks/${data.title}.ttl`, etag: null, data };
}

describe("sortTasks", () => {
  it("orders incomplete-first, then by due, then priority", () => {
    const done = item({ title: "done", completed: true, priority: "high" });
    const soon = item({
      title: "soon",
      completed: false,
      priority: "low",
      due: new Date("2026-01-01T00:00:00Z"),
    });
    const later = item({
      title: "later",
      completed: false,
      priority: "high",
      due: new Date("2026-12-01T00:00:00Z"),
    });
    const noDate = item({ title: "noDate", completed: false, priority: "high" });
    const sorted = sortTasks([done, later, noDate, soon]).map((i) => i.data.title);
    expect(sorted).toEqual(["soon", "later", "noDate", "done"]);
  });
});

describe("isOverdue", () => {
  it("flags a past, incomplete task with a due date", () => {
    const now = new Date("2026-06-13T12:00:00Z");
    expect(isOverdue({ title: "x", completed: false, priority: "none", due: new Date("2026-06-01T00:00:00Z") }, now)).toBe(true);
    expect(isOverdue({ title: "x", completed: true, priority: "none", due: new Date("2026-06-01T00:00:00Z") }, now)).toBe(false);
    expect(isOverdue({ title: "x", completed: false, priority: "none", due: new Date("2026-07-01T00:00:00Z") }, now)).toBe(false);
    expect(isOverdue({ title: "x", completed: false, priority: "none" }, now)).toBe(false);
  });
});

describe("tasksStore (I/O)", () => {
  it("creates, completes and deletes a task", async () => {
    const pod = createMemoryPod();
    const store = tasksStore({ podRoot: TEST_POD_ROOT, webId: TEST_WEBID, fetchImpl: pod.fetch });
    const { url: created, etag } = await store.create(
      { title: "Ship it", completed: false, priority: "medium" },
      "Ship it",
    );
    let items = await store.list();
    expect(items).toHaveLength(1);
    expect(items[0].data.completed).toBe(false);

    await store.update(created, { ...items[0].data, completed: true }, etag);
    const reread = await store.read(created);
    expect(reread?.data.completed).toBe(true);

    await store.remove(created);
    items = await store.list();
    expect(items).toHaveLength(0);
  });
});
