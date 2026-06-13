// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import type { DatasetCore, Quad } from "@rdfjs/types";
import {
  applyFieldEdit,
  applyFieldEdits,
  readFieldValue,
  valueToTerm,
  FieldValidationError,
} from "./subject-edit.js";
import { CONTACT_FIELDS, EVENT_FIELDS, PHOTO_FIELDS, BOOKMARK_FIELDS } from "./edit-map.js";
import { normaliseField } from "./field-types.js";

const URL = "https://alice.example/data/it.ttl";
const SUBJECT = `${URL}#it`;

async function ds(turtle: string): Promise<DatasetCore> {
  return parseRdf(turtle, "text/turtle", { baseIRI: URL });
}

function objects(d: DatasetCore, subject: string, predicate: string): string[] {
  const out: string[] = [];
  for (const q of d as Iterable<Quad>) {
    if (q.subject.value === subject && q.predicate.value === predicate) out.push(q.object.value);
  }
  return out;
}

const fieldById = (fields: readonly ReturnType<typeof normaliseField>[], id: string) => {
  const f = fields.find((x) => x.id === id);
  if (!f) throw new Error(`no field ${id}`);
  return f;
};

describe("applyFieldEdit — preserve unrelated triples", () => {
  it("replaces only the edited predicate, keeping every other triple", async () => {
    const d = await ds(`
      @prefix vcard: <http://www.w3.org/2006/vcard/ns#>.
      <${SUBJECT}> a vcard:Individual ;
        vcard:fn "Ada Lovelace" ;
        vcard:note "old note" ;
        vcard:hasEmail <mailto:ada@old.example> .`);
    const nameField = fieldById(CONTACT_FIELDS, "http://www.w3.org/2006/vcard/ns#fn");
    const next = applyFieldEdit(d, SUBJECT, nameField, "Ada Byron");

    // fn replaced
    expect(objects(next, SUBJECT, "http://www.w3.org/2006/vcard/ns#fn")).toEqual(["Ada Byron"]);
    // everything else preserved verbatim
    expect(objects(next, SUBJECT, "http://www.w3.org/2006/vcard/ns#note")).toEqual(["old note"]);
    expect(objects(next, SUBJECT, "http://www.w3.org/2006/vcard/ns#hasEmail")).toEqual([
      "mailto:ada@old.example",
    ]);
    expect(
      objects(next, SUBJECT, "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"),
    ).toEqual(["http://www.w3.org/2006/vcard/ns#Individual"]);
  });

  it("writes email as a mailto: IRI", async () => {
    const d = await ds(`<${SUBJECT}> <http://www.w3.org/2006/vcard/ns#fn> "X" .`);
    const emailField = fieldById(CONTACT_FIELDS, "http://www.w3.org/2006/vcard/ns#hasEmail");
    const next = applyFieldEdit(d, SUBJECT, emailField, "x@y.com");
    expect(objects(next, SUBJECT, "http://www.w3.org/2006/vcard/ns#hasEmail")).toEqual([
      "mailto:x@y.com",
    ]);
  });

  it("clears a field when given an empty value", async () => {
    const d = await ds(`
      @prefix vcard: <http://www.w3.org/2006/vcard/ns#>.
      <${SUBJECT}> vcard:fn "X" ; vcard:note "n" .`);
    const noteField = fieldById(CONTACT_FIELDS, "http://www.w3.org/2006/vcard/ns#note");
    const next = applyFieldEdit(d, SUBJECT, noteField, "   ");
    expect(objects(next, SUBJECT, "http://www.w3.org/2006/vcard/ns#note")).toEqual([]);
    // fn untouched
    expect(objects(next, SUBJECT, "http://www.w3.org/2006/vcard/ns#fn")).toEqual(["X"]);
  });

  it("does not mutate the source dataset (returns a new store)", async () => {
    const d = await ds(`<${SUBJECT}> <http://www.w3.org/2006/vcard/ns#fn> "Orig" .`);
    const nameField = fieldById(CONTACT_FIELDS, "http://www.w3.org/2006/vcard/ns#fn");
    applyFieldEdit(d, SUBJECT, nameField, "Changed");
    expect(objects(d, SUBJECT, "http://www.w3.org/2006/vcard/ns#fn")).toEqual(["Orig"]);
  });
});

