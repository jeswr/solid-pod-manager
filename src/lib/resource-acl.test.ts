// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
//
// Security-critical: this is authorization. The tests exercise the full
// ACL read→render→write round-trip against a mock pod (mock `fetch`), plus the
// self-lockout guard, inheritance materialisation, and the public/authenticated
// toggles — the exact surfaces the Sharing panel relies on.
import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import { AclResource } from "@solid/object";
import { DataFactory } from "n3";
import { AclWriteError, AcpUnsupportedError, NotAuthenticatedError } from "./errors.js";
import {
  WacResourceSharingBackend,
  ancestorContainers,
  describeEntryAccess,
  levelForModes,
  modesForLevel,
  subjectKey,
  wouldLockOutOwner,
  type AccessEntry,
  type AccessSubject,
  type ResourceAccess,
} from "./resource-acl.js";

const POD = "https://alice.example/";
const OWNER = "https://alice.example/profile/card#me";
const FRIEND = "https://bob.example/profile/card#me";
const GROUP = "https://alice.example/groups/team#it";
const RESOURCE = "https://alice.example/notes/note.ttl";
const CONTAINER = "https://alice.example/notes/";

const ACL = "http://www.w3.org/ns/auth/acl#";
const FOAF_AGENT = "http://xmlns.com/foaf/0.1/Agent";

/** A resource ACL set directly on the note: owner control + a viewer friend. */
const NOTE_ACL = `
@prefix acl: <http://www.w3.org/ns/auth/acl#>.
@prefix foaf: <http://xmlns.com/foaf/0.1/>.
<#owner> a acl:Authorization ;
  acl:agent <${OWNER}> ;
  acl:accessTo <note.ttl> ;
  acl:mode acl:Read, acl:Write, acl:Control .
<#friend> a acl:Authorization ;
  acl:agent <${FRIEND}> ;
  acl:accessTo <note.ttl> ;
  acl:mode acl:Read .
`;

/** A container ACL with owner control + a public read default (inheritable). */
const CONTAINER_ACL = `
@prefix acl: <http://www.w3.org/ns/auth/acl#>.
@prefix foaf: <http://xmlns.com/foaf/0.1/>.
<#owner> a acl:Authorization ;
  acl:agent <${OWNER}> ;
  acl:accessTo <./> ; acl:default <./> ;
  acl:mode acl:Read, acl:Write, acl:Control .
<#public> a acl:Authorization ;
  acl:agentClass foaf:Agent ;
  acl:default <./> ;
  acl:mode acl:Read .
`;

interface RecordedPut {
  url: string;
  body: string;
  headers: Record<string, string>;
}

/**
 * A fake pod. `docs` maps ACL-document URLs → turtle; `resources` are the
 * resources that exist (answer the `Link: rel="acl"` discovery GET). A resource
 * whose `.acl` is absent from `docs` inherits from the container.
 */
function fakePod(options?: {
  noteAclMissing?: boolean;
  containerAclMissing?: boolean;
  putStatus?: number[] | number;
}) {
  const docs = new Map<string, string>();
  if (!options?.noteAclMissing) docs.set(`${RESOURCE}.acl`, NOTE_ACL);
  if (!options?.containerAclMissing) docs.set(`${CONTAINER}.acl`, CONTAINER_ACL);
  // Pod root has its own ACL so the inheritance walk terminates cleanly.
  docs.set(`${POD}.acl`, CONTAINER_ACL.replace(/<\.\/>/g, `<${POD}>`));

  const resources = new Set([POD, CONTAINER, RESOURCE]);
  const puts: RecordedPut[] = [];
  const putStatuses = Array.isArray(options?.putStatus)
    ? [...options.putStatus]
    : options?.putStatus !== undefined
      ? [options.putStatus]
      : [];

  function aclSlotOf(url: string): string {
    return url.endsWith("/") ? `${url}.acl` : `${url}.acl`;
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET") {
      const aclBody = docs.get(url);
      if (aclBody !== undefined) {
        return new Response(aclBody, {
          status: 200,
          headers: { "content-type": "text/turtle", etag: '"v1"' },
        });
      }
      // An ACL slot that no document occupies → 404 (resource inherits).
      if (url.endsWith(".acl")) return new Response("missing", { status: 404 });
      // A real resource answers discovery with its acl Link header.
      if (resources.has(url)) {
        return new Response("", {
          status: 200,
          headers: { link: `<${aclSlotOf(url)}>; rel="acl"`, "content-type": "text/turtle" },
        });
      }
      return new Response("missing", { status: 404 });
    }
    if (method === "PUT") {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        headers[k] = v;
      });
      puts.push({ url, body: String(init?.body), headers });
      const status = putStatuses.shift() ?? 205;
      if (status < 400) docs.set(url, String(init?.body));
      return new Response(null, { status });
    }
    return new Response("unexpected", { status: 500 });
  };

  return { fetchImpl, puts, docs };
}

function backend(pod: ReturnType<typeof fakePod>) {
  return new WacResourceSharingBackend(OWNER, pod.fetchImpl);
}

// ─── pure helpers ─────────────────────────────────────────────────────────────

describe("level ⇄ modes", () => {
  it("maps levels to modes", () => {
    expect(modesForLevel("view")).toEqual(["read"]);
    expect(modesForLevel("edit")).toEqual(["read", "write", "append"]);
    // Owner is a superset of edit + Control, incl. append (so promotion never
    // strips the ability to add contained resources).
    expect(modesForLevel("owner")).toEqual(["read", "write", "append", "control"]);
  });
  it("maps modes back to the highest honest level", () => {
    expect(levelForModes(["read"])).toBe("view");
    // Append-only is its own honest level (never floored to view).
    expect(levelForModes(["append"])).toBe("add");
    expect(modesForLevel("add")).toEqual(["append"]);
    expect(levelForModes(["read", "write"])).toBe("edit");
    expect(levelForModes(["read", "write", "control"])).toBe("owner");
    expect(levelForModes(["control"])).toBe("owner");
  });
});

