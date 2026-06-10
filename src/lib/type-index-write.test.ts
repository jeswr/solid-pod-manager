import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import {
  createMemoryPod,
  TEST_POD_ROOT,
  TEST_PROFILE_DOC,
  TEST_WEBID,
} from "./integrations/core/testing.js";
import { ensureTypeRegistrations } from "./type-index-write.js";
import { TypeIndexDataset, typeIndexLinks } from "./type-index.js";

const MUSIC = "https://schema.org/MusicRecording";
const CONTAINER = `${TEST_POD_ROOT}integrations/spotify/music/`;

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
    expect(result.indexUrl).toBe(`${TEST_POD_ROOT}settings/privateTypeIndex.ttl`);

    // Profile now links the index.
    const links = typeIndexLinks(TEST_WEBID, pod.dataset(TEST_PROFILE_DOC));
    expect(links.privateIndex).toBe(result.indexUrl);
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
