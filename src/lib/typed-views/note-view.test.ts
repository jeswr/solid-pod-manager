// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
//
// Targets the shape the first-party Notes app writes (`src/lib/notes.ts`):
// `schema:TextDigitalDocument` + `schema:name` + `schema:text` +
// `schema:dateModified`. Fixtures are built with the real `buildNote` so the
// viewer is tested against actual app output, not a hand-rolled approximation.
import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import { buildNote } from "../notes.js";
import { buildContact } from "../contacts.js";
import { noteViewer, type NoteModel } from "./note-view.js";
import { buildViewerContext, selectTypedViewer } from "./select.js";
import type { ViewerContext } from "./types.js";

const URL = "https://alice.example/notes/n.ttl";

async function ctxFromTurtle(turtle: string, url = URL): Promise<ViewerContext> {
  const ds = await parseRdf(turtle, "text/turtle", { baseIRI: url });
  return buildViewerContext(url, ds);
}

function realNoteCtx(): ViewerContext {
  const ds = buildNote(URL, {
    title: "Shopping list",
    text: "Milk\nEggs",
    modified: new Date("2026-06-11T10:00:00Z"),
  });
  return buildViewerContext(URL, ds);
}

describe("noteViewer.matches", () => {
  it("matches a schema:TextDigitalDocument document (what the Notes app writes)", () => {
    expect(noteViewer.matches(realNoteCtx())).toBe(true);
  });

  it("does NOT match the legacy http://schema.org/ scheme (NoteDoc reads https only — fieldless otherwise)", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <http://schema.org/>. <${URL}#it> a schema:TextDigitalDocument ; schema:name "X" .`,
    );
    expect(noteViewer.matches(c)).toBe(false);
  });

  it("matches the broader schema:DigitalDocument parent class", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <https://schema.org/>. <${URL}#it> a schema:DigitalDocument ; schema:name "X" .`,
    );
    expect(noteViewer.matches(c)).toBe(true);
  });

  it("does NOT match an untyped subject carrying only schema:text (no over-match)", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <https://schema.org/>. <${URL}#x> schema:text "just some text" .`,
    );
    expect(noteViewer.matches(c)).toBe(false);
  });

  it("does not match an unrelated (contacts) document", () => {
    const ds = buildContact(URL, { fn: "Ada Lovelace" });
    expect(noteViewer.matches(buildViewerContext(URL, ds))).toBe(false);
  });
});

describe("noteViewer.extract", () => {
  it("extracts title + body + raw ISO modified from real buildNote output", () => {
    const { items } = noteViewer.extract(realNoteCtx());
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Shopping list");
    expect(items[0].text).toBe("Milk\nEggs");
    expect(items[0].modified).toBeDefined();
    expect(Number.isNaN(Date.parse(items[0].modified ?? ""))).toBe(false);
  });

  it("never leaks a raw RDF term (no `dataset`/`quad`/`name` predicate field)", () => {
    const item = noteViewer.extract(realNoteCtx()).items[0];
    expect(item).not.toHaveProperty("dataset");
    expect(item).not.toHaveProperty("quad");
    // id is the subject IRI, but the model carries only plain scalars otherwise.
    expect(typeof item.id).toBe("string");
    expect(typeof item.title).toBe("string");
  });

  it("falls back to 'Untitled note' when schema:name is absent", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <https://schema.org/>. <${URL}#it> a schema:TextDigitalDocument ; schema:text "body" .`,
    );
    expect(noteViewer.extract(c).items[0].title).toBe("Untitled note");
  });

  it("orders notes most-recently-edited first; undated sink to the end", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <https://schema.org/>.
       <${URL}#old> a schema:TextDigitalDocument ; schema:name "Old" ; schema:dateModified "2026-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
       <${URL}#new> a schema:TextDigitalDocument ; schema:name "New" ; schema:dateModified "2026-06-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
       <${URL}#none> a schema:TextDigitalDocument ; schema:name "None" .`,
    );
    expect(noteViewer.extract(c).items.map((n) => n.title)).toEqual(["New", "Old", "None"]);
  });
});

describe("selection precedence (Note vs others)", () => {
  it("a note document selects the note viewer", () => {
    expect(selectTypedViewer(realNoteCtx())?.id).toBe("note");
  });

  it("note viewer sits at priority 60", () => {
    expect(noteViewer.priority).toBe(60);
  });

  it("a contacts document does not select the note viewer", () => {
    const ds = buildContact(URL, { fn: "Grace Hopper" });
    const _m: NoteModel = noteViewer.extract(buildViewerContext(URL, ds));
    expect(_m.items).toEqual([]);
  });
});