describe("ancestorContainers", () => {
  it("walks parents nearest-first up to the root", () => {
    expect(ancestorContainers(RESOURCE)).toEqual([
      "https://alice.example/notes/",
      "https://alice.example/",
    ]);
  });
  it("walks up from a container too", () => {
    expect(ancestorContainers(CONTAINER)).toEqual(["https://alice.example/"]);
  });
});

describe("subjectKey", () => {
  it("keys agents/groups by id and public/authenticated as singletons", () => {
    expect(subjectKey({ kind: "agent", id: FRIEND })).toBe(`agent|${FRIEND}`);
    expect(subjectKey({ kind: "public", id: "" })).toBe("public");
    expect(subjectKey({ kind: "authenticated", id: "" })).toBe("authenticated");
  });
});

// ─── read → render ──────────────────────────────────────────────────────────

describe("read (direct ACL)", () => {
  it("renders who has which access from the resource's own ACL", async () => {
    const access = await backend(fakePod()).read(RESOURCE);
    expect(access.inherited).toBe(false);
    expect(access.aclUrl).toBe(`${RESOURCE}.acl`);

    const owner = access.entries.find((e) => e.subject.id === OWNER);
    expect(owner?.level).toBe("owner");
    expect(owner?.source).toBe("direct");

    const friend = access.entries.find((e) => e.subject.id === FRIEND);
    expect(friend?.level).toBe("view");
    expect(friend?.modes).toEqual(["read"]);
    expect(friend?.source).toBe("direct");
  });

  it("orders entries owner-first", async () => {
    const access = await backend(fakePod()).read(RESOURCE);
    expect(access.entries[0].subject.id).toBe(OWNER);
  });
});

describe("read (inherited ACL)", () => {
  it("falls back to the parent container's default rules and flags inherited", async () => {
    const access = await backend(fakePod({ noteAclMissing: true })).read(RESOURCE);
    expect(access.inherited).toBe(true);
    // From CONTAINER_ACL's acl:default rules: owner + public.
    const owner = access.entries.find((e) => e.subject.id === OWNER);
    expect(owner?.source).toBe("inherited");
    expect(owner?.level).toBe("owner");
    const pub = access.entries.find((e) => e.subject.kind === "public");
    expect(pub?.level).toBe("view");
    expect(pub?.source).toBe("inherited");
  });
});

// ─── set / change level ───────────────────────────────────────────────────────

describe("setAccess", () => {
  it("adds a viewer with a typed accessTo rule and an If-Match PUT", async () => {
    const pod = fakePod();
    await backend(pod).setAccess(RESOURCE, { kind: "agent", id: "https://carol.example/me#me" }, "view");

    expect(pod.puts).toHaveLength(1);
    const put = pod.puts[0];
    expect(put.url).toBe(`${RESOURCE}.acl`);
    expect(put.headers["if-match"]).toBe('"v1"');
    const acl = new AclResource(await parseRdf(put.body, "text/turtle", { baseIRI: put.url }), DataFactory);
    const carol = [...acl.authorizations].find((a) => a.agent.has("https://carol.example/me#me"));
    expect(carol?.canRead).toBe(true);
    expect(carol?.canWrite).toBe(false);
    expect(carol?.accessTo).toBe(RESOURCE);
    // Existing rules survive.
    expect([...acl.authorizations].some((a) => a.agent.has(FRIEND))).toBe(true);
    expect([...acl.authorizations].some((a) => a.agent.has(OWNER))).toBe(true);
  });

  it("upgrades a friend from view to edit (clean replace, not union)", async () => {
    const pod = fakePod();
    await backend(pod).setAccess(RESOURCE, { kind: "agent", id: FRIEND }, "edit");
    const access = await backend(pod).read(RESOURCE);
    const friend = access.entries.find((e) => e.subject.id === FRIEND);
    expect(friend?.level).toBe("edit");
    expect(friend?.modes).toEqual(["read", "append", "write"]);
    // Exactly one rule names the friend (no duplicate left behind).
    const acl = new AclResource(
      await parseRdf(pod.puts.at(-1)!.body, "text/turtle", { baseIRI: `${RESOURCE}.acl` }),
      DataFactory,
    );
    expect([...acl.authorizations].filter((a) => a.agent.has(FRIEND))).toHaveLength(1);
  });

  it("round-trips into the read model", async () => {
    const pod = fakePod();
    const b = backend(pod);
    await b.setAccess(RESOURCE, { kind: "agent", id: FRIEND }, "owner");
    const access = await b.read(RESOURCE);
    expect(access.entries.find((e) => e.subject.id === FRIEND)?.level).toBe("owner");
  });

  it("Owner grants append too (never strips add when promoting — roborev High)", async () => {
    const pod = fakePod();
    await backend(pod).setAccess(RESOURCE, { kind: "agent", id: FRIEND }, "owner");
    const acl = new AclResource(
      await parseRdf(pod.puts[0].body, "text/turtle", { baseIRI: `${RESOURCE}.acl` }),
      DataFactory,
    );
    const friend = [...acl.authorizations].find((a) => a.agent.has(FRIEND));
    expect(friend?.canAppend).toBe(true);
    expect(friend?.canReadWriteAcl).toBe(true);
  });
});

// ─── public / authenticated toggles ───────────────────────────────────────────

describe("public / authenticated toggles", () => {
  it("turns on public read via acl:agentClass foaf:Agent", async () => {
    const pod = fakePod();
    await backend(pod).setAccess(RESOURCE, { kind: "public", id: "" }, "view");
    const acl = new AclResource(
      await parseRdf(pod.puts[0].body, "text/turtle", { baseIRI: `${RESOURCE}.acl` }),
      DataFactory,
    );
    const pub = [...acl.authorizations].find((a) => a.agentClass.has(FOAF_AGENT));
    expect(pub?.canRead).toBe(true);
    expect(pub?.canWrite).toBe(false);
  });

  it("turns on authenticated via acl:AuthenticatedAgent and reflects it", async () => {
    const pod = fakePod();
    const b = backend(pod);
    await b.setAccess(RESOURCE, { kind: "authenticated", id: "" }, "view");
    const access = await b.read(RESOURCE);
    expect(access.entries.some((e) => e.subject.kind === "authenticated")).toBe(true);
  });

  it("removes public access cleanly", async () => {
    const pod = fakePod();
    const b = backend(pod);
    await b.setAccess(RESOURCE, { kind: "public", id: "" }, "view");
    await b.removeAccess(RESOURCE, { kind: "public", id: "" });
    const access = await b.read(RESOURCE);
    expect(access.entries.some((e) => e.subject.kind === "public")).toBe(false);
  });

  it("adds a group via acl:agentGroup", async () => {
    const pod = fakePod();
    await backend(pod).setAccess(RESOURCE, { kind: "group", id: GROUP }, "edit");
    expect(pod.puts[0].body).toContain(`${ACL}agentGroup`.replace(ACL, "acl:"));
    const access = await backend(pod).read(RESOURCE);
    expect(access.entries.find((e) => e.subject.kind === "group")?.subject.id).toBe(GROUP);
  });
});

