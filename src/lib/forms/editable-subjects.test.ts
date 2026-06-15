// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import type { DatasetCore } from "@rdfjs/types";
import { editableSubjects } from "./editable-subjects.js";

const URL = "https://alice.example/contacts/book.ttl";

async function ds(turtle: string): Promise<DatasetCore> {
  return parseRdf(turtle, "text/turtle", { baseIRI: URL });
}

describe("editableSubjects", () => {
  it("returns the viewer id + one subject per rendered item, in viewer order", async () => {
    const d = await ds(`
      @prefix vcard: <http://www.w3.org/2006/vcard/ns#>.
      <${URL}#z> a vcard:Individual ; vcard:fn "Zoe" .
      <${URL}#a> a vcard:Individual ; vcard:fn "Amy" .`);
    const out = editableSubjects(URL, d);
    expect(out?.viewerId).toBe("contacts");
    // Contacts sort by name → Amy, Zoe
    expect(out?.subjects.map((s) => s.label)).toEqual(["Amy", "Zoe"]);
    expect(out?.subjects.map((s) => s.id)).toEqual([`${URL}#a`, `${URL}#z`]);
  });

  it("returns undefined when no typed viewer matches", async () => {
    const d = await ds(`<${URL}#x> <https://example.org/p> "v" .`);
    expect(editableSubjects(URL, d)).toBeUndefined();
  });

  it("labels event subjects by their title", async () => {
    const d = await ds(`
      @prefix schema: <https://schema.org/>.
      <${URL}#e> a schema:Event ; schema:name "Launch" ; schema:startDate "2026-01-01T00:00:00Z" .`);
    const out = editableSubjects(URL, d);
    expect(out?.viewerId).toBe("event");
    expect(out?.subjects[0].label).toBe("Launch");
  });
});
