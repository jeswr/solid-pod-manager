// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { Parser, Store } from "n3";
import {
  listAllRegistrations,
  addRegistration,
  removeRegistration,
} from "./type-index-manage.js";

const WEBID = "https://alice.example/profile/card#me";
const PUBLIC_INDEX = "https://alice.example/settings/publicTypeIndex.ttl";
const PRIVATE_INDEX = "https://alice.example/settings/privateTypeIndex.ttl";
const EVENT = "http://schema.org/Event";
const CONTACT = "http://www.w3.org/2006/vcard/ns#Individual";

const PROFILE = `
@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix foaf: <http://xmlns.com/foaf/0.1/>.
<${WEBID}> a foaf:Person ;
  solid:publicTypeIndex <${PUBLIC_INDEX}> ;
  solid:privateTypeIndex <${PRIVATE_INDEX}> .
`;

const PUBLIC_TTL = `
@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix schema: <http://schema.org/>.
<> a solid:TypeIndex, solid:ListedDocument .
<#reg-events> a solid:TypeRegistration ;
  solid:forClass schema:Event ;
  solid:instanceContainer <https://alice.example/calendar/> .
`;

const PRIVATE_TTL = `
@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix vcard: <http://www.w3.org/2006/vcard/ns#>.
<> a solid:TypeIndex, solid:UnlistedDocument .
<#reg-contacts> a solid:TypeRegistration ;
  solid:forClass vcard:Individual ;
  solid:instanceContainer <https://alice.example/contacts/> .
`;

/** A tiny in-memory index server keyed by document URL, with ETags + If-Match. */
function indexPod(seed: Record<string, string>) {
  const store = new Map<string, { body: string; v: number }>();
  for (const [k, v] of Object.entries(seed)) store.set(k, { body: v, v: 1 });
  const strip = (u: string) => (u.includes("#") ? u.slice(0, u.indexOf("#")) : u);
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = strip(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const cur = store.get(url);
    if (method === "GET") {
      if (!cur) return new Response("nf", { status: 404 });
      return new Response(cur.body, {
        status: 200,
        headers: { "content-type": "text/turtle", etag: `"v${cur.v}"` },
      });
    }
    if (method === "PUT") {
      const ifMatch = new Headers(init?.headers).get("if-match");
      if (ifMatch && (!cur || `"v${cur.v}"` !== ifMatch)) {
        return new Response("precondition", { status: 412 });
      }
      store.set(url, { body: String(init?.body ?? ""), v: (cur?.v ?? 0) + 1 });
      return new Response(null, { status: 205, headers: { etag: `"v${(cur?.v ?? 0) + 1}"` } });
    }
    return new Response("nope", { status: 405 });
  }) as typeof fetch;
  const dataset = (url: string) => {
    const body = store.get(strip(url))?.body ?? "";
    const s = new Store();
    if (body.trim()) s.addQuads(new Parser({ baseIRI: strip(url) }).parse(body));
    return s;
  };
  return { fetch: fetchImpl, dataset, get: (u: string) => store.get(strip(u))?.body };
}

function profileDataset(): import("@rdfjs/types").DatasetCore {
  const s = new Store();
  s.addQuads(new Parser().parse(PROFILE));
  return s;
}

describe("listAllRegistrations", () => {
  it("enumerates registrations across both indexes, tagged with kind + subject", async () => {
    const pod = indexPod({ [PUBLIC_INDEX]: PUBLIC_TTL, [PRIVATE_INDEX]: PRIVATE_TTL });
    const out = await listAllRegistrations(WEBID, profileDataset(), pod.fetch);

    expect(out.publicIndex).toBe(PUBLIC_INDEX);
    expect(out.privateIndex).toBe(PRIVATE_INDEX);
    expect(out.registrations).toHaveLength(2);

    const ev = out.registrations.find((r) => r.forClass === EVENT);
    expect(ev?.indexKind).toBe("public");
    expect(ev?.container).toBe("https://alice.example/calendar/");
    expect(ev?.subject).toBe(`${PUBLIC_INDEX}#reg-events`);

    const ct = out.registrations.find((r) => r.forClass === CONTACT);
    expect(ct?.indexKind).toBe("private");
  });

  it("tolerates a missing index (404) without failing", async () => {
    const pod = indexPod({ [PUBLIC_INDEX]: PUBLIC_TTL }); // private absent
    const out = await listAllRegistrations(WEBID, profileDataset(), pod.fetch);
    expect(out.registrations).toHaveLength(1);
    expect(out.registrations[0].indexKind).toBe("public");
  });
});