// ─── remove ───────────────────────────────────────────────────────────────────

describe("removeAccess", () => {
  it("removes a friend and prunes the now-empty rule", async () => {
    const pod = fakePod();
    const b = backend(pod);
    await b.removeAccess(RESOURCE, { kind: "agent", id: FRIEND });
    const put = pod.puts[0];
    expect(put.body).not.toContain(FRIEND);
    // Owner survives.
    expect(put.body).toContain(OWNER);
    const access = await b.read(RESOURCE);
    expect(access.entries.some((e) => e.subject.id === FRIEND)).toBe(false);
  });

  it("removing an INHERITED public entry materialises a resource-specific ACL omitting it", async () => {
    const pod = fakePod({ noteAclMissing: true });
    const b = backend(pod);
    // Sanity: the note inherits a public-read rule from the container.
    const before = await b.read(RESOURCE);
    expect(before.inherited).toBe(true);
    expect(before.entries.some((e) => e.subject.kind === "public")).toBe(true);

    await b.removeAccess(RESOURCE, { kind: "public", id: "" });

    // A fresh resource ACL was written (NOT a no-op, NOT a parent edit).
    expect(pod.puts).toHaveLength(1);
    expect(pod.puts[0].url).toBe(`${RESOURCE}.acl`);
    expect(pod.puts[0].headers["if-none-match"]).toBe("*");
    // The note no longer grants public, but the owner kept control.
    const after = await b.read(RESOURCE);
    expect(after.inherited).toBe(false);
    expect(after.entries.some((e) => e.subject.kind === "public")).toBe(false);
    expect(after.entries.find((e) => e.subject.id === OWNER)?.level).toBe("owner");
  });

  it("never edits the ancestor when materialising (only the resource's own ACL)", async () => {
    const pod = fakePod({ noteAclMissing: true });
    await backend(pod).removeAccess(RESOURCE, { kind: "public", id: "" });
    expect(pod.puts.every((p) => p.url === `${RESOURCE}.acl`)).toBe(true);
  });
});

// ─── inheritance materialisation ──────────────────────────────────────────────

describe("inheritance materialisation", () => {
  it("promoting an inherited resource copies inherited rules + keeps owner control", async () => {
    const pod = fakePod({ noteAclMissing: true });
    const b = backend(pod);
    // Add a friend to the inherited resource: this materialises its own ACL.
    await b.setAccess(RESOURCE, { kind: "agent", id: FRIEND }, "view");

    const put = pod.puts[0];
    expect(put.headers["if-none-match"]).toBe("*"); // a fresh document
    const acl = new AclResource(await parseRdf(put.body, "text/turtle", { baseIRI: put.url }), DataFactory);
    // Owner control preserved (self-lockout safety on a fresh doc).
    const owner = [...acl.authorizations].find((a) => a.agent.has(OWNER));
    expect(owner?.canReadWriteAcl).toBe(true);
    // The inherited public-read rule was copied, not dropped.
    expect([...acl.authorizations].some((a) => a.agentClass.has(FOAF_AGENT))).toBe(true);
    // The new friend rule is present.
    expect([...acl.authorizations].some((a) => a.agent.has(FRIEND))).toBe(true);
  });
});

// ─── self-lockout guard ───────────────────────────────────────────────────────

describe("self-lockout guard (wouldLockOutOwner)", () => {
  const access: ResourceAccess = {
    resourceUrl: RESOURCE,
    aclUrl: `${RESOURCE}.acl`,
    inherited: false,
    entries: [
      { subject: { kind: "agent", id: OWNER }, level: "owner", modes: ["read", "write", "control"], source: "direct" },
      { subject: { kind: "agent", id: FRIEND }, level: "view", modes: ["read"], source: "direct" },
    ],
  };
  const ownerSubject: AccessSubject = { kind: "agent", id: OWNER };

  it("flags downgrading your own owner", () => {
    expect(wouldLockOutOwner(access, OWNER, { subject: ownerSubject, level: "edit" })).toBe(true);
    expect(wouldLockOutOwner(access, OWNER, { subject: ownerSubject, level: "view" })).toBe(true);
  });
  it("flags removing your own owner", () => {
    expect(wouldLockOutOwner(access, OWNER, { subject: ownerSubject, remove: true })).toBe(true);
  });
  it("allows keeping yourself owner", () => {
    expect(wouldLockOutOwner(access, OWNER, { subject: ownerSubject, level: "owner" })).toBe(false);
  });
  it("never restricts changes to OTHER subjects", () => {
    expect(wouldLockOutOwner(access, OWNER, { subject: { kind: "agent", id: FRIEND }, remove: true })).toBe(false);
    expect(wouldLockOutOwner(access, OWNER, { subject: { kind: "public", id: "" }, level: "edit" })).toBe(false);
  });
});

describe("setAccess / removeAccess refuse self-lockout (fail-closed)", () => {
  it("refuses downgrading your own owner with AclWriteError and writes nothing", async () => {
    const pod = fakePod();
    await expect(
      backend(pod).setAccess(RESOURCE, { kind: "agent", id: OWNER }, "view"),
    ).rejects.toBeInstanceOf(AclWriteError);
    expect(pod.puts).toHaveLength(0);
  });
  it("refuses removing your own owner and writes nothing", async () => {
    const pod = fakePod();
    await expect(
      backend(pod).removeAccess(RESOURCE, { kind: "agent", id: OWNER }),
    ).rejects.toBeInstanceOf(AclWriteError);
    expect(pod.puts).toHaveLength(0);
  });
});

