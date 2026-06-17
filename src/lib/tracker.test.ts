// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect, vi } from "vitest";
// Build real `wf:Tracker` Turtle with the SAME shared model the reader parses, so
// the read path is validated against the actual federated data contract (not a
// hand-written fixture). `serializeTracker` round-trips a TrackerData → Turtle.
import { serializeTracker, DEFAULT_WORKFLOW } from "@jeswr/solid-task-model/tracker";
import {
  readTrackerMeta,
  toTrackerMeta,
  toWorkflowStates,
  trackerDocUrl,
  trackerKey,
  shortIriLabel,
  TRACKER_DOC_LEAF,
  TRACKER_KEY_PREFIX,
  type TrackerMeta,
} from "./tracker.js";

const CONTAINER = "https://alice.example/issues/";
const DOC = `${CONTAINER}index.ttl`;
const WF = "http://www.w3.org/2005/01/wf/flow#";
const TASK_CLASS = `${WF}Task`;

/** A 200 Turtle Response for a fetch stub. */
function ttlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/turtle" } });
}
/** A non-2xx Response. */
function statusResponse(status: number): Response {
  return new Response(`status ${status}`, { status });
}

describe("trackerDocUrl / trackerKey / constants", () => {
  it("derives the index.ttl config doc from a container", () => {
    expect(trackerDocUrl(CONTAINER)).toBe(DOC);
    expect(TRACKER_DOC_LEAF).toBe("index.ttl");
  });

  it("builds a per-container cache key with the prefix", () => {
    expect(trackerKey(CONTAINER)).toBe(`tracker:${CONTAINER}`);
    expect(trackerKey(CONTAINER).startsWith(TRACKER_KEY_PREFIX)).toBe(true);
  });
});

describe("shortIriLabel", () => {
  it("uses the fragment when present", () => {
    expect(shortIriLabel(`${DOC}#status-todo`)).toBe("status-todo");
    expect(shortIriLabel(TASK_CLASS)).toBe("Task");
  });
  it("falls back to the last path segment", () => {
    expect(shortIriLabel("https://alice.example/ns/priority")).toBe("priority");
    expect(shortIriLabel("https://alice.example/ns/priority/")).toBe("priority");
  });
  it("returns the input unchanged when not a parseable URL", () => {
    expect(shortIriLabel("not a url")).toBe("not a url");
  });
});

describe("toWorkflowStates", () => {
  it("resolves each state's open/closed disposition and transition targets", () => {
    const states = toWorkflowStates(DEFAULT_WORKFLOW);
    const byslug = Object.fromEntries(states.map((s) => [s.slug, s]));
    // DEFAULT_WORKFLOW: todo → in-progress → done; done is terminal (closed).
    expect(byslug.todo.resolution).toBe("open");
    expect(byslug.todo.terminal).toBe(false);
    expect(byslug.done.resolution).toBe("closed");
    expect(byslug.done.terminal).toBe(true);
    // todo can reach in-progress + done (per DEFAULT_WORKFLOW), but never itself.
    expect(byslug.todo.transitionsTo).toContain("in-progress");
    expect(byslug.todo.transitionsTo).toContain("done");
    expect(byslug.todo.transitionsTo).not.toContain("todo");
  });
});

describe("toTrackerMeta", () => {
  it("maps TrackerData → TrackerMeta with defaults applied", () => {
    const meta = toTrackerMeta(DOC, {
      title: "Backlog",
      issueClass: TASK_CLASS,
      stateStore: CONTAINER,
      categories: ["https://alice.example/ns/priority"],
      groupMembers: ["https://bob.example/profile#me"],
      workflow: DEFAULT_WORKFLOW,
    });
    expect(meta).toMatchObject<Partial<TrackerMeta>>({
      docUrl: DOC,
      title: "Backlog",
      issueClass: TASK_CLASS,
      stateStore: CONTAINER,
      categories: ["https://alice.example/ns/priority"],
      groupMembers: ["https://bob.example/profile#me"],
    });
    expect(meta.workflowStates.length).toBe(3);
  });

  it("applies the wf:Task default issue class and empty arrays for missing fields", () => {
    const meta = toTrackerMeta(DOC, { title: "" });
    expect(meta.issueClass).toBe(TASK_CLASS);
    expect(meta.categories).toEqual([]);
    expect(meta.groupMembers).toEqual([]);
    expect(meta.stateStore).toBeUndefined();
    expect(meta.workflowStates).toEqual([]);
  });
});

describe("readTrackerMeta — typed read of a wf:Tracker config doc", () => {
  it("parses a real tracker doc (round-tripped through the shared model)", async () => {
    const body = await serializeTracker(DOC, {
      title: "Project issues",
      issueClass: TASK_CLASS,
      stateStore: CONTAINER,
      categories: ["https://alice.example/ns/priority"],
      groupMembers: ["https://bob.example/profile#me"],
      workflow: DEFAULT_WORKFLOW,
    });
    const fetchImpl = vi.fn(async () => ttlResponse(body)) as unknown as typeof fetch;

    const meta = await readTrackerMeta(CONTAINER, fetchImpl);
    expect(meta).toBeDefined();
    expect(meta?.docUrl).toBe(DOC);
    expect(meta?.title).toBe("Project issues");
    expect(meta?.issueClass).toBe(TASK_CLASS);
    expect(meta?.stateStore).toBe(CONTAINER);
    expect(meta?.categories).toEqual(["https://alice.example/ns/priority"]);
    expect(meta?.groupMembers).toEqual(["https://bob.example/profile#me"]);
    // The default workflow surfaces all three states with resolutions.
    expect(meta?.workflowStates.map((s) => s.slug).sort()).toEqual(
      ["done", "in-progress", "todo"].sort(),
    );
    expect(meta?.workflowStates.find((s) => s.slug === "done")?.resolution).toBe("closed");

    // It reads the index.ttl config doc, not the container itself.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calledUrl = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(String(calledUrl)).toBe(DOC);
  });

  it("returns undefined when the config doc is absent (404 → no tracker configured)", async () => {
    const fetchImpl = vi.fn(async () => statusResponse(404)) as unknown as typeof fetch;
    await expect(readTrackerMeta(CONTAINER, fetchImpl)).resolves.toBeUndefined();
  });

  it("returns undefined when the doc exists but is NOT a wf:Tracker", async () => {
    // A 200 document with no wf:Tracker subject at #this → not a tracker config.
    const notATracker = `@prefix dct: <http://purl.org/dc/terms/> .
<${DOC}#this> dct:title "Just a document" .`;
    const fetchImpl = vi.fn(async () => ttlResponse(notATracker)) as unknown as typeof fetch;
    await expect(readTrackerMeta(CONTAINER, fetchImpl)).resolves.toBeUndefined();
  });

  it("FAILS CLOSED on an ambiguous read (403 → re-throws, never silently 'no tracker')", async () => {
    const fetchImpl = vi.fn(async () => statusResponse(403)) as unknown as typeof fetch;
    await expect(readTrackerMeta(CONTAINER, fetchImpl)).rejects.toThrowError();
  });

  it("FAILS CLOSED on a 5xx (re-throws)", async () => {
    const fetchImpl = vi.fn(async () => statusResponse(500)) as unknown as typeof fetch;
    await expect(readTrackerMeta(CONTAINER, fetchImpl)).rejects.toThrowError();
  });
});
