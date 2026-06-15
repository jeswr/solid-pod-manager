// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect, vi } from "vitest";
import { Parser, Store } from "n3";
import {
  buildAuthorizedSources,
  isAssignedToMe,
  isOwnerWriteOnly,
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

// ─────────────────────────────────────────────────────────────────────────────
// ACL fixtures — the owner-write-only gate reads each surfaced task's effective
// ACL. These helpers let the mock pod web advertise + serve those ACLs.
// ─────────────────────────────────────────────────────────────────────────────
const ACL_NS = "http://www.w3.org/ns/auth/acl#";

/** The conventional `.acl` slot URL for a resource (CSS default convention). */
function aclSlot(resourceUrl: string): string {
  return `${resourceUrl}.acl`;
}

/**
 * A turtle Response that also advertises its access-control slot via
 * `Link: rel="acl"`. The slot is the conventional `<resource>.acl` (WAC) or, for
 * an ACP-backed resource, `<resource>.acr` (which the WAC backend refuses).
 */
function withAclLink(body: string, resourceUrl: string, acp = false): Response {
  const slot = acp ? `${resourceUrl}.acr` : aclSlot(resourceUrl);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/turtle",
      etag: '"v1"',
      link: `<${slot}>; rel="acl"`,
    },
  });
}

/**
 * An OWNER-WRITE-ONLY ACL for `resourceUrl`: `ownerWebId` has full control; the
 * public has READ only (read never makes a resource appendable). isOwnerWriteOnly
 * must return TRUE for this.
 */
function ownerWriteOnlyAcl(resourceUrl: string, ownerWebId: string): string {
  return `
    @prefix acl: <${ACL_NS}> .
    @prefix foaf: <http://xmlns.com/foaf/0.1/> .
    <#owner> a acl:Authorization ;
      acl:accessTo <${resourceUrl}> ;
      acl:agent <${ownerWebId}> ;
      acl:mode acl:Read, acl:Write, acl:Control .
    <#public> a acl:Authorization ;
      acl:accessTo <${resourceUrl}> ;
      acl:agentClass foaf:Agent ;
      acl:mode acl:Read .`;
}

/**
 * A WORLD-APPENDABLE ACL for `resourceUrl` (a public inbox): the public can
 * APPEND. isOwnerWriteOnly must return FALSE — anyone could have written it.
 */
function worldAppendableAcl(resourceUrl: string, ownerWebId: string): string {
  return `
    @prefix acl: <${ACL_NS}> .
    @prefix foaf: <http://xmlns.com/foaf/0.1/> .
    <#owner> a acl:Authorization ;
      acl:accessTo <${resourceUrl}> ;
      acl:agent <${ownerWebId}> ;
      acl:mode acl:Read, acl:Write, acl:Control .
    <#public> a acl:Authorization ;
      acl:accessTo <${resourceUrl}> ;
      acl:agentClass foaf:Agent ;
      acl:mode acl:Read, acl:Append .`;
}

/**
 * A NAMED-ATTACKER-WRITABLE ACL for `resourceUrl`: the pod owner has control, but
 * a SPECIFIC OTHER WebID (`attackerWebId`, NOT a broad class) is granted Write.
 * No public/authenticated/group grant is present, so the OLD broad-only predicate
 * would have wrongly returned TRUE. The owner-WebID-aware predicate must return
 * FALSE — the named non-owner could have planted the bytes (the HIGH spoof).
 */
function namedAttackerWritableAcl(
  resourceUrl: string,
  ownerWebId: string,
  attackerWebId: string,
): string {
  return `
    @prefix acl: <${ACL_NS}> .
    @prefix foaf: <http://xmlns.com/foaf/0.1/> .
    <#owner> a acl:Authorization ;
      acl:accessTo <${resourceUrl}> ;
      acl:agent <${ownerWebId}> ;
      acl:mode acl:Read, acl:Control .
    <#attacker> a acl:Authorization ;
      acl:accessTo <${resourceUrl}> ;
      acl:agent <${attackerWebId}> ;
      acl:mode acl:Read, acl:Write, acl:Append .`;
}