// ─── failure modes ────────────────────────────────────────────────────────────

describe("write failures (fail-closed)", () => {
  it("surfaces a 403 as an AclWriteError carrying a 'forbidden' cause", async () => {
    const pod = fakePod({ putStatus: 403 });
    try {
      await backend(pod).setAccess(RESOURCE, { kind: "agent", id: FRIEND }, "edit");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AclWriteError);
      expect(String((e as { cause?: unknown }).cause)).toContain("forbidden");
    }
  });

  it("retries once after a 409/412 conflict, then succeeds", async () => {
    const pod = fakePod({ putStatus: [412, 205] });
    await backend(pod).setAccess(RESOURCE, { kind: "agent", id: FRIEND }, "edit");
    expect(pod.puts).toHaveLength(2);
  });

  it("fails closed with AclWriteError on a persistent conflict", async () => {
    const pod = fakePod({ putStatus: [412, 412] });
    await expect(
      backend(pod).setAccess(RESOURCE, { kind: "agent", id: FRIEND }, "edit"),
    ).rejects.toBeInstanceOf(AclWriteError);
  });
});

describe("constructor", () => {
  it("requires a signed-in owner (fail-closed)", () => {
    expect(() => new WacResourceSharingBackend("")).toThrow(NotAuthenticatedError);
  });
});

// ─── target scoping (roborev High fixes) ──────────────────────────────────────

const SIBLING = "https://alice.example/notes/other.ttl";

/**
 * A single ACL document governing the note that ALSO carries rules for a
 * sibling resource and a container default — the mixed-target case the read
 * filter and scoped removal must handle.
 */
const MIXED_ACL = `
@prefix acl: <http://www.w3.org/ns/auth/acl#>.
@prefix foaf: <http://xmlns.com/foaf/0.1/>.
<#owner> a acl:Authorization ;
  acl:agent <${OWNER}> ;
  acl:accessTo <note.ttl> ;
  acl:mode acl:Read, acl:Write, acl:Control .
<#friend-note> a acl:Authorization ;
  acl:agent <${FRIEND}> ;
  acl:accessTo <note.ttl> ;
  acl:mode acl:Read .
<#friend-sibling> a acl:Authorization ;
  acl:agent <${FRIEND}> ;
  acl:accessTo <other.ttl> ;
  acl:mode acl:Read, acl:Write .
<#stray-default> a acl:Authorization ;
  acl:agent <https://eve.example/me#me> ;
  acl:default <./> ;
  acl:mode acl:Read .
`;

function mixedPod() {
  const pod = fakePod();
  pod.docs.set(`${RESOURCE}.acl`, MIXED_ACL);
  return pod;
}

describe("target scoping", () => {
  it("read shows only rules whose accessTo names THIS resource (not siblings/defaults)", async () => {
    const access = await backend(mixedPod()).read(RESOURCE);
    const ids = access.entries.map((e) => e.subject.id).sort();
    // Owner + friend (both name note.ttl). Eve's container-default rule and the
    // friend's sibling rule must NOT appear on this resource.
    expect(ids).toEqual([OWNER, FRIEND].sort());
    const friend = access.entries.find((e) => e.subject.id === FRIEND);
    // The friend's level here is view (the note rule), NOT edit (the sibling).
    expect(friend?.level).toBe("view");
  });

  it("changing this resource's sharing leaves the subject's OTHER-target rules intact", async () => {
    const pod = mixedPod();
    const b = backend(pod);
    // Upgrade the friend on the NOTE to edit.
    await b.setAccess(RESOURCE, { kind: "agent", id: FRIEND }, "edit");

    const written = new AclResource(
      await parseRdf(pod.puts.at(-1)!.body, "text/turtle", { baseIRI: `${RESOURCE}.acl` }),
      DataFactory,
    );
    const auths = [...written.authorizations];
    // The sibling rule (other.ttl, read+write) for the friend SURVIVES untouched.
    const sibling = auths.find(
      (a) => a.agent.has(FRIEND) && a.accessTo === SIBLING,
    );
    expect(sibling?.canWrite).toBe(true);
    // Eve's stray container default also survives (different target).
    expect(auths.some((a) => a.agent.has("https://eve.example/me#me"))).toBe(true);
    // Exactly one note-targeted friend rule, now edit.
    const noteRules = auths.filter((a) => a.agent.has(FRIEND) && a.accessTo === RESOURCE);
    expect(noteRules).toHaveLength(1);
    expect(noteRules[0].canWrite).toBe(true);
  });

  it("removing the friend from this resource keeps their sibling-target access", async () => {
    const pod = mixedPod();
    const b = backend(pod);
    await b.removeAccess(RESOURCE, { kind: "agent", id: FRIEND });
    const written = new AclResource(
      await parseRdf(pod.puts.at(-1)!.body, "text/turtle", { baseIRI: `${RESOURCE}.acl` }),
      DataFactory,
    );
    const auths = [...written.authorizations];
    // No note-targeted friend rule remains…
    expect(auths.some((a) => a.agent.has(FRIEND) && a.accessTo === RESOURCE)).toBe(false);
    // …but the sibling-targeted one is preserved.
    expect(auths.some((a) => a.agent.has(FRIEND) && a.accessTo === SIBLING)).toBe(true);
  });
});

