import { describe, it, expect } from "vitest";
import { parseRdf, RdfFetchError } from "@jeswr/fetch-rdf";
import { DataFactory } from "n3";
import {
  TypeIndexDataset,
  typeIndexLinks,
  readTypeIndex,
  discoverRegistrations,
} from "./type-index.js";

const WEBID = "https://alice.example/profile/card#me";

const PROFILE_TTL = `
@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix foaf: <http://xmlns.com/foaf/0.1/>.
<${WEBID}> a foaf:Person ;
  solid:publicTypeIndex <https://alice.example/settings/publicTypeIndex.ttl> ;
  solid:privateTypeIndex <https://alice.example/settings/privateTypeIndex.ttl> .
`;

const PUBLIC_INDEX_TTL = `
@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix schema: <https://schema.org/>.
<> a solid:TypeIndex, solid:ListedDocument .
<#reg-events> a solid:TypeRegistration ;
  solid:forClass schema:Event ;
  solid:instanceContainer <https://alice.example/calendar/> .
<#reg-photos> a solid:TypeRegistration ;
  solid:forClass schema:ImageObject ;
  solid:instance <https://alice.example/media/photos.ttl> .
`;

describe("typeIndexLinks", () => {
  it("reads both index links off the WebID subject", async () => {
    const ds = await parseRdf(PROFILE_TTL, "text/turtle");
    const links = typeIndexLinks(WEBID, ds);
    expect(links.publicIndex).toBe("https://alice.example/settings/publicTypeIndex.ttl");
    expect(links.privateIndex).toBe("https://alice.example/settings/privateTypeIndex.ttl");
  });

  it("returns undefined links when the profile advertises none", async () => {
    const ds = await parseRdf(
      `@prefix foaf: <http://xmlns.com/foaf/0.1/>. <${WEBID}> a foaf:Person .`,
      "text/turtle",
    );
    expect(typeIndexLinks(WEBID, ds)).toEqual({});
  });
});

describe("TypeIndexDataset", () => {
  it("locates a class by its instanceContainer and instance", async () => {
    const ds = await parseRdf(PUBLIC_INDEX_TTL, "text/turtle");
    const index = new TypeIndexDataset(ds, DataFactory);

    const events = index.locate("https://schema.org/Event");
    expect(events).toHaveLength(1);
    expect(events[0].container).toBe("https://alice.example/calendar/");
    expect(events[0].instance).toBeUndefined();

    const photos = index.locate("https://schema.org/ImageObject");
    expect(photos[0].instance).toBe("https://alice.example/media/photos.ttl");
  });

  it("enumerates every registration via all()", async () => {
    const ds = await parseRdf(PUBLIC_INDEX_TTL, "text/turtle");
    const index = new TypeIndexDataset(ds, DataFactory);
    expect(index.all().map((l) => l.forClass).sort()).toEqual([
      "https://schema.org/Event",
      "https://schema.org/ImageObject",
    ]);
  });
});

describe("readTypeIndex", () => {
  it("returns undefined for a 404 (convention, not enforcement)", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 404 });
    // fetchRdf throws RdfFetchError for non-2xx; readTypeIndex swallows 404.
    await expect(readTypeIndex("https://x.example/i.ttl", fetchImpl)).resolves.toBeUndefined();
  });

  it("propagates non-404/403 errors", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("boom", { status: 500 });
    await expect(readTypeIndex("https://x.example/i.ttl", fetchImpl)).rejects.toBeInstanceOf(
      RdfFetchError,
    );
  });
});

describe("discoverRegistrations", () => {
  it("aggregates locations across public + private indexes", async () => {
    const profile = await parseRdf(PROFILE_TTL, "text/turtle");
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("publicTypeIndex")) {
        return new Response(PUBLIC_INDEX_TTL, {
          status: 200,
          headers: { "content-type": "text/turtle" },
        });
      }
      // private index absent (404) — must not break discovery
      return new Response("", { status: 404 });
    };

    const result = await discoverRegistrations(WEBID, profile, fetchImpl);
    expect(result.hadIndex).toBe(true);
    expect(result.locations.map((l) => l.forClass).sort()).toEqual([
      "https://schema.org/Event",
      "https://schema.org/ImageObject",
    ]);
  });

  it("reports hadIndex=false when both indexes are absent", async () => {
    const profile = await parseRdf(PROFILE_TTL, "text/turtle");
    const fetchImpl: typeof fetch = async () => new Response("", { status: 404 });
    const result = await discoverRegistrations(WEBID, profile, fetchImpl);
    expect(result.hadIndex).toBe(false);
    expect(result.locations).toEqual([]);
  });
});
