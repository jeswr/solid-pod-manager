// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
//
// The privacy fix (task #87): the private type index must be linked from the
// owner-private preferences file, NOT the world-readable WebID card. These tests
// drive the real parse/serialise (via parseRdf / n3.Writer) against an in-memory
// pod; only `fetch` is stubbed.
import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import { AclResource } from "@solid/object";
import { DataFactory } from "n3";
import {
  createMemoryPod,
  TEST_POD_ROOT,
  TEST_PROFILE_DOC,
  TEST_WEBID,
} from "./integrations/core/testing.js";
import {
  ensureOwnerOnly,
  ensurePreferencesFile,
  lockOwnerOnly,
  preferencesFileLink,
  ProfilePreferencesAnchor,
} from "./preferences.js";
import { AclWriteError, AcpUnsupportedError } from "./errors.js";

const PREFS_URL = `${TEST_POD_ROOT}settings/preferences.ttl`;
const FOAF_AGENT = "http://xmlns.com/foaf/0.1/Agent";

/** Read the freshly-fetched profile from the memory pod (card document). */
async function readCard(pod: ReturnType<typeof createMemoryPod>) {
  const res = await pod.fetch(TEST_WEBID, { method: "GET" });
  const body = await res.text();
  return parseRdf(body, "text/turtle", { baseIRI: TEST_PROFILE_DOC });
}

describe("preferencesFileLink", () => {
  it("reads space:preferencesFile off the WebID subject", async () => {
    const ds = await parseRdf(
      `@prefix space: <http://www.w3.org/ns/pim/space#>.
       <${TEST_WEBID}> space:preferencesFile <${PREFS_URL}> .`,
      "text/turtle",
    );
    expect(preferencesFileLink(TEST_WEBID, ds)).toBe(PREFS_URL);
  });

  it("returns undefined when the card links no preferences file", async () => {
    const ds = await parseRdf(
      `@prefix foaf: <http://xmlns.com/foaf/0.1/>. <${TEST_WEBID}> a foaf:Person .`,
      "text/turtle",
    );
    expect(preferencesFileLink(TEST_WEBID, ds)).toBeUndefined();
  });
});

describe("ensurePreferencesFile", () => {
  it("creates the prefs file owner-only and links it from the card when absent", async () => {
    const pod = createMemoryPod();
    const profile = await readCard(pod);

    const result = await ensurePreferencesFile({
      webId: TEST_WEBID,
      podRoot: TEST_POD_ROOT,
      profile,
      profileEtag: '"v1"',
      fetchImpl: pod.fetch,
    });

    expect(result.created).toBe(true);
    expect(result.preferencesFile).toBe(PREFS_URL);

    // The prefs document exists and self-describes as a ConfigurationFile.
    expect(pod.get(PREFS_URL)).toContain("ConfigurationFile");

    // It is linked from the card, and the card's original content survived.
    const card = await readCard(pod);
    expect(preferencesFileLink(TEST_WEBID, card)).toBe(PREFS_URL);
    expect(pod.get(TEST_PROFILE_DOC)).toContain("Alice Test");

    // The prefs file got an OWNER-ONLY ACL: exactly one authorization, naming
    // only the owner agent (no public/authenticated/group), full control.
    const aclDs = await parseRdf(
      pod.get(`${PREFS_URL}.acl`) ?? "",
      "text/turtle",
      { baseIRI: `${PREFS_URL}.acl` },
    );
    const acl = new AclResource(aclDs, DataFactory);
    const auths = [...acl.authorizations];
    expect(auths).toHaveLength(1);
    const owner = auths[0];
    expect([...owner.agent]).toEqual([TEST_WEBID]);
    expect(owner.accessibleToAny).toBe(false);
    expect(owner.accessibleToAuthenticated).toBe(false);
    expect(owner.agentClass.size).toBe(0);
    expect(owner.canRead && owner.canWrite && owner.canReadWriteAcl).toBe(true);
    // accessTo names the prefs file (not the card).
    expect(owner.accessTo).toBe(PREFS_URL);
  });

  it("reuses an existing linked prefs file without touching the card", async () => {
    const pod = createMemoryPod();
    // Seed the card with a prefs link + the prefs file already present.
    const card = await readCard(pod);
    new ProfilePreferencesAnchor(TEST_WEBID, card, DataFactory).preferencesFile = PREFS_URL;
    await pod.fetch(TEST_PROFILE_DOC, {
      method: "PUT",
      headers: { "content-type": "text/turtle", "if-match": '"v1"' },
      body: await (async () => {
        const { Writer } = await import("n3");
        return new Promise<string>((resolve, reject) => {
          const w = new Writer({ format: "text/turtle" });
          for (const q of card) w.addQuad(q);
          w.end((e, r) => (e ? reject(e) : resolve(r)));
        });
      })(),
    });
    const putsBefore = pod.putCount;

    const profile = await readCard(pod);
    const result = await ensurePreferencesFile({
      webId: TEST_WEBID,
      podRoot: TEST_POD_ROOT,
      profile,
      profileEtag: '"v2"',
      fetchImpl: pod.fetch,
    });

    expect(result.created).toBe(false);
    expect(result.preferencesFile).toBe(PREFS_URL);
    expect(pod.putCount).toBe(putsBefore); // no writes when reused
  });
});