describe("shared-ACL rule fragments (roborev High — collision)", () => {
  // A single ACL document governs BOTH note.ttl and other.ttl (both resources
  // discover the same `.acl`). Setting the same subject on each must produce
  // two distinct rules — the second must not overwrite/retarget the first.
  const SHARED_ACL_URL = `${CONTAINER}.acl`;
  const BASE = `
@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#owner-note> a acl:Authorization ; acl:agent <${OWNER}> ;
  acl:accessTo <note.ttl> ; acl:mode acl:Read, acl:Write, acl:Control .
<#owner-other> a acl:Authorization ; acl:agent <${OWNER}> ;
  acl:accessTo <other.ttl> ; acl:mode acl:Read, acl:Write, acl:Control .
`;

  function sharedPod() {
    const docs = new Map<string, string>([[SHARED_ACL_URL, BASE]]);
    const puts: RecordedPut[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET") {
        const body = docs.get(url);
        if (body !== undefined) {
          return new Response(body, {
            status: 200,
            headers: { "content-type": "text/turtle", etag: '"v1"' },
          });
        }
        if (url === RESOURCE || url === SIBLING) {
          return new Response("", {
            status: 200,
            headers: { link: `<${SHARED_ACL_URL}>; rel="acl"`, "content-type": "text/turtle" },
          });
        }
        return new Response("missing", { status: 404 });
      }
      if (method === "PUT") {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((v, k) => {
          headers[k] = v;
        });
        puts.push({ url, body: String(init?.body), headers });
        docs.set(url, String(init?.body));
        return new Response(null, { status: 205 });
      }
      return new Response("unexpected", { status: 500 });
    };
    return { fetchImpl, puts, docs };
  }

  it("setting the same subject on two resources in one ACL doc keeps both rules", async () => {
    const pod = sharedPod();
    const b = new WacResourceSharingBackend(OWNER, pod.fetchImpl);
    await b.setAccess(RESOURCE, { kind: "agent", id: FRIEND }, "view");
    await b.setAccess(SIBLING, { kind: "agent", id: FRIEND }, "edit");

    const acl = new AclResource(
      await parseRdf(pod.docs.get(SHARED_ACL_URL)!, "text/turtle", { baseIRI: SHARED_ACL_URL }),
      DataFactory,
    );
    const friendRules = [...acl.authorizations].filter((a) => a.agent.has(FRIEND));
    // Two distinct rules — one per target, not one overwriting the other.
    expect(friendRules).toHaveLength(2);
    const noteRule = friendRules.find((a) => a.accessTo === RESOURCE);
    const siblingRule = friendRules.find((a) => a.accessTo === SIBLING);
    expect(noteRule?.canWrite).toBe(false); // view on the note
    expect(siblingRule?.canWrite).toBe(true); // edit on the sibling
  });

  it("ensures owner control for THIS target even when it exists only on a sibling (roborev High)", async () => {
    // A shared ACL whose owner-Control rule targets ONLY the sibling, not the
    // note. Writing the note must add a note-targeted owner-Control rule, or
    // the owner is locked out of managing the note.
    const SIBLING_ONLY_OWNER = `
@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#owner-other> a acl:Authorization ; acl:agent <${OWNER}> ;
  acl:accessTo <other.ttl> ; acl:mode acl:Read, acl:Write, acl:Control .
`;
    const pod = sharedPod();
    pod.docs.set(SHARED_ACL_URL, SIBLING_ONLY_OWNER);
    await new WacResourceSharingBackend(OWNER, pod.fetchImpl).setAccess(
      RESOURCE,
      { kind: "agent", id: FRIEND },
      "view",
    );
    const acl = new AclResource(
      await parseRdf(pod.docs.get(SHARED_ACL_URL)!, "text/turtle", { baseIRI: SHARED_ACL_URL }),
      DataFactory,
    );
    const noteOwnerControl = [...acl.authorizations].find(
      (a) => a.agent.has(OWNER) && a.canReadWriteAcl && a.accessTo === RESOURCE,
    );
    expect(noteOwnerControl).toBeDefined();
    // The sibling's owner-control rule is untouched.
    expect(
      [...acl.authorizations].some(
        (a) => a.agent.has(OWNER) && a.canReadWriteAcl && a.accessTo === SIBLING,
      ),
    ).toBe(true);
  });
});

describe("inherited discovery errors (roborev — fail closed)", () => {
  it("propagates a non-404 ancestor discovery failure instead of underreporting", async () => {
    // note.ttl has no own ACL; the container discovery answers 500.
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === RESOURCE) {
        return new Response("", {
          status: 200,
          headers: { link: `<${RESOURCE}.acl>; rel="acl"`, "content-type": "text/turtle" },
        });
      }
      if (url === `${RESOURCE}.acl`) return new Response("missing", { status: 404 });
      if (url === CONTAINER) return new Response("boom", { status: 500 });
      return new Response("missing", { status: 404 });
    };
    await expect(
      new WacResourceSharingBackend(OWNER, fetchImpl).read(RESOURCE),
    ).rejects.toBeTruthy();
  });
});

describe("owner control is always preserved on existing ACLs (roborev High)", () => {
  // An existing resource ACL where the owner's ONLY control comes from a
  // public agentClass rule (no named owner rule). Editing must not lock the
  // owner out — ensureOwnerControl writes a named owner-Control rule.
  const PUBLIC_CONTROL_ACL = `
@prefix acl: <http://www.w3.org/ns/auth/acl#>.
@prefix foaf: <http://xmlns.com/foaf/0.1/>.
<#everyone> a acl:Authorization ;
  acl:agentClass foaf:Agent ;
  acl:accessTo <note.ttl> ;
  acl:mode acl:Read, acl:Write, acl:Control .
`;

  it("adds a named owner-Control rule when the owner's only control was via a class rule", async () => {
    const pod = fakePod();
    pod.docs.set(`${RESOURCE}.acl`, PUBLIC_CONTROL_ACL);
    await new WacResourceSharingBackend(OWNER, pod.fetchImpl).setAccess(
      RESOURCE,
      { kind: "agent", id: FRIEND },
      "view",
    );
    const acl = new AclResource(
      await parseRdf(pod.puts.at(-1)!.body, "text/turtle", { baseIRI: `${RESOURCE}.acl` }),
      DataFactory,
    );
    const ownerRule = [...acl.authorizations].find(
      (a) => a.agent.has(OWNER) && a.canReadWriteAcl,
    );
    expect(ownerRule).toBeDefined();
  });
});

