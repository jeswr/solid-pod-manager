import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import { readProfile, requireStorage } from "./profile.js";
import { NoStorageError } from "./errors.js";

const WEBID = "https://alice.example/profile/card#me";

describe("readProfile", () => {
  it("renders name, photo, storage and issuer from a full profile", async () => {
    const ds = await parseRdf(
      `
      @prefix foaf: <http://xmlns.com/foaf/0.1/>.
      @prefix solid: <http://www.w3.org/ns/solid/terms#>.
      @prefix pim: <http://www.w3.org/ns/pim/space#>.
      @prefix vcard: <http://www.w3.org/2006/vcard/ns#>.
      <${WEBID}> a foaf:Person ;
        foaf:name "Alice Example" ;
        vcard:hasPhoto <https://alice.example/me.jpg> ;
        solid:oidcIssuer <https://idp.example/> ;
        pim:storage <https://alice.example/> .
    `,
      "text/turtle",
    );
    const p = readProfile(WEBID, ds);
    expect(p.displayName).toBe("Alice Example");
    expect(p.avatarUrl).toBe("https://alice.example/me.jpg");
    expect(p.storages).toEqual(["https://alice.example/"]);
    expect(p.issuers).toEqual(["https://idp.example/"]);
  });

  it("survives a bare profile: name falls back to the WebID, no storage", async () => {
    const ds = await parseRdf(
      `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
       @prefix solid: <http://www.w3.org/ns/solid/terms#>.
       <${WEBID}> a foaf:Person ; solid:oidcIssuer <https://idp.example/> .`,
      "text/turtle",
    );
    const p = readProfile(WEBID, ds);
    expect(p.displayName).toBe(WEBID);
    expect(p.avatarUrl).toBeUndefined();
    expect(p.storages).toEqual([]);
  });

  it("surfaces every storage when several are advertised (user must choose)", async () => {
    const ds = await parseRdf(
      `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
       @prefix pim: <http://www.w3.org/ns/pim/space#>.
       <${WEBID}> a foaf:Person ;
         pim:storage <https://a.example/>, <https://b.example/> .`,
      "text/turtle",
    );
    const p = readProfile(WEBID, ds);
    expect(new Set(p.storages)).toEqual(new Set(["https://a.example/", "https://b.example/"]));
  });
});

describe("requireStorage", () => {
  it("returns the storage when present", () => {
    expect(
      requireStorage({
        webId: WEBID,
        displayName: "Alice",
        storages: ["https://alice.example/"],
        issuers: [],
      }),
    ).toBe("https://alice.example/");
  });

  it("throws NoStorageError when there is no storage", () => {
    expect(() =>
      requireStorage({ webId: WEBID, displayName: "Alice", storages: [], issuers: [] }),
    ).toThrow(NoStorageError);
  });
});