describe("lockOwnerOnly", () => {
  it("writes an owner-only ACL discovered from the resource's Link header", async () => {
    const pod = createMemoryPod();
    // Create a resource to lock.
    await pod.fetch(PREFS_URL, {
      method: "PUT",
      headers: { "content-type": "text/turtle" },
      body: `<${PREFS_URL}> a <http://www.w3.org/ns/pim/space#ConfigurationFile> .`,
    });

    await lockOwnerOnly(PREFS_URL, TEST_WEBID, pod.fetch);

    const aclDs = await parseRdf(
      pod.get(`${PREFS_URL}.acl`) ?? "",
      "text/turtle",
      { baseIRI: `${PREFS_URL}.acl` },
    );
    const acl = new AclResource(aclDs, DataFactory);
    const auths = [...acl.authorizations];
    expect(auths).toHaveLength(1);
    expect([...auths[0].agent]).toEqual([TEST_WEBID]);
    // No public agent class ever leaks in.
    expect(auths.some((a) => a.agentClass.has(FOAF_AGENT))).toBe(false);
  });

  it("throws AclWriteError when the ACL PUT is rejected", async () => {
    // A resource that answers discovery with a Link header but rejects the ACL PUT.
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/turtle", link: `<${url}.acl>; rel="acl"` },
        });
      }
      return new Response("forbidden", { status: 403 });
    }) as typeof fetch;

    await expect(lockOwnerOnly(PREFS_URL, TEST_WEBID, fetchImpl)).rejects.toBeInstanceOf(
      AclWriteError,
    );
  });

  it("fails closed (AcpUnsupportedError) on an ACP pod (.acr slot)", async () => {
    // The resource advertises an ACP `.acr` control slot — we don't speak ACP.
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      return new Response("", {
        status: 200,
        headers: { "content-type": "text/turtle", link: `<${url}.acr>; rel="acl"` },
      });
    }) as typeof fetch;

    await expect(lockOwnerOnly(PREFS_URL, TEST_WEBID, fetchImpl)).rejects.toBeInstanceOf(
      AcpUnsupportedError,
    );
  });
});

describe("ensureOwnerOnly", () => {
  it("re-locks a PUBLIC/shared existing ACL down to owner-only (the leak guard)", async () => {
    const pod = createMemoryPod();
    // Create the prefs resource, then plant a PUBLIC-readable ACL on it.
    await pod.fetch(PREFS_URL, {
      method: "PUT",
      headers: { "content-type": "text/turtle" },
      body: `<${PREFS_URL}> a <http://www.w3.org/ns/pim/space#ConfigurationFile> .`,
    });
    await pod.fetch(`${PREFS_URL}.acl`, {
      method: "PUT",
      headers: { "content-type": "text/turtle" },
      body: `@prefix acl: <http://www.w3.org/ns/auth/acl#>.
        @prefix foaf: <http://xmlns.com/foaf/0.1/>.
        <#public> a acl:Authorization ;
          acl:agentClass foaf:Agent ;
          acl:accessTo <${PREFS_URL}> ;
          acl:mode acl:Read .`,
    });

    await ensureOwnerOnly(PREFS_URL, TEST_WEBID, pod.fetch);

    // The ACL is now owner-only: no public agent class survives.
    const aclDs = await parseRdf(pod.get(`${PREFS_URL}.acl`) ?? "", "text/turtle", {
      baseIRI: `${PREFS_URL}.acl`,
    });
    const auths = [...new AclResource(aclDs, DataFactory).authorizations];
    expect(auths.some((a) => a.agentClass.has(FOAF_AGENT))).toBe(false);
    expect(auths.some((a) => a.accessibleToAny)).toBe(false);
    expect(auths.some((a) => a.agent.has(TEST_WEBID))).toBe(true);
  });

  it("is a no-op when the existing ACL is already owner-only (no write)", async () => {
    const pod = createMemoryPod();
    await pod.fetch(PREFS_URL, {
      method: "PUT",
      headers: { "content-type": "text/turtle" },
      body: `<${PREFS_URL}> a <http://www.w3.org/ns/pim/space#ConfigurationFile> .`,
    });
    // Lock it once.
    await lockOwnerOnly(PREFS_URL, TEST_WEBID, pod.fetch);
    const putsBefore = pod.putCount;

    // A second ensureOwnerOnly sees it is already owner-only → no write.
    await ensureOwnerOnly(PREFS_URL, TEST_WEBID, pod.fetch);
    expect(pod.putCount).toBe(putsBefore);
  });

  it("re-locks an owner-only-but-READ-ONLY ACL to full owner (read+write+control)", async () => {
    // The owner holds only Read on the prefs file — owner-only but insufficient
    // to write the private-index link. ensureOwnerOnly must RE-LOCK (roborev Medium).
    const pod = createMemoryPod();
    await pod.fetch(PREFS_URL, {
      method: "PUT",
      headers: { "content-type": "text/turtle" },
      body: `<${PREFS_URL}> a <http://www.w3.org/ns/pim/space#ConfigurationFile> .`,
    });
    await pod.fetch(`${PREFS_URL}.acl`, {
      method: "PUT",
      headers: { "content-type": "text/turtle" },
      body: `@prefix acl: <http://www.w3.org/ns/auth/acl#>.
        <#owner> a acl:Authorization ;
          acl:agent <${TEST_WEBID}> ;
          acl:accessTo <${PREFS_URL}> ;
          acl:mode acl:Read .`,
    });
    const putsBefore = pod.putCount;

    await ensureOwnerOnly(PREFS_URL, TEST_WEBID, pod.fetch);

    expect(pod.putCount).toBeGreaterThan(putsBefore); // a re-lock write happened
    const aclDs = await parseRdf(pod.get(`${PREFS_URL}.acl`) ?? "", "text/turtle", {
      baseIRI: `${PREFS_URL}.acl`,
    });
    const auths = [...new AclResource(aclDs, DataFactory).authorizations];
    const owner = auths.find((a) => a.agent.has(TEST_WEBID));
    expect(owner).toBeDefined();
    expect(owner?.canRead && owner?.canWrite && owner?.canReadWriteAcl).toBe(true);
  });
});