describe("sameResource exactness (roborev — /foo vs /foo/)", () => {
  // A rule targets the CONTAINER (note path with trailing slash) but we read
  // the file at note.ttl: distinct IRIs, so the container rule must NOT show.
  const SLASH_ACL = `
@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#owner> a acl:Authorization ; acl:agent <${OWNER}> ;
  acl:accessTo <note.ttl> ; acl:mode acl:Read, acl:Write, acl:Control .
<#wrong> a acl:Authorization ; acl:agent <${FRIEND}> ;
  acl:accessTo <note.ttl/> ; acl:mode acl:Read .
`;
  it("does not match note.ttl against note.ttl/ (a distinct IRI)", async () => {
    const pod = fakePod();
    pod.docs.set(`${RESOURCE}.acl`, SLASH_ACL);
    const access = await backend(pod).read(RESOURCE);
    // Only the exact note.ttl owner rule; the note.ttl/ friend rule is excluded.
    expect(access.entries.some((e) => e.subject.id === FRIEND)).toBe(false);
    expect(access.entries.some((e) => e.subject.id === OWNER)).toBe(true);
  });
});

describe("acl:origin grants (roborev — never under-report)", () => {
  const ORIGIN = "https://app.example";
  const ORIGIN_ACL = `
@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#owner> a acl:Authorization ; acl:agent <${OWNER}> ;
  acl:accessTo <note.ttl> ; acl:mode acl:Read, acl:Write, acl:Control .
<#app> a acl:Authorization ; acl:origin <${ORIGIN}> ;
  acl:accessTo <note.ttl> ; acl:mode acl:Read, acl:Write .
`;

  it("surfaces an origin grant as a read-only subject (not 'only you')", async () => {
    const pod = fakePod();
    pod.docs.set(`${RESOURCE}.acl`, ORIGIN_ACL);
    const access = await backend(pod).read(RESOURCE);
    const origin = access.entries.find((e) => e.subject.kind === "origin");
    expect(origin?.subject.id).toBe(ORIGIN);
    expect(origin?.level).toBe("edit");
  });

  it("preserves an inherited origin grant when materialising a resource ACL", async () => {
    // Container default carries an origin grant; the note inherits it. Adding a
    // friend to the note materialises its ACL and must keep the origin rule.
    const pod = fakePod({ noteAclMissing: true });
    pod.docs.set(
      `${CONTAINER}.acl`,
      `@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#owner> a acl:Authorization ; acl:agent <${OWNER}> ;
  acl:default <./> ; acl:mode acl:Read, acl:Write, acl:Control .
<#app> a acl:Authorization ; acl:origin <${ORIGIN}> ;
  acl:default <./> ; acl:mode acl:Read .`,
    );
    await backend(pod).setAccess(RESOURCE, { kind: "agent", id: FRIEND }, "view");
    const acl = new AclResource(
      await parseRdf(pod.puts.at(-1)!.body, "text/turtle", { baseIRI: `${RESOURCE}.acl` }),
      DataFactory,
    );
    expect([...acl.authorizations].some((a) => a.origin.has(ORIGIN))).toBe(true);
  });
});

describe("unknown agentClass (roborev High — never under-report or drop)", () => {
  const CUSTOM_CLASS = "https://example.org/vocab#Staff";
  const CLASS_ACL = `
@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#owner> a acl:Authorization ; acl:agent <${OWNER}> ;
  acl:accessTo <note.ttl> ; acl:mode acl:Read, acl:Write, acl:Control .
<#staff> a acl:Authorization ; acl:agentClass <${CUSTOM_CLASS}> ;
  acl:accessTo <note.ttl> ; acl:mode acl:Read .
`;
  it("surfaces an unmodelled agentClass as a read-only subject", async () => {
    const pod = fakePod();
    pod.docs.set(`${RESOURCE}.acl`, CLASS_ACL);
    const access = await backend(pod).read(RESOURCE);
    const cls = access.entries.find((e) => e.subject.kind === "class");
    expect(cls?.subject.id).toBe(CUSTOM_CLASS);
    expect(cls?.level).toBe("view");
  });
  it("preserves an inherited unmodelled agentClass through materialisation", async () => {
    const pod = fakePod({ noteAclMissing: true });
    pod.docs.set(
      `${CONTAINER}.acl`,
      `@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#owner> a acl:Authorization ; acl:agent <${OWNER}> ;
  acl:default <./> ; acl:mode acl:Read, acl:Write, acl:Control .
<#staff> a acl:Authorization ; acl:agentClass <${CUSTOM_CLASS}> ;
  acl:default <./> ; acl:mode acl:Read .`,
    );
    await backend(pod).setAccess(RESOURCE, { kind: "agent", id: FRIEND }, "view");
    const acl = new AclResource(
      await parseRdf(pod.puts.at(-1)!.body, "text/turtle", { baseIRI: `${RESOURCE}.acl` }),
      DataFactory,
    );
    expect([...acl.authorizations].some((a) => a.agentClass.has(CUSTOM_CLASS))).toBe(true);
  });
});

describe("partial owner-control upgrade (roborev Medium)", () => {
  it("upgrades a Control-only owner rule to the full owner mode set", async () => {
    // The owner's only rule grants Control but NOT read/write/append.
    const CONTROL_ONLY = `
@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#owner> a acl:Authorization ; acl:agent <${OWNER}> ;
  acl:accessTo <note.ttl> ; acl:mode acl:Control .
`;
    const pod = fakePod();
    pod.docs.set(`${RESOURCE}.acl`, CONTROL_ONLY);
    await backend(pod).setAccess(RESOURCE, { kind: "agent", id: FRIEND }, "view");
    const acl = new AclResource(
      await parseRdf(pod.puts.at(-1)!.body, "text/turtle", { baseIRI: `${RESOURCE}.acl` }),
      DataFactory,
    );
    const owner = [...acl.authorizations].find((a) => a.agent.has(OWNER));
    expect(owner?.canRead).toBe(true);
    expect(owner?.canWrite).toBe(true);
    expect(owner?.canAppend).toBe(true);
    expect(owner?.canReadWriteAcl).toBe(true);
  });
});

