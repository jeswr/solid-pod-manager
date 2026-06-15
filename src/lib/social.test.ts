// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import {
  readKnows,
  addFriend,
  removeFriend,
  parseGroup,
  buildGroup,
  groupsStore,
  GROUP_CLASS,
  type Group,
} from "./social.js";
import { createMemoryPod, TEST_POD_ROOT, TEST_WEBID } from "./integrations/core/testing.js";

const WEBID = "https://alice.example/profile/card#me";
const BOB = "https://bob.example/profile/card#me";
const CAROL = "https://carol.example/profile/card#me";

describe("foaf:knows reading", () => {
  it("reads and sorts the knows set", async () => {
    const ds = await parseRdf(
      `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
       <${WEBID}> foaf:knows <${CAROL}>, <${BOB}> .`,
      "text/turtle",
    );
    expect(readKnows(WEBID, ds)).toEqual([BOB, CAROL]);
  });

  it("returns [] when no knows triples", async () => {
    const ds = await parseRdf(
      `@prefix foaf: <http://xmlns.com/foaf/0.1/>. <${WEBID}> a foaf:Person .`,
      "text/turtle",
    );
    expect(readKnows(WEBID, ds)).toEqual([]);
  });
});

describe("addFriend / removeFriend (I/O, read-modify-write)", () => {
  it("adds idempotently and removes on the profile card", async () => {
    const pod = createMemoryPod();

    let friends = await addFriend({ webId: TEST_WEBID, friend: BOB, fetchImpl: pod.fetch });
    expect(friends).toEqual([BOB]);

    // Idempotent re-add: still just one.
    friends = await addFriend({ webId: TEST_WEBID, friend: BOB, fetchImpl: pod.fetch });
    expect(friends).toEqual([BOB]);

    friends = await addFriend({ webId: TEST_WEBID, friend: CAROL, fetchImpl: pod.fetch });
    expect(friends).toEqual([BOB, CAROL].sort());

    friends = await removeFriend({ webId: TEST_WEBID, friend: BOB, fetchImpl: pod.fetch });
    expect(friends).toEqual([CAROL]);

    // The seeded profile fields survive the mutations.
    const raw = pod.get("https://pod.test/alice/profile/card") ?? "";
    expect(raw).toContain("storage");
    expect(raw).toContain("Alice Test");
  });
});

describe("group build/parse round-trip", () => {
  const url = `${TEST_POD_ROOT}contacts/groups/family.ttl`;

  it("stamps vcard:Group and preserves name + members", () => {
    const group: Group = { name: "Family", members: [BOB, CAROL] };
    const ds = buildGroup(url, group);
    expect([...ds].some((q) => q.object.value === GROUP_CLASS)).toBe(true);
    const parsed = parseGroup(url, ds);
    expect(parsed?.name).toBe("Family");
    expect(parsed?.members).toEqual([BOB, CAROL].sort());
  });

  it("returns undefined for a non-group document", () => {
    const ds = buildGroup(url, { name: "X", members: [] });
    expect(parseGroup(`${TEST_POD_ROOT}contacts/groups/other.ttl`, ds)).toBeUndefined();
  });
});

describe("groupsStore CRUD (I/O)", () => {
  it("creates, lists, updates membership and deletes a group", async () => {
    const pod = createMemoryPod();
    const store = groupsStore({ podRoot: TEST_POD_ROOT, webId: TEST_WEBID, fetchImpl: pod.fetch });

    const { url, etag } = await store.create({ name: "Work", members: [BOB] }, "Work");
    let groups = await store.list();
    expect(groups).toHaveLength(1);
    expect(groups[0].data.members).toEqual([BOB]);

    await store.update(url, { name: "Work", members: [BOB, CAROL] }, etag);
    const reread = await store.read(url);
    expect(reread?.data.members).toEqual([BOB, CAROL].sort());

    await store.remove(url);
    groups = await store.list();
    expect(groups).toHaveLength(0);
  });
});
