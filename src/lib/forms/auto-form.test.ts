// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import type { DatasetCore } from "@rdfjs/types";
import { autoFormFor, hasAutoForm } from "./auto-form.js";
import { applyFieldEdits } from "./subject-edit.js";

const URL = "https://alice.example/data/x.ttl";
const SUBJECT = `${URL}#it`;

async function ds(turtle: string): Promise<DatasetCore> {
  return parseRdf(turtle, "text/turtle", { baseIRI: URL });
}

describe("autoFormFor — infer widget kinds from object terms", () => {
  it("infers url/date/number/boolean/text from datatypes and IRIs", async () => {
    const d = await ds(`
      @prefix schema: <https://schema.org/>.
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#>.
      <${SUBJECT}> a schema:Thing ;
        schema:name "A thing" ;
        schema:url <https://example.org/p> ;
        schema:startDate "2026-01-02"^^xsd:date ;
        schema:count "3"^^xsd:integer ;
        schema:active "true"^^xsd:boolean .`);
    const fields = autoFormFor(d, SUBJECT);
    const byPred = Object.fromEntries(fields.map((f) => [f.predicate.split("/").pop(), f]));
    expect(byPred.name.kind).toBe("text");
    expect(byPred.url.kind).toBe("url");
    expect(byPred.url.mode).toBe("iri");
    expect(byPred.startDate.kind).toBe("date");
    expect(byPred.count.kind).toBe("number");
    expect(byPred.active.kind).toBe("boolean");
  });

  it("skips rdf:type (never lets the user retype the subject)", async () => {
    const d = await ds(`<${SUBJECT}> a <https://schema.org/Thing> ; <https://schema.org/name> "n" .`);
    const fields = autoFormFor(d, SUBJECT);
    expect(fields.map((f) => f.predicate)).toEqual(["https://schema.org/name"]);
  });

  it("detects mailto:/tel: IRIs as email/phone", async () => {
    const d = await ds(`
      @prefix vcard: <http://www.w3.org/2006/vcard/ns#>.
      <${SUBJECT}> vcard:hasEmail <mailto:a@b.com> ; vcard:hasTelephone <tel:+15551234> .`);
    const fields = autoFormFor(d, SUBJECT);
    const byPred = Object.fromEntries(fields.map((f) => [f.predicate.split("#").pop(), f]));
    expect(byPred.hasEmail.kind).toBe("email");
    expect(byPred.hasTelephone.kind).toBe("tel");
  });

  it("gives a long literal a textarea", async () => {
    const long = "x".repeat(120);
    const d = await ds(`<${SUBJECT}> <https://schema.org/description> "${long}" .`);
    const [field] = autoFormFor(d, SUBJECT);
    expect(field.kind).toBe("textarea");
  });

  it("an auto-form round-trips through the shared writer, preserving other triples", async () => {
    const d = await ds(`
      @prefix schema: <https://schema.org/>.
      <${SUBJECT}> a schema:Thing ; schema:name "Old" ; schema:url <https://e.org/a> .`);
    const fields = autoFormFor(d, SUBJECT);
    const next = applyFieldEdits(d, SUBJECT, fields, { "https://schema.org/name": "New" });
    const names: string[] = [];
    const urls: string[] = [];
    const types: string[] = [];
    for (const q of next) {
      if (q.subject.value === SUBJECT && q.predicate.value === "https://schema.org/name") names.push(q.object.value);
      if (q.subject.value === SUBJECT && q.predicate.value === "https://schema.org/url") urls.push(q.object.value);
      if (q.predicate.value === "http://www.w3.org/1999/02/22-rdf-syntax-ns#type") types.push(q.object.value);
    }
    expect(names).toEqual(["New"]);
    expect(urls).toEqual(["https://e.org/a"]); // untouched
    expect(types).toEqual(["https://schema.org/Thing"]); // untouched
  });
});

describe("hasAutoForm", () => {
  it("true when the subject has any non-type statement", async () => {
    const d = await ds(`<${SUBJECT}> <https://schema.org/name> "n" .`);
    expect(hasAutoForm(d, SUBJECT)).toBe(true);
  });
  it("false when the subject only has rdf:type", async () => {
    const d = await ds(`<${SUBJECT}> a <https://schema.org/Thing> .`);
    expect(hasAutoForm(d, SUBJECT)).toBe(false);
  });
});