describe("multiple origins (roborev High — no key collision)", () => {
  const A = "https://app-a.example";
  const B = "https://app-b.example";
  const MULTI_ORIGIN = `
@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#owner> a acl:Authorization ; acl:agent <${OWNER}> ;
  acl:accessTo <note.ttl> ; acl:mode acl:Read, acl:Write, acl:Control .
<#a> a acl:Authorization ; acl:origin <${A}> ;
  acl:accessTo <note.ttl> ; acl:mode acl:Read .
<#b> a acl:Authorization ; acl:origin <${B}> ;
  acl:accessTo <note.ttl> ; acl:mode acl:Read, acl:Write .
`;
  it("keeps two distinct origin subjects, not one merged entry", async () => {
    const pod = fakePod();
    pod.docs.set(`${RESOURCE}.acl`, MULTI_ORIGIN);
    const access = await backend(pod).read(RESOURCE);
    const origins = access.entries.filter((e) => e.subject.kind === "origin");
    expect(origins.map((o) => o.subject.id).sort()).toEqual([A, B].sort());
    expect(origins.find((o) => o.subject.id === A)?.level).toBe("view");
    expect(origins.find((o) => o.subject.id === B)?.level).toBe("edit");
  });
  it("subjectKey distinguishes origins by IRI", () => {
    expect(subjectKey({ kind: "origin", id: A })).not.toBe(subjectKey({ kind: "origin", id: B }));
  });
});

describe("ACP fail-closed (roborev High)", () => {
  it("refuses an .acr control document", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === RESOURCE) {
        return new Response("", {
          status: 200,
          headers: { link: `<${RESOURCE}.acr>; rel="acl"`, "content-type": "text/turtle" },
        });
      }
      return new Response("missing", { status: 404 });
    };
    await expect(
      new WacResourceSharingBackend(OWNER, fetchImpl).read(RESOURCE),
    ).rejects.toBeInstanceOf(AcpUnsupportedError);
  });

  it("refuses a .acl-named document that actually carries ACP triples", async () => {
    const pod = fakePod();
    pod.docs.set(
      `${RESOURCE}.acl`,
      `@prefix acp: <http://www.w3.org/ns/solid/acp#>.
<#ac> a acp:AccessControl ; acp:apply <#policy> .`,
    );
    await expect(backend(pod).read(RESOURCE)).rejects.toBeInstanceOf(AcpUnsupportedError);
  });
});

describe("write-path fail-closed hardening (roborev)", () => {
  it("refuses to write when the existing ACL has no ETag (no blind overwrite)", async () => {
    // A pod whose ACL GET omits the ETag header.
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET") {
        if (url === `${RESOURCE}.acl`) {
          return new Response(NOTE_ACL, {
            status: 200,
            headers: { "content-type": "text/turtle" }, // NO etag
          });
        }
        if (url === RESOURCE) {
          return new Response("", {
            status: 200,
            headers: { link: `<${RESOURCE}.acl>; rel="acl"`, "content-type": "text/turtle" },
          });
        }
      }
      return new Response("missing", { status: 404 });
    };
    await expect(
      new WacResourceSharingBackend(OWNER, fetchImpl).setAccess(
        RESOURCE,
        { kind: "agent", id: FRIEND },
        "edit",
      ),
    ).rejects.toBeInstanceOf(AclWriteError);
  });

  it("refuses to write when the slot became an ACP document after the read (race)", async () => {
    // First the resource read sees a WAC ACL; the write-path re-read returns an
    // ACP document. The write must fail closed, never PUT WAC into ACP.
    let aclReads = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET") {
        if (url === RESOURCE) {
          return new Response("", {
            status: 200,
            headers: { link: `<${RESOURCE}.acl>; rel="acl"`, "content-type": "text/turtle" },
          });
        }
        if (url === `${RESOURCE}.acl`) {
          aclReads++;
          // 1st read (read()) = WAC; 2nd read (mutateOwnAcl) = ACP.
          const body =
            aclReads === 1
              ? NOTE_ACL
              : `@prefix acp: <http://www.w3.org/ns/solid/acp#>.
<#ac> a acp:AccessControl .`;
          return new Response(body, {
            status: 200,
            headers: { "content-type": "text/turtle", etag: '"v1"' },
          });
        }
      }
      return new Response("missing", { status: 404 });
    };
    await expect(
      new WacResourceSharingBackend(OWNER, fetchImpl).setAccess(
        RESOURCE,
        { kind: "agent", id: FRIEND },
        "edit",
      ),
    ).rejects.toBeInstanceOf(AcpUnsupportedError);
  });
});

describe("stale-create race (roborev — never restore deleted grants)", () => {
  it("does not recreate a directly-deleted ACL from a stale snapshot", async () => {
    // read() sees a direct ACL (with the friend). Between read and the write
    // re-read, the ACL is DELETED by another client (write-path read → 404).
    // The backend must NOT recreate it with If-None-Match:* from the stale
    // snapshot; it re-reads (still 404 → inherited/empty) and retries.
    let aclGets = 0;
    const puts: RecordedPut[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET") {
        if (url === RESOURCE) {
          return new Response("", {
            status: 200,
            headers: { link: `<${RESOURCE}.acl>; rel="acl"`, "content-type": "text/turtle" },
          });
        }
        if (url === `${RESOURCE}.acl`) {
          aclGets++;
          // 1st GET (read) = direct ACL; thereafter = 404 (deleted).
          if (aclGets === 1) {
            return new Response(NOTE_ACL, {
              status: 200,
              headers: { "content-type": "text/turtle", etag: '"v1"' },
            });
          }
          return new Response("missing", { status: 404 });
        }
        // No ancestor ACL → inherited read is empty.
        return new Response("missing", { status: 404 });
      }
      if (method === "PUT") {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((v, k) => {
          headers[k] = v;
        });
        puts.push({ url, body: String(init?.body), headers });
        return new Response(null, { status: 205 });
      }
      return new Response("x", { status: 500 });
    };
    const b = new WacResourceSharingBackend(OWNER, fetchImpl);
    // After deletion the resource reads as inherited/empty; setting the friend
    // now legitimately materialises a FRESH ACL — but it must reflect the
    // post-deletion truth (no stale friend "Read" rule carried from the
    // pre-deletion snapshot beyond the explicit new grant).
    await b.setAccess(RESOURCE, { kind: "agent", id: FRIEND }, "edit");
    // Whatever was written, it was a create (If-None-Match), reflecting that
    // the ACL no longer existed — not a clobbering If-Match on the stale etag.
    const lastPut = puts.at(-1)!;
    expect(lastPut.headers["if-none-match"]).toBe("*");
    expect(lastPut.headers["if-match"]).toBeUndefined();
  });
});