describe("addRegistration", () => {
  it("adds a new container registration (read-modify-write)", async () => {
    const pod = indexPod({ [PUBLIC_INDEX]: PUBLIC_TTL });
    const res = await addRegistration({
      indexUrl: PUBLIC_INDEX,
      registration: { forClass: CONTACT, container: "https://alice.example/contacts/" },
      fetchImpl: pod.fetch,
    });
    expect(res.added).toBe(true);

    const after = await listAllRegistrations(WEBID, profileDataset(), pod.fetch);
    expect(after.registrations.some((r) => r.forClass === CONTACT)).toBe(true);
  });

  it("is idempotent for an identical entry", async () => {
    const pod = indexPod({ [PUBLIC_INDEX]: PUBLIC_TTL });
    const res = await addRegistration({
      indexUrl: PUBLIC_INDEX,
      registration: { forClass: EVENT, container: "https://alice.example/calendar/" },
      fetchImpl: pod.fetch,
    });
    expect(res.added).toBe(false);
  });

  it("rejects when neither or both of container/instance are given", async () => {
    const pod = indexPod({ [PUBLIC_INDEX]: PUBLIC_TTL });
    await expect(
      addRegistration({ indexUrl: PUBLIC_INDEX, registration: { forClass: EVENT }, fetchImpl: pod.fetch }),
    ).rejects.toThrow(TypeError);
    await expect(
      addRegistration({
        indexUrl: PUBLIC_INDEX,
        registration: { forClass: EVENT, container: "https://a/", instance: "https://a/x" },
        fetchImpl: pod.fetch,
      }),
    ).rejects.toThrow(TypeError);
  });

  it("supports an instance (single resource) registration", async () => {
    const pod = indexPod({ [PUBLIC_INDEX]: PUBLIC_TTL });
    await addRegistration({
      indexUrl: PUBLIC_INDEX,
      registration: { forClass: "http://schema.org/ImageObject", instance: "https://alice.example/p.ttl" },
      fetchImpl: pod.fetch,
    });
    const after = await listAllRegistrations(WEBID, profileDataset(), pod.fetch);
    const img = after.registrations.find((r) => r.forClass === "http://schema.org/ImageObject");
    expect(img?.instance).toBe("https://alice.example/p.ttl");
    expect(img?.container).toBeUndefined();
  });
});

describe("removeRegistration", () => {
  it("removes every triple about the registration subject", async () => {
    const pod = indexPod({ [PUBLIC_INDEX]: PUBLIC_TTL });
    const res = await removeRegistration({
      indexUrl: PUBLIC_INDEX,
      subject: `${PUBLIC_INDEX}#reg-events`,
      fetchImpl: pod.fetch,
    });
    expect(res.removed).toBe(true);

    const after = await listAllRegistrations(WEBID, profileDataset(), pod.fetch);
    expect(after.registrations).toHaveLength(0);
    // The index document itself is preserved (its type triples remain).
    expect(pod.get(PUBLIC_INDEX)).toContain("TypeIndex");
  });

  it("is a no-op for an unknown subject", async () => {
    const pod = indexPod({ [PUBLIC_INDEX]: PUBLIC_TTL });
    const res = await removeRegistration({
      indexUrl: PUBLIC_INDEX,
      subject: `${PUBLIC_INDEX}#reg-nope`,
      fetchImpl: pod.fetch,
    });
    expect(res.removed).toBe(false);
  });
});
