// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
//
// Targets a WebID/profile document (`foaf:Person`) — the richest "who you are"
// shape. The viewer reuses ProfileAgent's fallback chains (name/avatar/bio/
// nickname/homepage). Its priority (80) is ABOVE Contacts (70) so a profile
// document gets the snippet card while a plain vcard contact still gets Contacts.
import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import { buildContact } from "../contacts.js";
import { profileViewer, type ProfileModel } from "./profile-view.js";
import { contactsViewer } from "./contacts-view.js";
import { buildViewerContext, selectTypedViewer } from "./select.js";
import type { ViewerContext } from "./types.js";

const URL = "https://alice.example/profile/card";
const WEBID = `${URL}#me`;

const PREFIXES = `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix schema: <https://schema.org/>.
@prefix vcard: <http://www.w3.org/2006/vcard/ns#>.
`;

async function ctxFromTurtle(turtle: string, url = URL): Promise<ViewerContext> {
  const ds = await parseRdf(`${PREFIXES}${turtle}`, "text/turtle", { baseIRI: url });
  return buildViewerContext(url, ds);
}

const FULL_PROFILE = `<${WEBID}> a foaf:Person ;
  foaf:name "Ada Lovelace" ;
  foaf:nick "ada" ;
  foaf:img <https://alice.example/avatar.png> ;
  vcard:note "Mathematician and first programmer." ;
  foaf:homepage <https://ada.example/> .`;

describe("profileViewer.matches", () => {
  it("matches a foaf:Person profile document", async () => {
    expect(profileViewer.matches(await ctxFromTurtle(FULL_PROFILE))).toBe(true);
  });

  it("matches http://schema.org/Person (the scheme ProfileAgent reads)", async () => {
    const http = await ctxFromTurtle(
      `@prefix s: <http://schema.org/>. <${WEBID}> a s:Person ; foaf:name "Y" .`,
    );
    expect(profileViewer.matches(http)).toBe(true);
  });

  it("does NOT match https://schema.org/Person (ProfileAgent reads http only — fieldless otherwise)", async () => {
    // foaf:name is absent here so the only readable fields would be https-scheme,
    // which the agent can't read; the matcher refuses rather than render fieldless.
    const https = await ctxFromTurtle(`<${WEBID}> a schema:Person ; schema:name "X" .`);
    expect(profileViewer.matches(https)).toBe(false);
  });

  it("does NOT match a plain vcard:Individual contact (that is Contacts' job)", () => {
    const ds = buildContact(URL, { fn: "Ada Lovelace" });
    expect(profileViewer.matches(buildViewerContext(URL, ds))).toBe(false);
  });

  it("does NOT match an EMBEDDED foaf:Person under a foreign IRI (an author/assignee)", async () => {
    // The primary subject is a blog post; a foaf:Person is embedded as its author.
    const c = await ctxFromTurtle(
      `@prefix schema: <https://schema.org/>.
       <${URL}#post> a schema:Article ; schema:headline "Hi" ; schema:author <https://bob.example/card#me> .
       <https://bob.example/card#me> a foaf:Person ; foaf:name "Bob" .`,
    );
    // Bob is embedded (foreign IRI, not a fragment of this doc) → no profile match.
    expect(profileViewer.matches(c)).toBe(false);
  });

  it("matches a person at the bare document URL (no fragment)", async () => {
    const c = await ctxFromTurtle(`<${URL}> a foaf:Person ; foaf:name "Docroot Person" .`);
    expect(profileViewer.matches(c)).toBe(true);
  });
});

describe("profileViewer.extract", () => {
  it("extracts name/nickname/bio/avatar and a safe homepage via the ProfileAgent chains", async () => {
    const { items } = profileViewer.extract(await ctxFromTurtle(FULL_PROFILE));
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("Ada Lovelace");
    expect(items[0].nickname).toBe("ada");
    expect(items[0].bio).toBe("Mathematician and first programmer.");
    expect(items[0].avatarUrl).toBe("https://alice.example/avatar.png");
    expect(items[0].homepage).toBe("https://ada.example/");
  });

  it("falls back to the WebID IRI as the name when no name triple exists", async () => {
    const c = await ctxFromTurtle(`<${WEBID}> a foaf:Person .`);
    expect(profileViewer.extract(c).items[0].name).toBe(WEBID);
  });

  it("drops an unsafe (non-http) homepage", async () => {
    const c = await ctxFromTurtle(
      `<${WEBID}> a foaf:Person ; foaf:name "X" ; foaf:homepage <javascript:alert(1)> .`,
    );
    expect(profileViewer.extract(c).items[0].homepage).toBeUndefined();
  });

  it("never leaks a raw RDF term", async () => {
    const item = profileViewer.extract(await ctxFromTurtle(FULL_PROFILE)).items[0];
    expect(item).not.toHaveProperty("dataset");
    expect(item).not.toHaveProperty("quad");
    expect(typeof item.name).toBe("string");
  });

  it("extracts NOTHING for an embedded foreign-IRI person (only primary subjects)", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <https://schema.org/>.
       <${URL}#post> a schema:Article ; schema:author <https://bob.example/card#me> .
       <https://bob.example/card#me> a foaf:Person ; foaf:name "Bob" .`,
    );
    expect(profileViewer.extract(c).items).toEqual([]);
  });
});

describe("selection precedence (Profile vs Contacts)", () => {
  it("a foaf:Person profile selects the PROFILE viewer (80 > Contacts 70)", async () => {
    expect(selectTypedViewer(await ctxFromTurtle(FULL_PROFILE))?.id).toBe("profile");
  });

  it("a plain vcard:Individual contact still selects the CONTACTS viewer", () => {
    const ds = buildContact(URL, { fn: "Grace Hopper" });
    expect(selectTypedViewer(buildViewerContext(URL, ds))?.id).toBe("contacts");
  });

  it("profile viewer sits at priority 80, above contacts (70)", () => {
    expect(profileViewer.priority).toBe(80);
    expect(profileViewer.priority).toBeGreaterThan(contactsViewer.priority);
  });

  it("returns an empty model for a non-person document", async () => {
    const c = await ctxFromTurtle(`<${URL}#x> a foaf:Document .`);
    const _m: ProfileModel = profileViewer.extract(c);
    expect(_m.items).toEqual([]);
  });
});
