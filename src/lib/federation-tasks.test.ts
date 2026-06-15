// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect, vi } from "vitest";
import { Parser, Store } from "n3";
import {
  buildAuthorizedSources,
  isAssignedToMe,
  verifyAssignedTask,
  discoverAssignedTasks,
  sortAssigned,
  openAssignedCount,
  type AssignedTask,
} from "./federation-tasks.js";
import { readProfile } from "./profile.js";
import type { Issue } from "./issues.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — Alice (the user), Bob (a friend), Carol (a contact), Mallory (a
// hostile stranger whose pod claims a task is assigned to Alice).
// ─────────────────────────────────────────────────────────────────────────────
const ALICE = "https://alice.example/profile/card#me";
const ALICE_POD = "https://alice.example/";
const ALICE_ISSUES = "https://alice.example/issues/";

const BOB = "https://bob.example/profile/card#me";
const BOB_DOC = "https://bob.example/profile/card";
const BOB_POD = "https://bob.example/";
const BOB_ISSUES = "https://bob.example/issues/";

const CAROL = "https://carol.example/profile/card#me";
const CAROL_DOC = "https://carol.example/profile/card";
const CAROL_POD = "https://carol.example/";
const CAROL_ISSUES = "https://carol.example/issues/";

const MALLORY = "https://mallory.example/profile/card#me";

const WF = "http://www.w3.org/2005/01/wf/flow#";

function ttl(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/turtle" } });
}

/** A WebID profile advertising a storage, both type-index links, and friends. */
function profileTtl(opts: {
  webId: string;
  storage: string;
  privateIndex?: string;
  knows?: string[];
}): string {
  const knows = (opts.knows ?? []).map((w) => `<${opts.webId}> foaf:knows <${w}> .`).join("\n");
  return `
    @prefix solid: <http://www.w3.org/ns/solid/terms#> .
    @prefix pim: <http://www.w3.org/ns/pim/space#> .
    @prefix foaf: <http://xmlns.com/foaf/0.1/> .
    <${opts.webId}> a foaf:Person ;
      pim:storage <${opts.storage}> ;
      ${opts.privateIndex ? `solid:privateTypeIndex <${opts.privateIndex}> ;` : ""}
      foaf:name "x" .
    ${knows}`;
}

/** A private type-index registering issues/ for wf:Task. */
function indexTtl(opts: { self: string; issuesContainer: string }): string {
  return `
    @prefix solid: <http://www.w3.org/ns/solid/terms#> .
    @prefix wf: <${WF}> .
    <${opts.self}> a solid:TypeIndex, solid:UnlistedDocument .
    <${opts.self}#reg-tasks> a solid:TypeRegistration ;
      solid:forClass wf:Task ;
      solid:instanceContainer <${opts.issuesContainer}> .`;
}

/**
 * A type-index whose SINGLE wf:Task registration carries BOTH a container and an
 * instance — used to verify the two fields are validated independently.
 */
function indexTtlBoth(opts: { self: string; issuesContainer: string; instance: string }): string {
  return `
    @prefix solid: <http://www.w3.org/ns/solid/terms#> .
    @prefix wf: <${WF}> .
    <${opts.self}> a solid:TypeIndex, solid:UnlistedDocument .
    <${opts.self}#reg-tasks> a solid:TypeRegistration ;
      solid:forClass wf:Task ;
      solid:instanceContainer <${opts.issuesContainer}> ;
      solid:instance <${opts.instance}> .`;
}

/**
 * A type-index with TWO distinct wf:Task registrations (two separate
 * `TypeRegistration` subjects, each its own `instanceContainer`) — used to verify
 * one broken registered LOCATION does not drop the source's other valid one.
 */
function indexTtlTwoContainers(opts: {
  self: string;
  containerA: string;
  containerB: string;
}): string {
  return `
    @prefix solid: <http://www.w3.org/ns/solid/terms#> .
    @prefix wf: <${WF}> .
    <${opts.self}> a solid:TypeIndex, solid:UnlistedDocument .
    <${opts.self}#reg-tasks-a> a solid:TypeRegistration ;
      solid:forClass wf:Task ;
      solid:instanceContainer <${opts.containerA}> .
    <${opts.self}#reg-tasks-b> a solid:TypeRegistration ;
      solid:forClass wf:Task ;
      solid:instanceContainer <${opts.containerB}> .`;
}