describe("applyFieldEdit — per typed view round-trips", () => {
  it("event: datetime is stored as an ISO xsd:dateTime literal", async () => {
    const d = await ds(`<${SUBJECT}> a <https://schema.org/Event> ; <https://schema.org/name> "Launch" .`);
    const starts = fieldById(EVENT_FIELDS, "https://schema.org/startDate");
    const next = applyFieldEdit(d, SUBJECT, starts, "2026-07-01T09:30");
    const vals = objects(next, SUBJECT, "https://schema.org/startDate");
    expect(vals).toHaveLength(1);
    expect(vals[0]).toMatch(/^2026-07-01T/);
    // re-reading via the field strips nothing for datetime
    expect(readFieldValue(next, SUBJECT, starts)).toMatch(/^2026-07-01T/);
  });

  it("photo: image URL is stored as an IRI, width as an integer literal", async () => {
    const d = await ds(`<${SUBJECT}> a <https://schema.org/ImageObject> .`);
    const img = fieldById(PHOTO_FIELDS, "https://schema.org/contentUrl");
    const width = fieldById(PHOTO_FIELDS, "https://schema.org/width");
    let next = applyFieldEdit(d, SUBJECT, img, "https://cdn.example/a.jpg");
    next = applyFieldEdit(next, SUBJECT, width, "1024");
    expect(objects(next, SUBJECT, "https://schema.org/contentUrl")).toEqual([
      "https://cdn.example/a.jpg",
    ]);
    expect(objects(next, SUBJECT, "https://schema.org/width")).toEqual(["1024"]);
  });

  it("bookmark: link is stored as an IRI on bookmark:recalls", async () => {
    const d = await ds(`<${SUBJECT}> a <http://www.w3.org/2002/01/bookmark#Bookmark> .`);
    const link = fieldById(BOOKMARK_FIELDS, "http://www.w3.org/2002/01/bookmark#recalls");
    const next = applyFieldEdit(d, SUBJECT, link, "https://example.org/post");
    expect(objects(next, SUBJECT, "http://www.w3.org/2002/01/bookmark#recalls")).toEqual([
      "https://example.org/post",
    ]);
  });
});

describe("valueToTerm — validation", () => {
  const urlField = normaliseField({ label: "U", predicate: "p", kind: "url", mode: "iri" });
  const numField = normaliseField({ label: "N", predicate: "p", kind: "number", mode: "literal" });
  const emailField = normaliseField({ label: "E", predicate: "p", kind: "email", mode: "mailto" });

  it("rejects a non-http URL", () => {
    expect(() => valueToTerm(urlField, "javascript:alert(1)")).toThrow(FieldValidationError);
  });
  it("rejects a non-numeric number", () => {
    expect(() => valueToTerm(numField, "abc")).toThrow(FieldValidationError);
  });
  it("rejects a malformed email", () => {
    expect(() => valueToTerm(emailField, "not-an-email")).toThrow(FieldValidationError);
  });
  it("treats empty as a clear (undefined term)", () => {
    expect(valueToTerm(urlField, "")).toBeUndefined();
  });
});

describe("applyFieldEdits — multi-field, validate-first", () => {
  it("applies several edits in one pass, leaving omitted fields alone", async () => {
    const d = await ds(`
      @prefix vcard: <http://www.w3.org/2006/vcard/ns#>.
      <${SUBJECT}> a vcard:Individual ; vcard:fn "Old" ; vcard:note "keep" .`);
    const next = applyFieldEdits(d, SUBJECT, CONTACT_FIELDS, {
      "http://www.w3.org/2006/vcard/ns#fn": "New",
      "http://www.w3.org/2006/vcard/ns#hasEmail": "new@x.com",
    });
    expect(objects(next, SUBJECT, "http://www.w3.org/2006/vcard/ns#fn")).toEqual(["New"]);
    expect(objects(next, SUBJECT, "http://www.w3.org/2006/vcard/ns#hasEmail")).toEqual([
      "mailto:new@x.com",
    ]);
    expect(objects(next, SUBJECT, "http://www.w3.org/2006/vcard/ns#note")).toEqual(["keep"]);
  });

  it("aborts the whole save (writes nothing) when one value is invalid", async () => {
    const d = await ds(`<${SUBJECT}> a <https://schema.org/ImageObject> .`);
    expect(() =>
      applyFieldEdits(d, SUBJECT, PHOTO_FIELDS, {
        "https://schema.org/name": "Pic",
        "https://schema.org/width": "not-a-number",
      }),
    ).toThrow(FieldValidationError);
  });
});