/**
 * A NAMED-ATTACKER-CONTROL-ONLY ACL for `resourceUrl`: the pod owner has control,
 * and a SPECIFIC OTHER WebID (`attackerWebId`) is granted ONLY `acl:Control` — NO
 * explicit Write/Append. The bypass `57361b5` missed: with Control, the attacker
 * can REWRITE this ACL to grant themselves Write/Append, plant/modify the task,
 * and remove the evidence. So the provenance gate must reject this just like a
 * named WRITE grant. isOwnerWriteOnly must return FALSE.
 */
function namedAttackerControlOnlyAcl(
  resourceUrl: string,
  ownerWebId: string,
  attackerWebId: string,
): string {
  return `
    @prefix acl: <${ACL_NS}> .
    @prefix foaf: <http://xmlns.com/foaf/0.1/> .
    <#owner> a acl:Authorization ;
      acl:accessTo <${resourceUrl}> ;
      acl:agent <${ownerWebId}> ;
      acl:mode acl:Read, acl:Write, acl:Control .
    <#attacker> a acl:Authorization ;
      acl:accessTo <${resourceUrl}> ;
      acl:agent <${attackerWebId}> ;
      acl:mode acl:Control .`;
}

/** A turtle ACL Response (with an ETag the read path tolerates). */
function aclRes(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/turtle", etag: '"acl-v1"' },
  });
}

/**
 * The pod-owner WebID for a task URL, by origin convention in these fixtures
 * (`https://bob.example/...` → Bob's WebID, etc.). The owner-write-only ACL
 * grants this agent control.
 */
function ownerOf(url: string): string {
  if (url.startsWith("https://alice.example/")) return ALICE;
  if (url.startsWith("https://bob.example/")) return BOB;
  if (url.startsWith("https://carol.example/")) return CAROL;
  return MALLORY;
}

/** A leaf RDF resource (a task) — gets an ACL link + a default owner-only ACL. */
function isLeafResource(url: string): boolean {
  return url.endsWith(".ttl");
}

type RouteFn = (url: string) => Response | undefined;

/**
 * Wrap a per-test route table so the owner-write-only gate resolves:
 *   - any leaf task resource (.ttl) GET gains a `Link: rel="acl"` header;
 *   - the conventional `<resource>.acl` slot serves an OWNER-WRITE-ONLY ACL,
 *     UNLESS the resource is listed in `appendable` (then a WORLD-APPENDABLE ACL
 *     is served, modelling a public inbox — the broad-grant spoof surface), or is
 *     a key in `namedAttackerWritable` (then a NAMED-ATTACKER-WRITABLE ACL is
 *     served, granting that specific WebID Write — the HIGH named-writer spoof),
 *     or a key in `namedAttackerControlOnly` (then a NAMED-ATTACKER-CONTROL-ONLY
 *     ACL is served, granting that specific WebID ONLY Control — the Control-only
 *     spoof: Control lets them rewrite the ACL to grant themselves Write).
 *   - a resource listed in `acpResources` answers with an ACP `.acr` control
 *     slot, modelling an ACP-backed pod (the MEDIUM finding — must be NON-SILENT).
 * The base route table handles everything else (profiles, indexes, containers).
 */
