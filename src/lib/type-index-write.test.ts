import { describe, it, expect } from "vitest";
import { DataFactory, Writer } from "n3";
import {
  createMemoryPod,
  TEST_POD_ROOT,
  TEST_PROFILE_DOC,
  TEST_WEBID,
} from "./integrations/core/testing.js";
import { parseRdf } from "@jeswr/fetch-rdf";
import { AclResource } from "@solid/object";
import {
  ensureTypeRegistrations,
  migratePrivateIndexLink,
} from "./type-index-write.js";
import {
  ProfileTypeIndexAnchor,
  TypeIndexDataset,
  resolvePrivateIndex,
  typeIndexLinks,
} from "./type-index.js";
import { preferencesFileLink } from "./preferences.js";
import { ISSUE_CLASS, ISSUES_CONFIG, ISSUES_SLUG } from "./issues.js";

const PREFS_URL = `${TEST_POD_ROOT}settings/preferences.ttl`;

/** Serialise a dataset to Turtle (n3 Writer) for a raw PUT in test setup. */
function turtle(dataset: import("@rdfjs/types").DatasetCore): Promise<string> {
  return new Promise((resolve, reject) => {
    const w = new Writer({ format: "text/turtle" });
    for (const q of dataset) w.addQuad(q);
    w.end((e, r) => (e ? reject(e) : resolve(r)));
  });
}

/** Seed the memory pod's card with a LEGACY `solid:privateTypeIndex` link. */
async function seedLegacyCard(
  pod: ReturnType<typeof createMemoryPod>,
  legacyIndexUrl: string,
): Promise<void> {
  const res = await pod.fetch(TEST_WEBID, { method: "GET" });
  const etag = res.headers.get("etag");
  const card = await parseRdf(await res.text(), "text/turtle", {
    baseIRI: TEST_PROFILE_DOC,
  });
  new ProfileTypeIndexAnchor(TEST_WEBID, card, DataFactory).privateIndex = legacyIndexUrl;
  await pod.fetch(TEST_PROFILE_DOC, {
    method: "PUT",
    headers: {
      "content-type": "text/turtle",
      ...(etag ? { "if-match": etag } : {}),
    },
    body: await turtle(card),
  });
}

const MUSIC = "https://schema.org/MusicRecording";
const CONTAINER = `${TEST_POD_ROOT}integrations/spotify/music/`;
/** The issues container URL as ensureRegistered() would compute it. */
const ISSUES_CONTAINER = `${TEST_POD_ROOT}${ISSUES_SLUG}`;

