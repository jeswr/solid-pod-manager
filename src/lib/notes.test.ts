import { describe, it, expect } from "vitest";
import { parseNote, buildNote, notesStore, NOTE_CLASS } from "./notes.js";
import {
  createMemoryPod,
  TEST_POD_ROOT,
  TEST_WEBID,
} from "./integrations/core/testing.js";

describe("buildNote / parseNote round-trip", () => {
  const url = `${TEST_POD_ROOT}notes/a.ttl`;

  it("preserves title, text and modified date", () => {
    const modified = new Date("2026-06-10T09:00:00.000Z");
    const ds = buildNote(url, { title: "Shopping", text: "Milk\nEggs", modified });
    const note = parseNote(url, ds);
    expect(note?.title).toBe("Shopping");
    expect(note?.text).toBe("Milk\nEggs");
    expect(note?.modified?.toISOString()).toBe(modified.toISOString());
  });

  it("stamps the TextDigitalDocument class", () => {
    const ds = buildNote(url, { title: "x", text: "y" });
    const stamped = [...ds].some(
      (q) => q.object.value === NOTE_CLASS,
    );
    expect(stamped).toBe(true);
  });

  it("defaults modified to now when omitted", () => {
    const before = Date.now();
    const ds = buildNote(url, { title: "x", text: "y" });
    const note = parseNote(url, ds);
    expect(note?.modified).toBeInstanceOf(Date);
    expect(note!.modified!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("returns undefined for a document of another class", () => {
    const ds = buildNote(url, { title: "x", text: "y" });
    // Parsing at a different subject url finds no note.
    expect(parseNote(`${TEST_POD_ROOT}notes/other.ttl`, ds)).toBeUndefined();
  });
});

describe("notesStore (I/O via injected fetch)", () => {
  it("creates, lists, reads, updates and deletes a note", async () => {
    const pod = createMemoryPod();
    const store = notesStore({ podRoot: TEST_POD_ROOT, webId: TEST_WEBID, fetchImpl: pod.fetch });

    const { url, etag } = await store.create({ title: "Ideas", text: "first" }, "Ideas");
    expect(url).toContain("/notes/");

    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].data.title).toBe("Ideas");

    await store.update(url, { title: "Ideas", text: "second" }, etag);
    const reread = await store.read(url);
    expect(reread?.data.text).toBe("second");

    await store.remove(url);
    expect(await store.list()).toHaveLength(0);
  });
});