function wrapWithAcls(
  base: RouteFn,
  appendable: readonly string[] = [],
  opts: {
    namedAttackerWritable?: Readonly<Record<string, string>>;
    namedAttackerControlOnly?: Readonly<Record<string, string>>;
    acpResources?: readonly string[];
  } = {},
): typeof fetch {
  const appendableSet = new Set(appendable);
  const namedAttacker = opts.namedAttackerWritable ?? {};
  const namedAttackerControl = opts.namedAttackerControlOnly ?? {};
  const acpSet = new Set(opts.acpResources ?? []);
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    // ACP control slot for an ACP-backed resource (modelled as `<resource>.acr`).
    if (url.endsWith(".acr")) {
      return aclRes(`
        @prefix acp: <http://www.w3.org/ns/solid/acp#> .
        <#policy> a acp:AccessControlResource .`);
    }
    // ACL slot for a leaf resource: owner-write-only, world-appendable spoof, or
    // named-attacker-writable spoof.
    if (url.endsWith(".acl")) {
      const resource = url.slice(0, -".acl".length);
      if (isLeafResource(resource)) {
        const owner = ownerOf(resource);
        const attacker = namedAttacker[resource];
        if (attacker) return aclRes(namedAttackerWritableAcl(resource, owner, attacker));
        const controlAttacker = namedAttackerControl[resource];
        if (controlAttacker)
          return aclRes(namedAttackerControlOnlyAcl(resource, owner, controlAttacker));
        return aclRes(
          appendableSet.has(resource)
            ? worldAppendableAcl(resource, owner)
            : ownerWriteOnlyAcl(resource, owner),
        );
      }
      // A non-leaf .acl (e.g. a container's) — let the base handle or 404.
      return base(url) ?? new Response("nf", { status: 404 });
    }
    const res = base(url);
    if (!res) return new Response("nf", { status: 404 });
    // Decorate a leaf task resource response with its ACL link so the gate can
    // discover + read its effective access. Containers/indexes are untouched.
    // An ACP-backed resource advertises an `.acr` slot instead (the WAC backend
    // then throws AcpUnsupportedError → the gate's NON-SILENT ACP path).
    if (res.status === 200 && isLeafResource(url)) {
      const body = await res.clone().text();
      return withAclLink(body, url, acpSet.has(url));
    }
    return res;
  }) as unknown as typeof fetch;
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

  it("TRUSTS an own-pod task assigned to me (owner-write-only)", () => {
    const v = verifyAssignedTask({
      url: `${ALICE_ISSUES}t1.ttl`,
      task: baseTask,
      myWebId: ALICE,
      ownStorages: [ALICE_POD],
      source: ALICE,
      sourceStorages: [ALICE_POD],
      authorized,
      ownerWriteOnly: true,
    });
    expect(v).toEqual({ url: `${ALICE_ISSUES}t1.ttl`, task: baseTask, own: true, source: ALICE });
  });

  it("TRUSTS a foreign task in an AUTHORIZED friend's OWN verified storage (owner-write-only)", () => {
    const v = verifyAssignedTask({
      url: `${BOB_ISSUES}t1.ttl`,
      task: baseTask,
      myWebId: ALICE,
      ownStorages: [ALICE_POD],
      source: BOB,
      sourceStorages: [BOB_POD],
      authorized,
      ownerWriteOnly: true,
    });
    expect(v?.own).toBe(false);
    expect(v?.source).toBe(BOB);
  });

  it("REJECTS an own-pod task in a WORLD-/GROUP-appendable container (not owner-write-only)", () => {
    // THE TIER-1 SPOOF: a public inbox INSIDE Alice's own pod holds bytes a
    // stranger posted (`ownerWriteOnly: false`). A self-addressed task there is
    // NOT authentic by location — drop it even though it is in her own storage.
    const v = verifyAssignedTask({
      url: `${ALICE_POD}inbox/spoof.ttl`,
      task: baseTask,
      myWebId: ALICE,
      ownStorages: [ALICE_POD],
      source: ALICE,
      sourceStorages: [ALICE_POD],
      authorized,
      ownerWriteOnly: false,
    });
    expect(v).toBeUndefined();
  });

  it("REJECTS a foreign task in a friend's PUBLIC/group-appendable container (THE SPOOF)", () => {
    // THE TIER-2 SPOOF: Bob (authorized) has a world-/group-appendable container
    // (a public inbox). A stranger planted a `wf:Task` there with assignee=Alice
    // claiming Bob assigned it. The URL IS under Bob's verified storage — only the
    // owner-write-only gate (`ownerWriteOnly: false`) catches it. Must REJECT.
    const v = verifyAssignedTask({
      url: `${BOB_POD}inbox/planted.ttl`,
      task: baseTask,
      myWebId: ALICE,
      ownStorages: [ALICE_POD],
      source: BOB,
      sourceStorages: [BOB_POD], // genuinely under Bob's storage…
      authorized,
      ownerWriteOnly: false, // …but anyone could have written it → reject.
    });
    expect(v).toBeUndefined();
  });

  it("REJECTS a foreign task whose host pod is NOT an authorized source (confused deputy)", () => {
    // Mallory (a stranger) hosts a task claiming it is assigned to Alice. Even
    // if the bytes were owner-write-only, the SOURCE is unauthorized → reject.
    const v = verifyAssignedTask({
      url: "https://mallory.example/issues/evil.ttl",
      task: baseTask,
      myWebId: ALICE,
      ownStorages: [ALICE_POD],
      source: MALLORY,
      sourceStorages: ["https://mallory.example/"],
      authorized,
      ownerWriteOnly: true,
    });
    expect(v).toBeUndefined();
  });

  it("REJECTS a task NAMING an authorized friend but NOT in the friend's verified storage (confused deputy)", () => {
    // Discovered under Bob (authorized) but the task URL is on a THIRD pod — a
    // third party trying to ride Bob's trust. Provenance binding must reject it
    // even when the resource is owner-write-only on that third pod.
    const v = verifyAssignedTask({
      url: "https://evil.example/issues/spoof.ttl",
      task: baseTask,
      myWebId: ALICE,
      ownStorages: [ALICE_POD],
      source: BOB,
      sourceStorages: [BOB_POD], // Bob's real storage does NOT contain evil.example
      authorized,
      ownerWriteOnly: true,
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
      ownerWriteOnly: true,
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
      ownerWriteOnly: true,
    });
    expect(v).toBeUndefined();
  });

  it("REJECTS a non-http(s) scheme resource (file:/data:/javascript:) outright", () => {
    for (const url of [
      "file:///etc/passwd",
      "data:text/turtle,<#it>",
      "javascript:alert(1)",
    ]) {
      const v = verifyAssignedTask({
        url,
        task: baseTask,
        myWebId: ALICE,
        ownStorages: [ALICE_POD],
        source: ALICE,
        sourceStorages: [ALICE_POD],
        authorized,
        ownerWriteOnly: true,
      });
      expect(v).toBeUndefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isOwnerWriteOnly — pure owner-write-only predicate over effective ACL entries.
// ─────────────────────────────────────────────────────────────────────────────
describe("isOwnerWriteOnly", () => {
  const owner = (modes: ("read" | "write" | "append" | "control")[]) =>
    ({ subject: { kind: "agent", id: ALICE } as const, level: "owner" as const, modes, source: "direct" as const });

  it("TRUE when only the owner (the expected owner WebID) has write (no other grants)", () => {
    expect(isOwnerWriteOnly([owner(["read", "write", "control"])], ALICE)).toBe(true);
  });

  it("TRUE when public/group have READ only (read does not make it appendable)", () => {
    expect(
      isOwnerWriteOnly([
        owner(["read", "write", "control"]),
        { subject: { kind: "public", id: "" }, level: "view", modes: ["read"], source: "direct" },
        { subject: { kind: "group", id: "https://g.example/grp#it" }, level: "view", modes: ["read"], source: "inherited" },
      ], ALICE),
    ).toBe(true);
  });

  it("FALSE when public can APPEND (world-appendable inbox)", () => {
    expect(
      isOwnerWriteOnly([
        owner(["read", "write", "control"]),
        { subject: { kind: "public", id: "" }, level: "add", modes: ["append"], source: "direct" },
      ], ALICE),
    ).toBe(false);
  });

  it("FALSE when any-authenticated or a group can WRITE", () => {
    expect(
      isOwnerWriteOnly([
        { subject: { kind: "authenticated", id: "" }, level: "edit", modes: ["read", "write", "append"], source: "direct" },
      ], ALICE),
    ).toBe(false);
    expect(
      isOwnerWriteOnly([
        { subject: { kind: "group", id: "https://g.example/grp#it" }, level: "edit", modes: ["write"], source: "direct" },
      ], ALICE),
    ).toBe(false);
  });

  it("FALSE when a NAMED AGENT OTHER THAN THE OWNER can write/append (the HIGH spoof surface)", () => {
    // The container is owner-write-only against a BROAD subject, but it ALSO
    // grants a third party (Mallory, a specific WebID) Append. Mallory can plant a
    // task there → the claim is spoofable. Reject even though no broad class can
    // write and the bytes are under the source's storage.
    expect(
      isOwnerWriteOnly([
        owner(["read", "write", "control"]),
        { subject: { kind: "agent", id: MALLORY }, level: "add", modes: ["append"], source: "direct" },
      ], ALICE),
    ).toBe(false);
    // And the same for a named-agent WRITE grant.
    expect(
      isOwnerWriteOnly([
        owner(["read", "write", "control"]),
        { subject: { kind: "agent", id: MALLORY }, level: "edit", modes: ["read", "write", "append"], source: "direct" },
      ], ALICE),
    ).toBe(false);
  });

  it("FALSE when a NAMED AGENT OTHER THAN THE OWNER has ONLY Control (no write/append) — the Control-rewrite bypass", () => {
    // The bypass `57361b5` missed: Mallory holds ONLY `acl:Control` (NO explicit
    // Write/Append). In WAC, Control lets her READ AND REWRITE the resource's ACL —
    // so she can grant HERSELF Write/Append, plant/modify the task, and even remove
    // the evidence. A non-owner Control grant is therefore just as spoofable as a
    // write grant and must disqualify the resource even with no current write/append.
    expect(
      isOwnerWriteOnly([
        owner(["read", "write", "control"]),
        { subject: { kind: "agent", id: MALLORY }, level: "owner", modes: ["control"], source: "direct" },
      ], ALICE),
    ).toBe(false);
    // A BROAD subject holding only Control is equally disqualifying.
    expect(
      isOwnerWriteOnly([
        owner(["read", "write", "control"]),
        { subject: { kind: "public", id: "" }, level: "owner", modes: ["control"], source: "direct" },
      ], ALICE),
    ).toBe(false);
    // …but the OWNER holding Control is fine (that is exactly the normal case).
    expect(isOwnerWriteOnly([owner(["read", "control"])], ALICE)).toBe(true);
  });

  it("TRUE when the SAME owner agent matches the expected owner WebID exactly (foreign source case)", () => {
    // For a foreign source, the expected owner is the FRIEND, and the friend's own
    // container grants the friend write — that is fine.
    expect(
      isOwnerWriteOnly(
        [{ subject: { kind: "agent", id: BOB }, level: "owner", modes: ["read", "write", "append", "control"], source: "direct" }],
        BOB,
      ),
    ).toBe(true);
    // …but a write grant to the friend's WebID is NOT owner-write-only when the
    // EXPECTED owner is someone else (e.g. the resource is in Alice's own pod yet
    // Bob holds write — a non-owner could write).
    expect(
      isOwnerWriteOnly(
        [{ subject: { kind: "agent", id: BOB }, level: "edit", modes: ["write"], source: "direct" }],
        ALICE,
      ),
    ).toBe(false);
  });

  it("FALSE (fail-closed) when the access is undetermined (undefined)", () => {
    expect(isOwnerWriteOnly(undefined, ALICE)).toBe(false);
  });

  it("FALSE (fail-closed) when the expected owner WebID is empty/blank", () => {
    expect(isOwnerWriteOnly([owner(["read", "write", "control"])], "")).toBe(false);
    expect(isOwnerWriteOnly([owner(["read", "write", "control"])], "   ")).toBe(false);
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
    const fetchImpl = wrapWithAcls((url: string): Response | undefined => {
      if (url === "https://alice.example/settings/privateTypeIndex.ttl") {
        return ttl(indexTtl({ self: "https://alice.example/settings/privateTypeIndex.ttl", issuesContainer: ALICE_ISSUES }));
      }
      if (url === ALICE_ISSUES) {
        return ttl(containerTtl(ALICE_ISSUES, [`${ALICE_ISSUES}mine.ttl`, `${ALICE_ISSUES}bobs.ttl`]));
      }
      if (url === `${ALICE_ISSUES}mine.ttl`) return ttl(taskTtl(`${ALICE_ISSUES}mine.ttl`, { title: "Mine", assignee: ALICE }));
      if (url === `${ALICE_ISSUES}bobs.ttl`) return ttl(taskTtl(`${ALICE_ISSUES}bobs.ttl`, { title: "Bob's", assignee: BOB }));
      return undefined;
    });

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
    const fetchImpl = wrapWithAcls((url: string): Response | undefined => {
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
      return undefined;
    });

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

  it("REJECTS a task planted in a friend's PUBLIC/group-appendable container (end-to-end spoof)", async () => {
    // THE SPOOF the owner-write-only refinement closes: Bob (authorized) exposes a
    // world-appendable container (a public inbox) registered for wf:Task. A
    // STRANGER posted a task there with assignee=Alice, claiming Bob assigned it.
    // The container IS within Bob's verified storage, so the prior provenance
    // binding (residence-only) would have ACCEPTED it. With owner-write-only the
    // resource's effective ACL grants the public Append → it is dropped.
    const aliceDs = aliceProfileDataset([BOB]);
    const BOB_INBOX = `${BOB_POD}inbox/`;
    const PLANTED = `${BOB_INBOX}planted.ttl`;
    const fetchImpl = wrapWithAcls(
      (url: string): Response | undefined => {
        if (url === "https://alice.example/settings/privateTypeIndex.ttl") {
          return ttl(indexTtl({ self: "https://alice.example/settings/privateTypeIndex.ttl", issuesContainer: ALICE_ISSUES }));
        }
        if (url === ALICE_ISSUES) return ttl(containerTtl(ALICE_ISSUES, []));
        if (url === BOB_DOC) {
          return ttl(profileTtl({ webId: BOB, storage: BOB_POD, privateIndex: "https://bob.example/settings/privateTypeIndex.ttl" }));
        }
        if (url === "https://bob.example/settings/privateTypeIndex.ttl") {
          // Registered container is Bob's PUBLIC inbox — within his storage.
          return ttl(indexTtl({ self: "https://bob.example/settings/privateTypeIndex.ttl", issuesContainer: BOB_INBOX }));
        }
        if (url === BOB_INBOX) return ttl(containerTtl(BOB_INBOX, [PLANTED]));
        if (url === PLANTED) return ttl(taskTtl(PLANTED, { title: "Planted by a stranger", assignee: ALICE }));
        return undefined;
      },
      [PLANTED], // the planted task's ACL is WORLD-APPENDABLE (the spoof).
    );

    const tasks = await discoverAssignedTasks({
      myWebId: ALICE,
      myProfile: readProfile(ALICE, aliceDs),
      myProfileDataset: aliceDs,
      contactWebIds: [],
      fetchImpl,
    });
    // The claim sits under Bob's storage but the bytes are world-writable, so the
    // owner-write-only gate drops it.
    expect(tasks).toEqual([]);
  });

  it("DOES NOT surface a stranger's task even when it claims to be assigned to me (pss-6ae)", async () => {
    // Alice knows no one. Even if the discovery machinery somehow reached
    // Mallory's pod, an unauthorized source is dropped. We model this by simply
    // not authorizing Mallory and confirming a foreign task never appears.
    const aliceDs = aliceProfileDataset([]); // no friends
    const fetchImpl = wrapWithAcls((url: string): Response | undefined => {
      if (url === "https://alice.example/settings/privateTypeIndex.ttl") {
        return ttl(indexTtl({ self: "https://alice.example/settings/privateTypeIndex.ttl", issuesContainer: ALICE_ISSUES }));
      }
      if (url === ALICE_ISSUES) return ttl(containerTtl(ALICE_ISSUES, []));
      // Mallory's pod exists, but Alice never authorized her, so it is never read.
      return undefined;
    });

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
    const fetchImpl = wrapWithAcls((url: string): Response | undefined => {
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
      return undefined;
    });

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
    const fetchImpl = wrapWithAcls((url: string): Response | undefined => {
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
      return undefined;
    });

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
    const fetchImpl = wrapWithAcls((url: string): Response | undefined => {
      if (url === "https://alice.example/settings/privateTypeIndex.ttl") {
        return ttl(indexTtl({ self: "https://alice.example/settings/privateTypeIndex.ttl", issuesContainer: ALICE_ISSUES }));
      }
      if (url === ALICE_ISSUES) return ttl(containerTtl(ALICE_ISSUES, [`${ALICE_ISSUES}own.ttl`]));
      if (url === `${ALICE_ISSUES}own.ttl`) return ttl(taskTtl(`${ALICE_ISSUES}own.ttl`, { title: "Own", assignee: ALICE }));
      // Bob's profile is a 500 — discovery must not throw.
      if (url === BOB_DOC) return new Response("boom", { status: 500 });
      return undefined;
    });

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
    const fetchImpl = wrapWithAcls((url: string): Response | undefined => {
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
      return undefined;
    });

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
    const fetchImpl = wrapWithAcls((url: string): Response | undefined => {
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
      return undefined;
    });

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
    const fetchImpl = wrapWithAcls((url: string): Response | undefined => {
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
      return undefined;
    });

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
    const fetchImpl = wrapWithAcls((url: string): Response | undefined => {
      if (url === "https://alice.example/settings/privateTypeIndex.ttl") return new Response("boom", { status: 500 });
      if (url === BOB_DOC) {
        return ttl(profileTtl({ webId: BOB, storage: BOB_POD, privateIndex: "https://bob.example/settings/privateTypeIndex.ttl" }));
      }
      if (url === "https://bob.example/settings/privateTypeIndex.ttl") {
        return ttl(indexTtl({ self: "https://bob.example/settings/privateTypeIndex.ttl", issuesContainer: BOB_ISSUES }));
      }
      if (url === BOB_ISSUES) return ttl(containerTtl(BOB_ISSUES, [`${BOB_ISSUES}forA.ttl`]));
      if (url === `${BOB_ISSUES}forA.ttl`) return ttl(taskTtl(`${BOB_ISSUES}forA.ttl`, { title: "Bob assigned Alice", assignee: ALICE }));
      return undefined;
    });

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
    const fetchImpl = wrapWithAcls((url: string): Response | undefined => {
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
      return undefined;
    });

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
    const fetchImpl = wrapWithAcls((url: string): Response | undefined => {
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
      return undefined;
    });

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

  it("REJECTS a task in a friend's OWN storage whose ACL grants a NAMED ATTACKER write (the HIGH spoof)", async () => {
    // THE HIGH spoof the owner-WebID refinement closes: Bob (authorized) has a
    // container in HIS OWN verified storage, registered for wf:Task — so the prior
    // gate (residence + broad-grant owner-write-only) would ACCEPT it. But the
    // task resource's effective ACL grants WRITE to a SPECIFIC OTHER WebID
    // (Mallory) — no public/authenticated/group class can write, so the OLD
    // broad-only predicate returned TRUE. Mallory could plant this task and spoof
    // an assignment "from Bob". The owner-WebID-aware predicate (expected owner =
    // Bob) sees a write grant to a non-owner agent → drops it.
    const aliceDs = aliceProfileDataset([BOB]);
    const PLANTED = `${BOB_ISSUES}planted.ttl`;
    const fetchImpl = wrapWithAcls(
      (url: string): Response | undefined => {
        if (url === "https://alice.example/settings/privateTypeIndex.ttl") {
          return ttl(indexTtl({ self: "https://alice.example/settings/privateTypeIndex.ttl", issuesContainer: ALICE_ISSUES }));
        }
        if (url === ALICE_ISSUES) return ttl(containerTtl(ALICE_ISSUES, []));
        if (url === BOB_DOC) {
          return ttl(profileTtl({ webId: BOB, storage: BOB_POD, privateIndex: "https://bob.example/settings/privateTypeIndex.ttl" }));
        }
        if (url === "https://bob.example/settings/privateTypeIndex.ttl") {
          return ttl(indexTtl({ self: "https://bob.example/settings/privateTypeIndex.ttl", issuesContainer: BOB_ISSUES }));
        }
        // The container IS within Bob's verified storage (provenance OK).
        if (url === BOB_ISSUES) return ttl(containerTtl(BOB_ISSUES, [PLANTED]));
        if (url === PLANTED) return ttl(taskTtl(PLANTED, { title: "Planted by Mallory", assignee: ALICE }));
        return undefined;
      },
      [],
      // The planted task's ACL grants MALLORY (a named non-owner) Write.
      { namedAttackerWritable: { [PLANTED]: MALLORY } },
    );

    const tasks = await discoverAssignedTasks({
      myWebId: ALICE,
      myProfile: readProfile(ALICE, aliceDs),
      myProfileDataset: aliceDs,
      contactWebIds: [],
      fetchImpl,
    });
    // Under Bob's storage and broad-write-clean, but a named non-owner can write →
    // owner-write-only is FALSE → dropped.
    expect(tasks).toEqual([]);
  });

  it("REJECTS a task in a friend's OWN storage whose ACL grants a NAMED ATTACKER ONLY Control (the Control-rewrite bypass)", async () => {
    // THE BYPASS `57361b5` missed: Bob (authorized) hosts a wf:Task in HIS OWN
    // verified storage — residence is fine. The task's ACL grants Mallory ONLY
    // `acl:Control` (NO explicit Write/Append). The pre-fix predicate only looked
    // at write/append, so it wrongly returned owner-write-only = TRUE and SURFACED
    // the task. But Control lets Mallory REWRITE this ACL to grant herself Write,
    // plant/modify the task, and remove the evidence — so the assignment is
    // spoofable. The fixed predicate (expected owner = Bob) sees a Control grant to
    // a non-owner agent → owner-write-only FALSE → drops it.
    const aliceDs = aliceProfileDataset([BOB]);
    const PLANTED = `${BOB_ISSUES}control-bypass.ttl`;
    const fetchImpl = wrapWithAcls(
      (url: string): Response | undefined => {
        if (url === "https://alice.example/settings/privateTypeIndex.ttl") {
          return ttl(indexTtl({ self: "https://alice.example/settings/privateTypeIndex.ttl", issuesContainer: ALICE_ISSUES }));
        }
        if (url === ALICE_ISSUES) return ttl(containerTtl(ALICE_ISSUES, []));
        if (url === BOB_DOC) {
          return ttl(profileTtl({ webId: BOB, storage: BOB_POD, privateIndex: "https://bob.example/settings/privateTypeIndex.ttl" }));
        }
        if (url === "https://bob.example/settings/privateTypeIndex.ttl") {
          return ttl(indexTtl({ self: "https://bob.example/settings/privateTypeIndex.ttl", issuesContainer: BOB_ISSUES }));
        }
        // The container IS within Bob's verified storage (provenance OK).
        if (url === BOB_ISSUES) return ttl(containerTtl(BOB_ISSUES, [PLANTED]));
        if (url === PLANTED) return ttl(taskTtl(PLANTED, { title: "Control-bypass by Mallory", assignee: ALICE }));
        return undefined;
      },
      [],
      // The planted task's ACL grants MALLORY (a named non-owner) ONLY Control.
      { namedAttackerControlOnly: { [PLANTED]: MALLORY } },
    );

    const tasks = await discoverAssignedTasks({
      myWebId: ALICE,
      myProfile: readProfile(ALICE, aliceDs),
      myProfileDataset: aliceDs,
      contactWebIds: [],
      fetchImpl,
    });
    // Under Bob's storage with no write/append to a non-owner, but a named
    // non-owner holds Control → can rewrite the ACL → owner-write-only is FALSE →
    // dropped.
    expect(tasks).toEqual([]);
  });

  it("DROPS an ACP-backed pod's task NON-SILENTLY (console.warn, not a silent drop) — the MEDIUM finding", async () => {
    // Bob (authorized) hosts a valid task for Alice in his own storage, but his
    // pod uses ACP (.acr) access control, which the WAC-only gate cannot evaluate.
    // The task must still be dropped (fail closed), but NON-SILENTLY: a warn-level
    // log naming the ACP skip, so valid ACP-pod tasks don't vanish without trace.
    const aliceDs = aliceProfileDataset([BOB]);
    const ACP_TASK = `${BOB_ISSUES}forA.ttl`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const fetchImpl = wrapWithAcls(
        (url: string): Response | undefined => {
          if (url === "https://alice.example/settings/privateTypeIndex.ttl") {
            return ttl(indexTtl({ self: "https://alice.example/settings/privateTypeIndex.ttl", issuesContainer: ALICE_ISSUES }));
          }
          if (url === ALICE_ISSUES) return ttl(containerTtl(ALICE_ISSUES, []));
          if (url === BOB_DOC) {
            return ttl(profileTtl({ webId: BOB, storage: BOB_POD, privateIndex: "https://bob.example/settings/privateTypeIndex.ttl" }));
          }
          if (url === "https://bob.example/settings/privateTypeIndex.ttl") {
            return ttl(indexTtl({ self: "https://bob.example/settings/privateTypeIndex.ttl", issuesContainer: BOB_ISSUES }));
          }
          if (url === BOB_ISSUES) return ttl(containerTtl(BOB_ISSUES, [ACP_TASK]));
          if (url === ACP_TASK) return ttl(taskTtl(ACP_TASK, { title: "Valid but ACP-backed", assignee: ALICE }));
          return undefined;
        },
        [],
        { acpResources: [ACP_TASK] }, // Bob's task advertises an `.acr` slot.
      );

      const tasks = await discoverAssignedTasks({
        myWebId: ALICE,
        myProfile: readProfile(ALICE, aliceDs),
        myProfileDataset: aliceDs,
        contactWebIds: [],
        fetchImpl,
      });
      // Fail closed: ACP can't be evaluated, so the task is dropped…
      expect(tasks).toEqual([]);
      // …but NON-SILENTLY — a warn naming the ACP skip + the resource URL.
      const warned = warn.mock.calls.some(
        (c) => c.some((a) => typeof a === "string" && a.includes("ACP")) && c.includes(ACP_TASK),
      );
      expect(warned).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
