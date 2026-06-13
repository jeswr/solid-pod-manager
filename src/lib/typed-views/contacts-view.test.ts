// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import { buildContact } from "../contacts.js";
import { contactsViewer } from "./contacts-view.js";
import { buildViewerContext } from "./select.js";
import type { ViewerContext } from "./types.js";

const URL = "https://alice.example/contacts/c.ttl";

async function ctxFromTurtle(turtle: string): Promise<ViewerContext> {
  const ds = await parseRdf(turtle, "text/turtle", { baseIRI: URL });
  return buildViewerContext(URL, ds);
}

describe("contactsViewer.matches", () => {
  it("matches a vcard:Individual (the class contacts.ts writes)", () => {
    const ds = buildContact(URL, { fn: "Ada Lovelace", email: "ada@example.com" });
    expect(contactsViewer.matches(buildViewerContext(URL, ds))).toBe(true);
  });

  it("matches a foaf:Person profile (avatar-bearing sibling)", async () => {
    const c = await ctxFromTurtle(
      `@prefix foaf: <http://xmlns.com/foaf/0.1/>. <${URL}#me> a foaf:Person ; foaf:name "Bob" .`,
    );
    expect(contactsViewer.matches(c)).toBe(true);
  });

  it("matches an untyped subject by the vcard:fn signature predicate (shape rescue)", async () => {
    const c = await ctxFromTurtle(
      `@prefix vcard: <http://www.w3.org/2006/vcard/ns#>. <${URL}#it> vcard:fn "Untyped Person" .`,
    );
    expect(contactsViewer.matches(c)).toBe(true);
  });

  it("does not match an unrelated document", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <https://schema.org/>. <${URL}#a> a schema:MusicRecording ; schema:name "Song" .`,
    );
    expect(contactsViewer.matches(c)).toBe(false);
  });
});

describe("contactsViewer.extract", () => {
  it("extracts name, bare email/phone and the raw mailto:/tel: URIs (no raw triples)", () => {
    const ds = buildContact(URL, {
      fn: "Ada Lovelace",
      email: "ada@example.com",
      phone: "+44 20 7946 0958",
      note: "Met at conference",
    });
    const { items } = contactsViewer.extract(buildViewerContext(URL, ds));
    expect(items).toHaveLength(1);
    const c = items[0];
    expect(c.name).toBe("Ada Lovelace");
    expect(c.email).toBe("ada@example.com");
    expect(c.emailUri).toBe("mailto:ada@example.com");
    expect(c.phone).toBe("+442079460958");
    expect(c.phoneUri).toBe("tel:+442079460958");
    expect(c.note).toBe("Met at conference");
  });

  it("reuses the ProfileAgent fallback chain for name + avatar on a profile", async () => {
    const c = await ctxFromTurtle(
      `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
       @prefix vcard: <http://www.w3.org/2006/vcard/ns#>.
       <${URL}#me> a foaf:Person ; foaf:name "Bob Builder" ;
         vcard:hasPhoto <https://img.example/bob.png> .`,
    );
    const { items } = contactsViewer.extract(c);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("Bob Builder");
    expect(items[0].avatarUrl).toBe("https://img.example/bob.png");
  });

  it("renders a list over multiple contact subjects, sorted by name", async () => {
    const c = await ctxFromTurtle(
      `@prefix vcard: <http://www.w3.org/2006/vcard/ns#>.
       <${URL}#z> a vcard:Individual ; vcard:fn "Zoe" .
       <${URL}#a> a vcard:Individual ; vcard:fn "Amy" .`,
    );
    const { items } = contactsViewer.extract(c);
    expect(items.map((i) => i.name)).toEqual(["Amy", "Zoe"]);
  });

  it("falls back to the subject IRI when a contact has no name", async () => {
    const c = await ctxFromTurtle(
      `@prefix vcard: <http://www.w3.org/2006/vcard/ns#>.
       <${URL}#it> a vcard:Individual ; vcard:hasEmail <mailto:x@y.z> .`,
    );
    const { items } = contactsViewer.extract(c);
    expect(items[0].name).toBe(`${URL}#it`);
    expect(items[0].email).toBe("x@y.z");
  });
});