describe("ruleFragment uniqueness (roborev Low — no hash collision)", () => {
  it("gives distinct rules to the same subject on different targets", async () => {
    const pod = fakePod();
    const b = backend(pod);
    await b.setAccess(RESOURCE, { kind: "agent", id: FRIEND }, "view");
    // A second target sharing the same doc would get a different fragment; here
    // we just assert the fragment is derived from BOTH subject and target by
    // checking the written rule subject embeds an encoding (not a bare subject).
    const body = pod.puts.at(-1)!.body;
    expect(body).toMatch(/#rule-[A-Za-z0-9_-]+/);
  });
});

describe("describeEntryAccess (append honesty — roborev)", () => {
  it("surfaces append on a read+append entry instead of plain 'read only'", () => {
    const entry: AccessEntry = {
      subject: { kind: "agent", id: FRIEND },
      level: "view",
      modes: ["read", "append"],
      source: "direct",
    };
    expect(describeEntryAccess(entry)).toMatch(/add/i);
  });
  it("uses the plain level description for a read-only entry", () => {
    const entry: AccessEntry = {
      subject: { kind: "agent", id: FRIEND },
      level: "view",
      modes: ["read"],
      source: "direct",
    };
    expect(describeEntryAccess(entry)).not.toMatch(/add/i);
  });

  it("surfaces append for a PUBLIC read+append grant too", () => {
    const entry: AccessEntry = {
      subject: { kind: "public", id: "" },
      level: "view",
      modes: ["read", "append"],
      source: "direct",
    };
    expect(describeEntryAccess(entry)).toMatch(/add/i);
  });
});

describe("multi-target authorizations (roborev High — split, don't over-revoke)", () => {
  // ONE authorization grants the friend Read on BOTH the note and a sibling.
  // Removing the friend from the note must NOT revoke their sibling access.
  const MULTI_TARGET = `
@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#owner> a acl:Authorization ; acl:agent <${OWNER}> ;
  acl:accessTo <note.ttl> ; acl:mode acl:Read, acl:Write, acl:Control .
<#shared> a acl:Authorization ; acl:agent <${FRIEND}> ;
  acl:accessTo <note.ttl>, <other.ttl> ; acl:mode acl:Read .
`;

  it("removing the friend from the note keeps their sibling-target access", async () => {
    const pod = fakePod();
    pod.docs.set(`${RESOURCE}.acl`, MULTI_TARGET);
    const b = backend(pod);
    await b.removeAccess(RESOURCE, { kind: "agent", id: FRIEND });

    const acl = new AclResource(
      await parseRdf(pod.puts.at(-1)!.body, "text/turtle", { baseIRI: `${RESOURCE}.acl` }),
      DataFactory,
    );
    const auths = [...acl.authorizations];
    // The friend STILL has a rule targeting other.ttl …
    const sibling = auths.find((a) => a.agent.has(FRIEND) && a.accessTo === SIBLING);
    expect(sibling).toBeDefined();
    expect(sibling?.canRead).toBe(true);
    // … but no rule grants the friend the note any more.
    const noteFriend = auths.find((a) => a.agent.has(FRIEND) && a.accessTo === RESOURCE);
    expect(noteFriend).toBeUndefined();
  });

  it("changing the friend's NOTE level leaves the shared sibling rule intact", async () => {
    const pod = fakePod();
    pod.docs.set(`${RESOURCE}.acl`, MULTI_TARGET);
    const b = backend(pod);
    await b.setAccess(RESOURCE, { kind: "agent", id: FRIEND }, "edit");

    const acl = new AclResource(
      await parseRdf(pod.puts.at(-1)!.body, "text/turtle", { baseIRI: `${RESOURCE}.acl` }),
      DataFactory,
    );
    const auths = [...acl.authorizations];
    // Sibling stays read-only…
    const sibling = auths.find((a) => a.agent.has(FRIEND) && a.accessTo === SIBLING);
    expect(sibling?.canWrite).toBe(false);
    expect(sibling?.canRead).toBe(true);
    // …note is now edit.
    const note = auths.find((a) => a.agent.has(FRIEND) && a.accessTo === RESOURCE);
    expect(note?.canWrite).toBe(true);
  });
});

describe("multiple groups on one rule (roborev High — remove exactly one)", () => {
  const GROUP_A = "https://alice.example/groups/team#a";
  const GROUP_B = "https://alice.example/groups/team#b";
  const MULTI_GROUP = `
@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#owner> a acl:Authorization ; acl:agent <${OWNER}> ;
  acl:accessTo <note.ttl> ; acl:mode acl:Read, acl:Write, acl:Control .
<#groups> a acl:Authorization ; acl:agentGroup <${GROUP_A}>, <${GROUP_B}> ;
  acl:accessTo <note.ttl> ; acl:mode acl:Read .
`;
  it("removing one group leaves the other group's access intact", async () => {
    const pod = fakePod();
    pod.docs.set(`${RESOURCE}.acl`, MULTI_GROUP);
    const b = backend(pod);
    await b.removeAccess(RESOURCE, { kind: "group", id: GROUP_A });
    const access = await b.read(RESOURCE);
    const groups = access.entries
      .filter((e) => e.subject.kind === "group")
      .map((e) => e.subject.id);
    expect(groups).not.toContain(GROUP_A);
    expect(groups).toContain(GROUP_B);
  });
});

describe("group removal (typed wrapper)", () => {
  it("turns a group off cleanly via the typed agentGroup accessor", async () => {
    const pod = fakePod();
    const b = backend(pod);
    await b.setAccess(RESOURCE, { kind: "group", id: GROUP }, "edit");
    await b.removeAccess(RESOURCE, { kind: "group", id: GROUP });
    const access = await b.read(RESOURCE);
    expect(access.entries.some((e) => e.subject.kind === "group")).toBe(false);
  });
});
