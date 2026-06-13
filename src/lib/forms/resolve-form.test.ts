// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import type { DatasetCore } from "@rdfjs/types";
import { resolveForm } from "./resolve-form.js";

const URL = "https://alice.example/data/x.ttl";
const SUBJECT = `${URL}#it`;

async function ds(turtle: string): Promise<DatasetCore> {
  return parseRdf(turtle, "text/turtle", { baseIRI: URL });
}

describe("resolveForm — precedence", () => {
  it("uses an authored ui: form when one is provided", async () => {
    const data = await ds(`<${SUBJECT}> a <http://www.w3.org/2006/vcard/ns#Individual> ; <http://www.w3.org/2006/vcard/ns#fn> "Ada" .`);
    const form = await ds(`
      @prefix ui: <http://www.w3.org/ns/ui#>.
      <#form> a ui:Form ; ui:parts ( <#n> ) .
      <#n> a ui:SingleLineTextField ; ui:property <http://www.w3.org/2006/vcard/ns#fn> ; ui:label "Name" .`);
    const resolved = resolveForm(URL, data, SUBJECT, { formDataset: form });
    expect(resolved.source).toBe("ui-form");
    expect(resolved.fields.map((f) => f.label)).toEqual(["Name"]);
  });

  it("falls back to a typed-view edit map when a viewer matches", async () => {
    const data = await ds(`
      @prefix vcard: <http://www.w3.org/2006/vcard/ns#>.
      <${SUBJECT}> a vcard:Individual ; vcard:fn "Ada" .`);
    const resolved = resolveForm(URL, data, SUBJECT);
    expect(resolved.source).toBe("typed-view");
    expect(resolved.viewerId).toBe("contacts");
    expect(resolved.fields.map((f) => f.label)).toContain("Name");
  });

  it("auto-generates a form for an unknown shape", async () => {
    const data = await ds(`<${SUBJECT}> a <https://example.org/Widget> ; <https://example.org/colour> "blue" .`);
    const resolved = resolveForm(URL, data, SUBJECT);
    expect(resolved.source).toBe("auto");
    expect(resolved.fields.map((f) => f.predicate)).toEqual(["https://example.org/colour"]);
  });
});