describe("ensureTypeRegistrations", () => {
  it("bootstraps a private index, links it from the profile, registers the class", async () => {
    const pod = createMemoryPod();

    const result = await ensureTypeRegistrations({
      webId: TEST_WEBID,
      podRoot: TEST_POD_ROOT,
      registrations: [{ forClass: MUSIC, container: CONTAINER }],
      fetchImpl: pod.fetch,
    });

    expect(result.bootstrapped).toBe(true);
    expect(result.added).toBe(1);
    expect(result.migrated).toBe(false); // nothing to migrate on a fresh pod
    expect(result.indexUrl).toBe(`${TEST_POD_ROOT}settings/privateTypeIndex.ttl`);

    // PRIVACY (task #87): the private index is linked from the OWNER-PRIVATE
    // preferences file, NOT the world-readable card.
    const card = pod.dataset(TEST_PROFILE_DOC);
    expect(typeIndexLinks(TEST_WEBID, card).privateIndex).toBeUndefined();
    expect(preferencesFileLink(TEST_WEBID, card)).toBe(PREFS_URL);
    // The prefs file holds the private-index link…
    const prefsAnchor = new ProfileTypeIndexAnchor(
      PREFS_URL,
      pod.dataset(PREFS_URL),
      DataFactory,
    );
    expect(prefsAnchor.privateIndex).toBe(result.indexUrl);
    // …and resolvePrivateIndex finds it via the prefs file.
    const resolved = await resolvePrivateIndex(TEST_WEBID, card, pod.fetch);
    expect(resolved).toEqual({ privateIndex: result.indexUrl, source: "preferences" });
    // …and the profile's original content survived the read-modify-write.
    expect(pod.get(TEST_PROFILE_DOC)).toContain("Alice Test");

    // The index document is typed and carries the registration.
    const index = new TypeIndexDataset(pod.dataset(result.indexUrl), DataFactory);
    expect(index.locate(MUSIC)).toEqual([
      { forClass: MUSIC, instance: undefined, container: CONTAINER },
    ]);
    // Stamped as a private (unlisted) index.
    expect(pod.get(result.indexUrl)).toContain("UnlistedDocument");
  });

  it("is idempotent: re-running adds nothing and writes nothing", async () => {
    const pod = createMemoryPod();
    const reg = { forClass: MUSIC, container: CONTAINER };
    await ensureTypeRegistrations({
      webId: TEST_WEBID,
      podRoot: TEST_POD_ROOT,
      registrations: [reg],
      fetchImpl: pod.fetch,
    });
    const putsAfterFirst = pod.putCount;

    const second = await ensureTypeRegistrations({
      webId: TEST_WEBID,
      podRoot: TEST_POD_ROOT,
      registrations: [reg],
      fetchImpl: pod.fetch,
    });

    expect(second.added).toBe(0);
    expect(second.bootstrapped).toBe(false);
    expect(pod.putCount).toBe(putsAfterFirst); // no redundant writes
  });

  it("reuses an existing linked index without touching the profile", async () => {
    const pod = createMemoryPod();
    // First call bootstraps; second call must reuse and only extend the index.
    await ensureTypeRegistrations({
      webId: TEST_WEBID,
      podRoot: TEST_POD_ROOT,
      registrations: [{ forClass: MUSIC, container: CONTAINER }],
      fetchImpl: pod.fetch,
    });
    const profileBefore = pod.get(TEST_PROFILE_DOC);

    const other = {
      forClass: "https://schema.org/ExerciseAction",
      container: `${TEST_POD_ROOT}integrations/strava/fitness/`,
    };
    const result = await ensureTypeRegistrations({
      webId: TEST_WEBID,
      podRoot: TEST_POD_ROOT,
      registrations: [other],
      fetchImpl: pod.fetch,
    });

    expect(result.added).toBe(1);
    expect(result.bootstrapped).toBe(false);
    expect(pod.get(TEST_PROFILE_DOC)).toBe(profileBefore);

    const index = new TypeIndexDataset(pod.dataset(result.indexUrl), DataFactory);
    expect(index.locate(MUSIC)).toHaveLength(1);
    expect(index.locate(other.forClass)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Privacy migration (task #87): move the private-index link off the public card
// into the owner-private preferences file.
// ---------------------------------------------------------------------------
describe("private type index — preferences file + legacy migration (task #87)", () => {
  const LEGACY_INDEX = `${TEST_POD_ROOT}settings/privateTypeIndex.ttl`;

  it("(a) migrates a legacy card link to prefs and removes it from the card", async () => {
    const pod = createMemoryPod();
    await seedLegacyCard(pod, LEGACY_INDEX);
    // Sanity: the legacy link is on the card before migration.
    expect(typeIndexLinks(TEST_WEBID, pod.dataset(TEST_PROFILE_DOC)).privateIndex).toBe(
      LEGACY_INDEX,
    );

    const result = await ensureTypeRegistrations({
      webId: TEST_WEBID,
      podRoot: TEST_POD_ROOT,
      registrations: [{ forClass: MUSIC, container: CONTAINER }],
      fetchImpl: pod.fetch,
    });

    expect(result.migrated).toBe(true);
    expect(result.bootstrapped).toBe(false); // reuses the legacy index URL
    expect(result.indexUrl).toBe(LEGACY_INDEX);

    const card = pod.dataset(TEST_PROFILE_DOC);
    // The legacy link is GONE from the public card…
    expect(typeIndexLinks(TEST_WEBID, card).privateIndex).toBeUndefined();
    // …and now lives in the prefs file, which is linked from the card.
    expect(preferencesFileLink(TEST_WEBID, card)).toBe(PREFS_URL);
    const resolved = await resolvePrivateIndex(TEST_WEBID, card, pod.fetch);
    expect(resolved).toEqual({ privateIndex: LEGACY_INDEX, source: "preferences" });
    // The registration landed in the (reused) legacy index.
    const index = new TypeIndexDataset(pod.dataset(LEGACY_INDEX), DataFactory);
    expect(index.locate(MUSIC)).toHaveLength(1);
  });

  it("(b) reads the private index from the prefs file when it already lives there", async () => {
    const pod = createMemoryPod();
    // Bootstrap once (lands the link in prefs).
    await ensureTypeRegistrations({
      webId: TEST_WEBID,
      podRoot: TEST_POD_ROOT,
      registrations: [{ forClass: MUSIC, container: CONTAINER }],
      fetchImpl: pod.fetch,
    });
    // The card has NO legacy private-index link — only the prefs link.
    const card = pod.dataset(TEST_PROFILE_DOC);
    expect(typeIndexLinks(TEST_WEBID, card).privateIndex).toBeUndefined();

    const resolved = await resolvePrivateIndex(TEST_WEBID, card, pod.fetch);
    expect(resolved.source).toBe("preferences");
    expect(resolved.privateIndex).toBe(LEGACY_INDEX);
  });

  it("(c) when both card (legacy) and prefs hold a link, prefs wins and the card is cleaned", async () => {
    const pod = createMemoryPod();
    // First bootstrap: link in prefs.
    await ensureTypeRegistrations({
      webId: TEST_WEBID,
      podRoot: TEST_POD_ROOT,
      registrations: [{ forClass: MUSIC, container: CONTAINER }],
      fetchImpl: pod.fetch,
    });
    // Now ALSO plant a STALE legacy link back onto the card (simulating an old
    // app that re-added it), pointing somewhere different.
    const stale = `${TEST_POD_ROOT}settings/stalePrivate.ttl`;
    await seedLegacyCard(pod, stale);
    // Both present now: prefs (LEGACY_INDEX) + card (stale).
    expect(typeIndexLinks(TEST_WEBID, pod.dataset(TEST_PROFILE_DOC)).privateIndex).toBe(stale);

    const result = await ensureTypeRegistrations({
      webId: TEST_WEBID,
      podRoot: TEST_POD_ROOT,
      registrations: [{ forClass: MUSIC, container: CONTAINER }],
      fetchImpl: pod.fetch,
    });

    expect(result.migrated).toBe(true);
    // The card's stale legacy link is removed; the prefs file is authoritative.
    const card = pod.dataset(TEST_PROFILE_DOC);
    expect(typeIndexLinks(TEST_WEBID, card).privateIndex).toBeUndefined();
    const resolved = await resolvePrivateIndex(TEST_WEBID, card, pod.fetch);
    expect(resolved.source).toBe("preferences");
    // The migration overwrites the prefs link with the card's value (the move),
    // so after a re-run the prefs link is whichever the card carried last.
    expect(resolved.privateIndex).toBe(stale);
  });

  it("(d) migration is idempotent — a second run is a no-op (no writes)", async () => {
    const pod = createMemoryPod();
    await seedLegacyCard(pod, LEGACY_INDEX);

    const first = await migratePrivateIndexLink({
      webId: TEST_WEBID,
      podRoot: TEST_POD_ROOT,
      fetchImpl: pod.fetch,
    });
    expect(first).toBe(true);
    const putsAfterFirst = pod.putCount;

    const second = await migratePrivateIndexLink({
      webId: TEST_WEBID,
      podRoot: TEST_POD_ROOT,
      fetchImpl: pod.fetch,
    });
    expect(second).toBe(false); // nothing left on the card → no-op
    expect(pod.putCount).toBe(putsAfterFirst); // no redundant writes
  });

  it("(e) creates the prefs file owner-only when absent (bootstrap path)", async () => {
    const pod = createMemoryPod();
    await ensureTypeRegistrations({
      webId: TEST_WEBID,
      podRoot: TEST_POD_ROOT,
      registrations: [{ forClass: MUSIC, container: CONTAINER }],
      fetchImpl: pod.fetch,
    });

    // The prefs file exists and got an owner-only ACL.
    expect(pod.get(PREFS_URL)).toContain("ConfigurationFile");
    const aclDs = await parseRdf(pod.get(`${PREFS_URL}.acl`) ?? "", "text/turtle", {
      baseIRI: `${PREFS_URL}.acl`,
    });
    const acl = new AclResource(aclDs, DataFactory);
    const auths = [...acl.authorizations];
    expect(auths).toHaveLength(1);
    expect([...auths[0].agent]).toEqual([TEST_WEBID]);
    expect(auths[0].accessibleToAny).toBe(false);
    expect(auths[0].accessibleToAuthenticated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// wf:Task / issues federation registration (pss-77n)
// ---------------------------------------------------------------------------
describe("wf:Task type-index registration for issues (pss-77n)", () => {
  it("registers solid:forClass wf:Task with instanceContainer issues/ (cross-app discovery)", async () => {
    // This is the registration that ProductivityStore.ensureRegistered() makes
    // on the first create() call, using ISSUES_CONFIG.forClass and the computed
    // containerUrl. Simulates the federation discovery seam: other apps
    // (solid-issues) reading wf:Task instanceContainers will find PM's issues/.
    const pod = createMemoryPod();

    const result = await ensureTypeRegistrations({
      webId: TEST_WEBID,
      podRoot: TEST_POD_ROOT,
      registrations: [{ forClass: ISSUE_CLASS, container: ISSUES_CONTAINER }],
      fetchImpl: pod.fetch,
    });

    expect(result.added).toBe(1);
    expect(ISSUE_CLASS).toBe("http://www.w3.org/2005/01/wf/flow#Task");

    const index = new TypeIndexDataset(pod.dataset(result.indexUrl), DataFactory);
    const locs = index.locate(ISSUE_CLASS);
    expect(locs).toHaveLength(1);
    expect(locs[0]).toMatchObject({
      forClass: "http://www.w3.org/2005/01/wf/flow#Task",
      container: ISSUES_CONTAINER,
    });
  });

  it("ISSUES_CONFIG.forClass matches ISSUE_CLASS (the forClass drives the registration)", () => {
    expect(ISSUES_CONFIG.forClass).toBe(ISSUE_CLASS);
  });

  it("is idempotent for the wf:Task registration (re-registering on every create is safe)", async () => {
    const pod = createMemoryPod();
    const reg = { forClass: ISSUE_CLASS, container: ISSUES_CONTAINER };

    await ensureTypeRegistrations({
      webId: TEST_WEBID,
      podRoot: TEST_POD_ROOT,
      registrations: [reg],
      fetchImpl: pod.fetch,
    });
    const putsAfterFirst = pod.putCount;

    const second = await ensureTypeRegistrations({
      webId: TEST_WEBID,
      podRoot: TEST_POD_ROOT,
      registrations: [reg],
      fetchImpl: pod.fetch,
    });

    expect(second.added).toBe(0);
    expect(pod.putCount).toBe(putsAfterFirst);
  });
});