/** A container listing (Turtle) advertising member resources. */
function containerTtl(container: string, members: string[]): string {
  const contains = members.length > 0 ? `; ldp:contains ${members.map((m) => `<${m}>`).join(", ")}` : "";
  return `
    @prefix ldp: <http://www.w3.org/ns/ldp#> .
    <${container}> a ldp:Container, ldp:BasicContainer ${contains} .`;
}

/** A single wf:Task resource assigned to `assignee` (or unassigned). */
function taskTtl(url: string, opts: { title: string; assignee?: string; closed?: boolean }): string {
  const stateType = opts.closed ? `${WF}Closed` : `${WF}Open`;
  const assignee = opts.assignee ? `; wf:assignee <${opts.assignee}>` : "";
  return `
    @prefix wf: <${WF}> .
    @prefix dct: <http://purl.org/dc/terms/> .
    <${url}#it> a wf:Task, <${stateType}> ;
      dct:title "${opts.title}" ;
      dct:created "2026-06-10T00:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>
      ${assignee} .`;
}

function parseStore(body: string): Store {
  return new Store(new Parser().parse(body));
}

/** Build the Alice profile dataset for discoverAssignedTasks. */
function aliceProfileDataset(knows: string[]): Store {
  return parseStore(
    profileTtl({
      webId: ALICE,
      storage: ALICE_POD,
      privateIndex: "https://alice.example/settings/privateTypeIndex.ttl",
      knows,
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// buildAuthorizedSources — pure
// ─────────────────────────────────────────────────────────────────────────────
describe("buildAuthorizedSources", () => {
  it("merges friends + contact WebIDs, drops self, dups and non-WebIDs", () => {
    const s = buildAuthorizedSources(
      ALICE,
      [BOB, ALICE, "not a url", "ftp://x/y"],
      [CAROL, BOB, "  "],
    );
    expect(s.self).toBe(ALICE);
    expect(s.others).toEqual([BOB, CAROL].sort());
  });

  it("yields an empty others set with no friends/contacts", () => {
    expect(buildAuthorizedSources(ALICE, [], []).others).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isAssignedToMe — pure assignment match
// ─────────────────────────────────────────────────────────────────────────────
describe("isAssignedToMe", () => {
  it("matches the exact WebID IRI (trimmed)", () => {
    expect(isAssignedToMe(ALICE, ALICE)).toBe(true);
    expect(isAssignedToMe(`  ${ALICE} `, ALICE)).toBe(true);
  });
  it("does not match a different WebID or undefined", () => {
    expect(isAssignedToMe(BOB, ALICE)).toBe(false);
    expect(isAssignedToMe(undefined, ALICE)).toBe(false);
    expect(isAssignedToMe("", ALICE)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyAssignedTask — THE TRUST MODEL (pss-6ae). Pure; the security core.
// ─────────────────────────────────────────────────────────────────────────────
describe("verifyAssignedTask (untrusted-claim verification)", () => {
  const authorized = buildAuthorizedSources(ALICE, [BOB], [CAROL]);
  const baseTask: Issue = { title: "t", state: "open", assignee: ALICE };

  it("TRUSTS an own-pod task assigned to me", () => {
    const v = verifyAssignedTask({
      url: `${ALICE_ISSUES}t1.ttl`,
      task: baseTask,
      myWebId: ALICE,
      ownStorages: [ALICE_POD],
      source: ALICE,
      sourceStorages: [ALICE_POD],
      authorized,
    });
    expect(v).toEqual({ url: `${ALICE_ISSUES}t1.ttl`, task: baseTask, own: true, source: ALICE });
  });

  it("TRUSTS a foreign task in an AUTHORIZED friend's OWN verified storage", () => {
    const v = verifyAssignedTask({
      url: `${BOB_ISSUES}t1.ttl`,
      task: baseTask,
      myWebId: ALICE,
      ownStorages: [ALICE_POD],
      source: BOB,
      sourceStorages: [BOB_POD],
      authorized,
    });
    expect(v?.own).toBe(false);
    expect(v?.source).toBe(BOB);
  });

  it("REJECTS a foreign task whose host pod is NOT an authorized source", () => {
    // Mallory (a stranger) hosts a task claiming it is assigned to Alice.
    const v = verifyAssignedTask({
      url: "https://mallory.example/issues/evil.ttl",
      task: baseTask,
      myWebId: ALICE,
      ownStorages: [ALICE_POD],
      source: MALLORY,
      sourceStorages: ["https://mallory.example/"],
      authorized,
    });
    expect(v).toBeUndefined();
  });

  it("REJECTS a task NAMING an authorized friend but NOT in the friend's verified storage", () => {
    // Discovered under Bob (authorized) but the task URL is on a THIRD pod — a
    // third party trying to ride Bob's trust. Provenance binding must reject it.
    const v = verifyAssignedTask({
      url: "https://evil.example/issues/spoof.ttl",
      task: baseTask,
      myWebId: ALICE,
      ownStorages: [ALICE_POD],
      source: BOB,
      sourceStorages: [BOB_POD], // Bob's real storage does NOT contain evil.example
      authorized,
    });
    expect(v).toBeUndefined();
  });

  it("REJECTS a task that is not actually assigned to me (defensive)", () => {
    const v = verifyAssignedTask({
      url: `${BOB_ISSUES}t1.ttl`,
      task: { title: "t", state: "open", assignee: BOB }, // assigned to Bob, not me
      myWebId: ALICE,
      ownStorages: [ALICE_POD],
      source: BOB,
      sourceStorages: [BOB_POD],
      authorized,
    });
    expect(v).toBeUndefined();
  });

  it("REJECTS a foreign task that self-claims via the user's own WebID but lives off-pod", () => {
    // A foreign pod registered under Alice's *own* WebID (spoofed) pointing at a
    // non-own pod must fail closed — self only ever trusts own-pod resources.
    const v = verifyAssignedTask({
      url: "https://evil.example/issues/x.ttl",
      task: baseTask,
      myWebId: ALICE,
      ownStorages: [ALICE_POD],
      source: ALICE,
      sourceStorages: [ALICE_POD],
      authorized,
    });
    expect(v).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sortAssigned / openAssignedCount — pure
// ─────────────────────────────────────────────────────────────────────────────
describe("sortAssigned", () => {
  it("orders open-before-closed, own-before-foreign, newest-first", () => {
    const mk = (
      url: string,
      state: Issue["state"],
      own: boolean,
      created: string,
    ): AssignedTask => ({
      url,
      task: { title: url, state, assignee: ALICE, created: new Date(created) },
      own,
      source: own ? ALICE : BOB,
    });
    const sorted = sortAssigned([
      mk("c", "closed", true, "2026-06-10T00:00:00Z"),
      mk("a", "open", false, "2026-06-01T00:00:00Z"),
      mk("b", "open", true, "2026-06-05T00:00:00Z"),
    ]);
    // open (own first), then closed.
    expect(sorted.map((t) => t.url)).toEqual(["b", "a", "c"]);
  });
});

describe("openAssignedCount", () => {
  it("counts non-closed tasks", () => {
    const t = (state: Issue["state"]): AssignedTask => ({
      url: state,
      task: { title: state, state, assignee: ALICE },
      own: true,
      source: ALICE,
    });
    expect(openAssignedCount([t("open"), t("in-progress"), t("closed")])).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// discoverAssignedTasks — end-to-end discovery + provenance over a mock pod web.
// ─────────────────────────────────────────────────────────────────────────────
describe("discoverAssignedTasks", () => {
  it("surfaces own-pod tasks assigned to me and skips ones assigned to others", async () => {
    const aliceDs = aliceProfileDataset([]);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://alice.example/settings/privateTypeIndex.ttl") {
        return ttl(indexTtl({ self: "https://alice.example/settings/privateTypeIndex.ttl", issuesContainer: ALICE_ISSUES }));
      }
      if (url === ALICE_ISSUES) {
        return ttl(containerTtl(ALICE_ISSUES, [`${ALICE_ISSUES}mine.ttl`, `${ALICE_ISSUES}bobs.ttl`]));
      }
      if (url === `${ALICE_ISSUES}mine.ttl`) return ttl(taskTtl(`${ALICE_ISSUES}mine.ttl`, { title: "Mine", assignee: ALICE }));
      if (url === `${ALICE_ISSUES}bobs.ttl`) return ttl(taskTtl(`${ALICE_ISSUES}bobs.ttl`, { title: "Bob's", assignee: BOB }));
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const tasks = await discoverAssignedTasks({
      myWebId: ALICE,
      myProfile: readProfile(ALICE, aliceDs),
      myProfileDataset: aliceDs,
      contactWebIds: [],
      fetchImpl,
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].url).toBe(`${ALICE_ISSUES}mine.ttl`);
    expect(tasks[0].own).toBe(true);
    expect(tasks[0].task.title).toBe("Mine");
  });

  it("surfaces a friend's task in the friend's verified storage (federation consume)", async () => {
    const aliceDs = aliceProfileDataset([BOB]); // Alice foaf:knows Bob
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // Alice's index (no own tasks) — empty issues container.
      if (url === "https://alice.example/settings/privateTypeIndex.ttl") {
        return ttl(indexTtl({ self: "https://alice.example/settings/privateTypeIndex.ttl", issuesContainer: ALICE_ISSUES }));
      }
      if (url === ALICE_ISSUES) return ttl(containerTtl(ALICE_ISSUES, []));
      // Bob's profile + index + tasks.
      if (url === BOB_DOC) {
        return ttl(profileTtl({ webId: BOB, storage: BOB_POD, privateIndex: "https://bob.example/settings/privateTypeIndex.ttl" }));
      }
      if (url === "https://bob.example/settings/privateTypeIndex.ttl") {
        return ttl(indexTtl({ self: "https://bob.example/settings/privateTypeIndex.ttl", issuesContainer: BOB_ISSUES }));
      }
      if (url === BOB_ISSUES) return ttl(containerTtl(BOB_ISSUES, [`${BOB_ISSUES}forA.ttl`]));
      if (url === `${BOB_ISSUES}forA.ttl`) return ttl(taskTtl(`${BOB_ISSUES}forA.ttl`, { title: "Bob assigned Alice", assignee: ALICE }));
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const tasks = await discoverAssignedTasks({
      myWebId: ALICE,
      myProfile: readProfile(ALICE, aliceDs),
      myProfileDataset: aliceDs,
      contactWebIds: [],
      fetchImpl,
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].url).toBe(`${BOB_ISSUES}forA.ttl`);
    expect(tasks[0].own).toBe(false);
    expect(tasks[0].source).toBe(BOB);
  });

  it("DOES NOT surface a stranger's task even when it claims to be assigned to me (pss-6ae)", async () => {
    // Alice knows no one. Even if the discovery machinery somehow reached
    // Mallory's pod, an unauthorized source is dropped. We model this by simply
    // not authorizing Mallory and confirming a foreign task never appears.
    const aliceDs = aliceProfileDataset([]); // no friends
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://alice.example/settings/privateTypeIndex.ttl") {
        return ttl(indexTtl({ self: "https://alice.example/settings/privateTypeIndex.ttl", issuesContainer: ALICE_ISSUES }));
      }
      if (url === ALICE_ISSUES) return ttl(containerTtl(ALICE_ISSUES, []));
      // Mallory's pod exists, but Alice never authorized her, so it is never read.
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const tasks = await discoverAssignedTasks({
      myWebId: ALICE,
      myProfile: readProfile(ALICE, aliceDs),
      myProfileDataset: aliceDs,
      contactWebIds: [],
      fetchImpl,
    });
    expect(tasks).toEqual([]);
    // Mallory's pod must never have been fetched at all.
    const fetched = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(fetched.some((u) => u.includes("mallory.example"))).toBe(false);
  });

  it("DROPS a friend's registration that points OUTSIDE the friend's own storage", async () => {
    // Bob (authorized) has a crafted type-index registration whose container is
    // on a THIRD pod (evil.example). It must be dropped before any read.
    const aliceDs = aliceProfileDataset([BOB]);
    const EVIL_CONTAINER = "https://evil.example/issues/";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://alice.example/settings/privateTypeIndex.ttl") {
        return ttl(indexTtl({ self: "https://alice.example/settings/privateTypeIndex.ttl", issuesContainer: ALICE_ISSUES }));
      }
      if (url === ALICE_ISSUES) return ttl(containerTtl(ALICE_ISSUES, []));
      if (url === BOB_DOC) {
        return ttl(profileTtl({ webId: BOB, storage: BOB_POD, privateIndex: "https://bob.example/settings/privateTypeIndex.ttl" }));
      }
      if (url === "https://bob.example/settings/privateTypeIndex.ttl") {
        // Registration points at evil.example, NOT Bob's own storage.
        return ttl(indexTtl({ self: "https://bob.example/settings/privateTypeIndex.ttl", issuesContainer: EVIL_CONTAINER }));
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const tasks = await discoverAssignedTasks({
      myWebId: ALICE,
      myProfile: readProfile(ALICE, aliceDs),
      myProfileDataset: aliceDs,
      contactWebIds: [],
      fetchImpl,
    });
    expect(tasks).toEqual([]);
    // The off-storage container must never have been listed.
    const fetched = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(fetched.some((u) => u.startsWith(EVIL_CONTAINER))).toBe(false);
  });

  it("includes a contact source and merges own + foreign, de-duplicated", async () => {
    const aliceDs = aliceProfileDataset([]); // Carol is a CONTACT, not a foaf:knows friend
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://alice.example/settings/privateTypeIndex.ttl") {
        return ttl(indexTtl({ self: "https://alice.example/settings/privateTypeIndex.ttl", issuesContainer: ALICE_ISSUES }));
      }
      if (url === ALICE_ISSUES) return ttl(containerTtl(ALICE_ISSUES, [`${ALICE_ISSUES}own.ttl`]));
      if (url === `${ALICE_ISSUES}own.ttl`) return ttl(taskTtl(`${ALICE_ISSUES}own.ttl`, { title: "Own", assignee: ALICE }));
      if (url === CAROL_DOC) {
        return ttl(profileTtl({ webId: CAROL, storage: CAROL_POD, privateIndex: "https://carol.example/settings/privateTypeIndex.ttl" }));
      }
      if (url === "https://carol.example/settings/privateTypeIndex.ttl") {
        return ttl(indexTtl({ self: "https://carol.example/settings/privateTypeIndex.ttl", issuesContainer: CAROL_ISSUES }));
      }
      if (url === CAROL_ISSUES) return ttl(containerTtl(CAROL_ISSUES, [`${CAROL_ISSUES}c.ttl`]));
      if (url === `${CAROL_ISSUES}c.ttl`) return ttl(taskTtl(`${CAROL_ISSUES}c.ttl`, { title: "From Carol", assignee: ALICE }));
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const tasks = await discoverAssignedTasks({
      myWebId: ALICE,
      myProfile: readProfile(ALICE, aliceDs),
      myProfileDataset: aliceDs,
      contactWebIds: [CAROL],
      fetchImpl,
    });
    expect(tasks.map((t) => t.url).sort()).toEqual(
      [`${ALICE_ISSUES}own.ttl`, `${CAROL_ISSUES}c.ttl`].sort(),
    );
    expect(tasks.find((t) => t.source === CAROL)?.own).toBe(false);
  });

  it("survives an unreadable friend profile (skips that source, keeps own tasks)", async () => {
    const aliceDs = aliceProfileDataset([BOB]);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://alice.example/settings/privateTypeIndex.ttl") {
        return ttl(indexTtl({ self: "https://alice.example/settings/privateTypeIndex.ttl", issuesContainer: ALICE_ISSUES }));
      }
      if (url === ALICE_ISSUES) return ttl(containerTtl(ALICE_ISSUES, [`${ALICE_ISSUES}own.ttl`]));
      if (url === `${ALICE_ISSUES}own.ttl`) return ttl(taskTtl(`${ALICE_ISSUES}own.ttl`, { title: "Own", assignee: ALICE }));
      // Bob's profile is a 500 — discovery must not throw.
      if (url === BOB_DOC) return new Response("boom", { status: 500 });
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const tasks = await discoverAssignedTasks({
      myWebId: ALICE,
      myProfile: readProfile(ALICE, aliceDs),
      myProfileDataset: aliceDs,
      contactWebIds: [],
      fetchImpl,
    });
    expect(tasks.map((t) => t.url)).toEqual([`${ALICE_ISSUES}own.ttl`]);
  });

  it("survives a friend whose TYPE-INDEX errors (500): skips that friend, keeps own + other friends", async () => {
    // Alice knows Bob (broken index) AND Carol (a contact, healthy). A single bad
    // source must NOT sink the aggregate (the MEDIUM finding): own-pod tasks AND
    // the other readable source must still render.
    const aliceDs = aliceProfileDataset([BOB]); // Bob is a friend; Carol below is a contact
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // Alice's own pod: one task assigned to her.
      if (url === "https://alice.example/settings/privateTypeIndex.ttl") {
        return ttl(indexTtl({ self: "https://alice.example/settings/privateTypeIndex.ttl", issuesContainer: ALICE_ISSUES }));
      }
      if (url === ALICE_ISSUES) return ttl(containerTtl(ALICE_ISSUES, [`${ALICE_ISSUES}own.ttl`]));
      if (url === `${ALICE_ISSUES}own.ttl`) return ttl(taskTtl(`${ALICE_ISSUES}own.ttl`, { title: "Own", assignee: ALICE }));
      // Bob's profile reads fine, but his type-index 500s — discovery must not throw.
      if (url === BOB_DOC) {
        return ttl(profileTtl({ webId: BOB, storage: BOB_POD, privateIndex: "https://bob.example/settings/privateTypeIndex.ttl" }));
      }
      if (url === "https://bob.example/settings/privateTypeIndex.ttl") return new Response("boom", { status: 500 });
      // Carol (contact) is healthy and has a task for Alice.
      if (url === CAROL_DOC) {
        return ttl(profileTtl({ webId: CAROL, storage: CAROL_POD, privateIndex: "https://carol.example/settings/privateTypeIndex.ttl" }));
      }
      if (url === "https://carol.example/settings/privateTypeIndex.ttl") {
        return ttl(indexTtl({ self: "https://carol.example/settings/privateTypeIndex.ttl", issuesContainer: CAROL_ISSUES }));
      }
      if (url === CAROL_ISSUES) return ttl(containerTtl(CAROL_ISSUES, [`${CAROL_ISSUES}c.ttl`]));
      if (url === `${CAROL_ISSUES}c.ttl`) return ttl(taskTtl(`${CAROL_ISSUES}c.ttl`, { title: "From Carol", assignee: ALICE }));
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const tasks = await discoverAssignedTasks({
      myWebId: ALICE,
      myProfile: readProfile(ALICE, aliceDs),
      myProfileDataset: aliceDs,
      contactWebIds: [CAROL],
      fetchImpl,
    });
    // Own task + Carol's task survive; Bob (broken index) is silently skipped.
    expect(tasks.map((t) => t.url).sort()).toEqual(
      [`${ALICE_ISSUES}own.ttl`, `${CAROL_ISSUES}c.ttl`].sort(),
    );
  });

  it("survives a friend whose TASK CONTAINER errors (500): skips that friend, keeps own tasks", async () => {
    // Bob's profile + index read fine, but his registered task container 500s
    // (404/403 are swallowed deeper; a 500 exercises the throw path that the
    // per-source guard must catch). readSourceTasks must not sink Alice's own tasks.
    const aliceDs = aliceProfileDataset([BOB]);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://alice.example/settings/privateTypeIndex.ttl") {
        return ttl(indexTtl({ self: "https://alice.example/settings/privateTypeIndex.ttl", issuesContainer: ALICE_ISSUES }));
      }
      if (url === ALICE_ISSUES) return ttl(containerTtl(ALICE_ISSUES, [`${ALICE_ISSUES}own.ttl`]));
      if (url === `${ALICE_ISSUES}own.ttl`) return ttl(taskTtl(`${ALICE_ISSUES}own.ttl`, { title: "Own", assignee: ALICE }));
      if (url === BOB_DOC) {
        return ttl(profileTtl({ webId: BOB, storage: BOB_POD, privateIndex: "https://bob.example/settings/privateTypeIndex.ttl" }));
      }
      if (url === "https://bob.example/settings/privateTypeIndex.ttl") {
        return ttl(indexTtl({ self: "https://bob.example/settings/privateTypeIndex.ttl", issuesContainer: BOB_ISSUES }));
      }
      // Bob's task container errors with a 500 — readAssignedFromContainer
      // re-throws it; the per-source guard must catch + skip fail-closed.
      if (url === BOB_ISSUES) return new Response("server error", { status: 500 });
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const tasks = await discoverAssignedTasks({
      myWebId: ALICE,
      myProfile: readProfile(ALICE, aliceDs),
      myProfileDataset: aliceDs,
      contactWebIds: [],
      fetchImpl,
    });
    expect(tasks.map((t) => t.url)).toEqual([`${ALICE_ISSUES}own.ttl`]);
  });

  it("isolates a broken registered LOCATION: a 500 container does not drop the source's OTHER healthy container (per-location isolation)", async () => {
    // ONE source (Bob, a friend) registers TWO wf:Task containers: containerA
    // 500s on listing, containerB is healthy with a task for Alice. The MEDIUM
    // finding: the prior fix isolated PER-SOURCE but not PER-LOCATION — a single
    // bad container under Promise.all rejected the whole source read and the
    // per-source catch then skipped ALL of Bob's locations, hiding the valid
    // task in his healthy container. With per-location isolation the broken
    // container is skipped and the healthy one's task still surfaces.
    const aliceDs = aliceProfileDataset([BOB]);
    const BOB_BROKEN = `${BOB_POD}broken/`;
    const BOB_HEALTHY = `${BOB_POD}healthy/`;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://alice.example/settings/privateTypeIndex.ttl") {
        return ttl(indexTtl({ self: "https://alice.example/settings/privateTypeIndex.ttl", issuesContainer: ALICE_ISSUES }));
      }
      if (url === ALICE_ISSUES) return ttl(containerTtl(ALICE_ISSUES, [])); // Alice has no own tasks
      if (url === BOB_DOC) {
        return ttl(profileTtl({ webId: BOB, storage: BOB_POD, privateIndex: "https://bob.example/settings/privateTypeIndex.ttl" }));
      }
      if (url === "https://bob.example/settings/privateTypeIndex.ttl") {
        // BOTH containers are within Bob's own storage (provenance OK); one is broken.
        return ttl(indexTtlTwoContainers({
          self: "https://bob.example/settings/privateTypeIndex.ttl",
          containerA: BOB_BROKEN,
          containerB: BOB_HEALTHY,
        }));
      }
      // Broken container: 500 on listing → readAssignedFromContainer re-throws.
      if (url === BOB_BROKEN) return new Response("server error", { status: 500 });
      // Healthy container: a task assigned to Alice, in Bob's verified storage.
      if (url === BOB_HEALTHY) return ttl(containerTtl(BOB_HEALTHY, [`${BOB_HEALTHY}forA.ttl`]));
      if (url === `${BOB_HEALTHY}forA.ttl`) return ttl(taskTtl(`${BOB_HEALTHY}forA.ttl`, { title: "Healthy from Bob", assignee: ALICE }));
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const tasks = await discoverAssignedTasks({
      myWebId: ALICE,
      myProfile: readProfile(ALICE, aliceDs),
      myProfileDataset: aliceDs,
      contactWebIds: [],
      fetchImpl,
    });
    // The broken location is skipped; the healthy location's task still appears.
    expect(tasks.map((t) => t.url)).toEqual([`${BOB_HEALTHY}forA.ttl`]);
    expect(tasks[0].source).toBe(BOB);
    expect(tasks[0].own).toBe(false);
    // The broken container WAS attempted (it is in-storage, so it is read) but did
    // not poison the sibling.
    const fetched = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(fetched).toContain(BOB_BROKEN);
    expect(fetched).toContain(BOB_HEALTHY);
  });

  it("survives a broken OWN type-index without sinking readable friend tasks", async () => {
    // Alice's own private type-index 500s, but she has a healthy friend Bob with a
    // task for her. The own-pod read is wrapped fail-closed; Bob's must still show.
    const aliceDs = aliceProfileDataset([BOB]);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://alice.example/settings/privateTypeIndex.ttl") return new Response("boom", { status: 500 });
      if (url === BOB_DOC) {
        return ttl(profileTtl({ webId: BOB, storage: BOB_POD, privateIndex: "https://bob.example/settings/privateTypeIndex.ttl" }));
      }
      if (url === "https://bob.example/settings/privateTypeIndex.ttl") {
        return ttl(indexTtl({ self: "https://bob.example/settings/privateTypeIndex.ttl", issuesContainer: BOB_ISSUES }));
      }
      if (url === BOB_ISSUES) return ttl(containerTtl(BOB_ISSUES, [`${BOB_ISSUES}forA.ttl`]));
      if (url === `${BOB_ISSUES}forA.ttl`) return ttl(taskTtl(`${BOB_ISSUES}forA.ttl`, { title: "Bob assigned Alice", assignee: ALICE }));
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const tasks = await discoverAssignedTasks({
      myWebId: ALICE,
      myProfile: readProfile(ALICE, aliceDs),
      myProfileDataset: aliceDs,
      contactWebIds: [],
      fetchImpl,
    });
    expect(tasks.map((t) => t.url)).toEqual([`${BOB_ISSUES}forA.ttl`]);
  });

  it("treats a registration's container and instance INDEPENDENTLY (off-storage instance does not drop a valid container)", async () => {
    // Bob's single wf:Task registration carries BOTH a valid container (in his
    // pod) AND an instance that points OFF his storage (evil.example). The LOW
    // finding: the bad instance must NOT discard the tasks read from the valid
    // container. The off-storage instance is skipped; the container task survives.
    const aliceDs = aliceProfileDataset([BOB]);
    const EVIL_INSTANCE = "https://evil.example/tasks/spoof.ttl";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://alice.example/settings/privateTypeIndex.ttl") {
        return ttl(indexTtl({ self: "https://alice.example/settings/privateTypeIndex.ttl", issuesContainer: ALICE_ISSUES }));
      }
      if (url === ALICE_ISSUES) return ttl(containerTtl(ALICE_ISSUES, []));
      if (url === BOB_DOC) {
        return ttl(profileTtl({ webId: BOB, storage: BOB_POD, privateIndex: "https://bob.example/settings/privateTypeIndex.ttl" }));
      }
      if (url === "https://bob.example/settings/privateTypeIndex.ttl") {
        return ttl(
          indexTtlBoth({
            self: "https://bob.example/settings/privateTypeIndex.ttl",
            issuesContainer: BOB_ISSUES, // valid — within Bob's storage
            instance: EVIL_INSTANCE, // off-storage — must be skipped, not poison the container
          }),
        );
      }
      if (url === BOB_ISSUES) return ttl(containerTtl(BOB_ISSUES, [`${BOB_ISSUES}forA.ttl`]));
      if (url === `${BOB_ISSUES}forA.ttl`) return ttl(taskTtl(`${BOB_ISSUES}forA.ttl`, { title: "Valid from Bob", assignee: ALICE }));
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const tasks = await discoverAssignedTasks({
      myWebId: ALICE,
      myProfile: readProfile(ALICE, aliceDs),
      myProfileDataset: aliceDs,
      contactWebIds: [],
      fetchImpl,
    });
    // The valid container task survives despite the off-storage sibling instance.
    expect(tasks.map((t) => t.url)).toEqual([`${BOB_ISSUES}forA.ttl`]);
    // The off-storage instance must NEVER have been fetched.
    const fetched = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(fetched.some((u) => u.startsWith("https://evil.example/"))).toBe(false);
  });

  it("treats container and instance INDEPENDENTLY (off-storage container does not drop a valid instance)", async () => {
    // Mirror of the above: a bad container must not discard a VALID sibling
    // instance in the same registration.
    const aliceDs = aliceProfileDataset([BOB]);
    const EVIL_CONTAINER = "https://evil.example/issues/";
    const VALID_INSTANCE = `${BOB_POD}tasks/forA.ttl`;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://alice.example/settings/privateTypeIndex.ttl") {
        return ttl(indexTtl({ self: "https://alice.example/settings/privateTypeIndex.ttl", issuesContainer: ALICE_ISSUES }));
      }
      if (url === ALICE_ISSUES) return ttl(containerTtl(ALICE_ISSUES, []));
      if (url === BOB_DOC) {
        return ttl(profileTtl({ webId: BOB, storage: BOB_POD, privateIndex: "https://bob.example/settings/privateTypeIndex.ttl" }));
      }
      if (url === "https://bob.example/settings/privateTypeIndex.ttl") {
        return ttl(
          indexTtlBoth({
            self: "https://bob.example/settings/privateTypeIndex.ttl",
            issuesContainer: EVIL_CONTAINER, // off-storage — must be skipped
            instance: VALID_INSTANCE, // valid — within Bob's storage, must survive
          }),
        );
      }
      if (url === VALID_INSTANCE) return ttl(taskTtl(VALID_INSTANCE, { title: "Valid instance from Bob", assignee: ALICE }));
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const tasks = await discoverAssignedTasks({
      myWebId: ALICE,
      myProfile: readProfile(ALICE, aliceDs),
      myProfileDataset: aliceDs,
      contactWebIds: [],
      fetchImpl,
    });
    expect(tasks.map((t) => t.url)).toEqual([VALID_INSTANCE]);
    const fetched = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(fetched.some((u) => u.startsWith(EVIL_CONTAINER))).toBe(false);
  });
});
