// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect, vi } from "vitest";
import { Parser, Store } from "n3";
import type { DatasetCore } from "@rdfjs/types";
import { assignTask } from "./assign-task.js";
import { AssignError } from "./errors.js";
import { ISSUE_CLASS } from "./issues.js";

const ACL = "http://www.w3.org/ns/auth/acl#";
const WF = "http://www.w3.org/2005/01/wf/flow#";
const AS = "https://www.w3.org/ns/activitystreams#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const SOLID = "http://www.w3.org/ns/solid/terms#";

const ASSIGNER = "https://alice.example/profile/card#me";
const ASSIGNER_DOC = "https://alice.example/profile/card";
const POD = "https://alice.example/";
const ASSIGNEE = "https://bob.example/profile/card#me";
const ASSIGNEE_DOC = "https://bob.example/profile/card";
const ASSIGNEE_INBOX = "https://bob.example/inbox/";
const INDEX = "https://alice.example/settings/privateTypeIndex.ttl";

/** A captured outbound request (method + url + parsed body, when Turtle). */
interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Lowercase a Headers/record/array init into a plain object. */
function headerObj(init?: HeadersInit): Record<string, string> {
  const h = new Headers(init);
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

function ttl(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/turtle", etag: '"v1"' },
  });
}

function parse(body: string | undefined): DatasetCore {
  return new Store(new Parser().parse(body ?? ""));
}

/**
 * The assigner's profile: advertises a private type index (so no bootstrap) and
 * a pod storage. The type index already has the issues/ registration so create()
 * makes no index write (keeps the routed mock simple).
 */
const PROFILE_TTL = `
  @prefix solid: <${SOLID}> .
  @prefix pim: <http://www.w3.org/ns/pim/space#> .
  <${ASSIGNER}> pim:storage <${POD}> ;
    solid:privateTypeIndex <${INDEX}> .`;

const INDEX_TTL = `
  @prefix solid: <${SOLID}> .
  <${INDEX}#reg-issues> a solid:TypeRegistration ;
    solid:forClass <${ISSUE_CLASS}> ;
    solid:instanceContainer <${POD}issues/> .`;

/** The assignee's profile: advertises an LDN inbox. */
const ASSIGNEE_PROFILE_TTL = `
  @prefix ldp: <http://www.w3.org/ns/ldp#> .
  <${ASSIGNEE}> ldp:inbox <${ASSIGNEE_INBOX}> .`;

/**
 * Build a routed mock fetch covering every URL `assignTask` touches:
 *   - assigner profile/index reads (type-index registration check)
 *   - the task resource: create-only PUT, then GET (acl discovery) + acl reads/PUT
 *   - the assignee inbox: profile GET (discovery) + POST (Announce)
 *
 * `opts` lets a test simulate a delivery failure (no inbox / non-2xx POST), a
 * WAC-grant failure (the task's `.acl` PUT 403s), or an ACP-backed pod (the
 * containers advertise an `.acr` control slot instead of `.acl`).
 */
function mockFetch(
  opts: {
    inbox?: "ok" | "no-inbox" | "post-fails";
    /** When set, the task's `.acl` PUT (the grant write) fails with this status. */
    grant?: "fails-403";
    /** When "acp", the containers advertise an `.acr` slot → ACP-backed pod. */
    accessControl?: "wac" | "acp";
  } = {},
) {
  const inboxMode = opts.inbox ?? "ok";
  const acp = opts.accessControl === "acp";
  const captured: Captured[] = [];

  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = headerObj(init?.headers);
    const body = typeof init?.body === "string" ? init.body : undefined;
    captured.push({ url, method, headers, body });

    // ── Assigner profile + index (type-index registration check) ──
    if (url === ASSIGNER || url === ASSIGNER_DOC) {
      if (method === "GET") return ttl(PROFILE_TTL);
    }
    if (url === INDEX && method === "GET") return ttl(INDEX_TTL);

    // ── Assignee profile (inbox discovery for the Announce) ──
    if (url === ASSIGNEE || url === ASSIGNEE_DOC) {
      if (method === "GET") {
        if (inboxMode === "no-inbox") return ttl(`<${ASSIGNEE}> <http://x> <http://y> .`);
        return ttl(ASSIGNEE_PROFILE_TTL);
      }
    }

    // ── Assignee inbox POST (the Announce) ──
    if (url === ASSIGNEE_INBOX && method === "POST") {
      if (inboxMode === "post-fails") return new Response("nope", { status: 500 });
      return new Response(null, { status: 201 });
    }

    // ── The task resource (under issues/) ──
    const isTask = url.startsWith(`${POD}issues/`) && url.endsWith(".ttl");
    if (isTask) {
      if (method === "PUT") {
        // create-only task PUT (the body we assert on)
        return new Response(null, { status: 201, headers: { etag: '"task-v1"' } });
      }
      if (method === "DELETE") {
        // Rollback delete of the just-created task.
        return new Response(null, { status: 205 });
      }
      if (method === "GET") {
        // ACL discovery: advertise the resource's own .acl/.acr slot via Link.
        const slot = acp ? `${url}.acr` : `${url}.acl`;
        return new Response("", {
          status: 200,
          headers: {
            "content-type": "text/turtle",
            link: `<${slot}>; rel="acl"`,
            etag: '"task-v1"',
          },
        });
      }
    }

    // ── The task's .acl document ──
    if (url.endsWith(".acl")) {
      if (method === "GET") {
        // No own ACL yet (404) → the writer materialises a fresh one.
        return new Response("nf", { status: 404 });
      }
      if (method === "PUT") {
        if (opts.grant === "fails-403") return new Response("forbidden", { status: 403 });
        return new Response(null, { status: 201, headers: { etag: '"acl-v1"' } });
      }
    }

    // ── Ancestor containers (inherited-ACL walk + the pre-write access-control
    //    detection): the issues/ + pod root advertise either a WAC `.acl` slot
    //    or, when `accessControl: "acp"`, an ACP `.acr` control slot. ──
    if (url === `${POD}issues/` || url === POD) {
      if (method === "GET") {
        const slot = acp ? `${url}.acr` : `${url}.acl`;
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/turtle", link: `<${slot}>; rel="acl"`, etag: '"c"' },
        });
      }
    }

    return new Response("not-found", { status: 404 });
  }) as unknown as typeof fetch;

  return { impl, captured };
}

/** The task-resource create-only PUT (the assignee-bearing write). */
function taskPut(captured: Captured[]): Captured | undefined {
  return captured.find(
    (c) =>
      c.method === "PUT" &&
      c.url.startsWith(`${POD}issues/`) &&
      c.url.endsWith(".ttl") &&
      c.headers["if-none-match"] === "*",
  );
}

/** The PUT that writes the task's .acl document. */
function aclPut(captured: Captured[]): Captured | undefined {
  return captured.find((c) => c.method === "PUT" && c.url.endsWith(".acl"));
}

/** The DELETE that rolls back a just-created task resource. */
function taskDelete(captured: Captured[]): Captured | undefined {
  return captured.find(
    (c) => c.method === "DELETE" && c.url.startsWith(`${POD}issues/`) && c.url.endsWith(".ttl"),
  );
}

describe("assignTask — validates the assignee WebID (fail closed)", () => {
  it("rejects a non-WebID assignee BEFORE any I/O", async () => {
    const { impl } = mockFetch();
    await expect(
      assignTask(
        { assignerWebId: ASSIGNER, podRoot: POD, assigneeWebId: "just-a-name", task: { title: "X" } },
        impl,
      ),
    ).rejects.toMatchObject({ reason: "invalid-assignee" });
    expect(impl).not.toHaveBeenCalled(); // no write, no grant, no notify
  });

  it("rejects an empty-title task", async () => {
    const { impl } = mockFetch();
    await expect(
      assignTask(
        { assignerWebId: ASSIGNER, podRoot: POD, assigneeWebId: ASSIGNEE, task: { title: "   " } },
        impl,
      ),
    ).rejects.toBeInstanceOf(AssignError);
  });
});

describe("assignTask — writes the task with wf:assignee in the assigner's own pod", () => {
  it("creates a wf:Task carrying the assignee, under issues/ in the assigner pod", async () => {
    const { impl, captured } = mockFetch();
    const res = await assignTask(
      {
        assignerWebId: ASSIGNER,
        podRoot: POD,
        assigneeWebId: ASSIGNEE,
        task: { title: "Review the PR", description: "look at #123" },
      },
      impl,
    );

    // The task resource is in the ASSIGNER's own pod (issues/).
    expect(res.url.startsWith(`${POD}issues/`)).toBe(true);

    const put = taskPut(captured);
    expect(put).toBeDefined();
    const ds = parse(put?.body);
    const subject = `${res.url}#it`;
    // Stamped wf:Task …
    const isTask = [...ds.match(null, null, null)].some(
      (q) => q.subject.value === subject && q.predicate.value === RDF_TYPE && q.object.value === ISSUE_CLASS,
    );
    expect(isTask).toBe(true);
    // …and carries wf:assignee = the assignee WebID as a NamedNode.
    const assigneeQuads = [...ds.match(null, null, null)].filter(
      (q) => q.subject.value === subject && q.predicate.value === `${WF}assignee`,
    );
    expect(assigneeQuads).toHaveLength(1);
    expect(assigneeQuads[0].object.value).toBe(ASSIGNEE);
    expect(assigneeQuads[0].object.termType).toBe("NamedNode");
  });
});

describe("assignTask — minimal WAC grant (read-only on JUST the task)", () => {
  it("grants the assignee READ on the task resource and nothing broader", async () => {
    const { impl, captured } = mockFetch();
    const res = await assignTask(
      { assignerWebId: ASSIGNER, podRoot: POD, assigneeWebId: ASSIGNEE, task: { title: "T" } },
      impl,
    );
    expect(res.granted).toBe(true);

    const put = aclPut(captured);
    expect(put).toBeDefined();
    const ds = parse(put?.body);

    // Find every authorization that names the ASSIGNEE as an acl:agent.
    const assigneeRules = [...ds.match(null, null, null)].filter(
      (q) => q.predicate.value === `${ACL}agent` && q.object.value === ASSIGNEE,
    );
    expect(assigneeRules.length).toBeGreaterThan(0);

    for (const rule of assigneeRules) {
      const subj = rule.subject.value;
      const modes = [...ds.match(rule.subject, null, null)]
        .filter((q) => q.predicate.value === `${ACL}mode`)
        .map((q) => q.object.value);
      // MINIMAL: read only — never write/append/control.
      expect(modes).toContain(`${ACL}Read`);
      expect(modes).not.toContain(`${ACL}Write`);
      expect(modes).not.toContain(`${ACL}Append`);
      expect(modes).not.toContain(`${ACL}Control`);

      // SCOPED to JUST the task resource: accessTo = the task, never a container
      // default (acl:default) — so the grant does not widen to the pod/folder.
      const accessTo = [...ds.match(rule.subject, null, null)]
        .filter((q) => q.predicate.value === `${ACL}accessTo`)
        .map((q) => q.object.value);
      const defaults = [...ds.match(rule.subject, null, null)]
        .filter((q) => q.predicate.value === `${ACL}default`)
        .map((q) => q.object.value);
      expect(accessTo).toEqual([res.url]);
      expect(defaults).toEqual([]); // never an inheritable container grant
      // The assignee rule never names any broader subject (public/authenticated).
      const classes = [...ds.match(rule.subject, null, null)]
        .filter((q) => q.predicate.value === `${ACL}agentClass`)
        .map((q) => q.object.value);
      expect(classes).toEqual([]);
      void subj;
    }
  });
});

describe("assignTask — best-effort as:Announce (notify never fails the assignment)", () => {
  it("POSTs an as:Announce (object=task, target=assignee) to the assignee inbox on success", async () => {
    const { impl, captured } = mockFetch({ inbox: "ok" });
    const res = await assignTask(
      { assignerWebId: ASSIGNER, podRoot: POD, assigneeWebId: ASSIGNEE, task: { title: "T" } },
      impl,
    );
    expect(res.notified).toBe(true);

    const post = captured.find((c) => c.method === "POST" && c.url === ASSIGNEE_INBOX);
    expect(post).toBeDefined();
    const ds = parse(post?.body);
    const has = (p: string, o: string) =>
      [...ds.match(null, null, null)].some((q) => q.predicate.value === AS + p && q.object.value === o);
    // an as:Announce, about the task, targeting the assignee, from the assigner.
    expect(
      [...ds.match(null, null, null)].some(
        (q) => q.predicate.value === RDF_TYPE && q.object.value === `${AS}Announce`,
      ),
    ).toBe(true);
    expect(has("object", res.url)).toBe(true);
    expect(has("target", ASSIGNEE)).toBe(true);
    expect(has("actor", ASSIGNER)).toBe(true);
  });

  it("still SUCCEEDS (notified:false) when the assignee has no inbox", async () => {
    const { impl, captured } = mockFetch({ inbox: "no-inbox" });
    const res = await assignTask(
      { assignerWebId: ASSIGNER, podRoot: POD, assigneeWebId: ASSIGNEE, task: { title: "T" } },
      impl,
    );
    // The assignment (write + grant) succeeded; only delivery failed.
    expect(res.granted).toBe(true);
    expect(res.notified).toBe(false);
    expect(taskPut(captured)).toBeDefined(); // task still written
    expect(aclPut(captured)).toBeDefined(); // grant still set
    // No POST was ever issued (no inbox to send to).
    expect(captured.some((c) => c.method === "POST")).toBe(false);
  });

  it("still SUCCEEDS (notified:false) when the inbox POST errors", async () => {
    const { impl } = mockFetch({ inbox: "post-fails" });
    const res = await assignTask(
      { assignerWebId: ASSIGNER, podRoot: POD, assigneeWebId: ASSIGNEE, task: { title: "T" } },
      impl,
    );
    expect(res.granted).toBe(true);
    expect(res.notified).toBe(false);
  });
});

describe("assignTask — rolls back the task on grant failure (no orphan, no duplicates)", () => {
  it("DELETEs the just-created task and throws grant-failed when the WAC grant fails", async () => {
    const { impl, captured } = mockFetch({ grant: "fails-403" });
    await expect(
      assignTask(
        { assignerWebId: ASSIGNER, podRoot: POD, assigneeWebId: ASSIGNEE, task: { title: "T" } },
        impl,
      ),
    ).rejects.toMatchObject({ reason: "grant-failed" });

    // The task WAS created (the grant comes after the write) …
    const created = taskPut(captured);
    expect(created).toBeDefined();
    // … but it was ROLLED BACK — the same resource is deleted, so nothing
    // unreadable is left behind for a retry to stack onto.
    const deleted = taskDelete(captured);
    expect(deleted).toBeDefined();
    expect(deleted?.url).toBe(created?.url);
  });

  it("a retry after a grant failure does NOT duplicate the assignment", async () => {
    // First attempt: grant fails → task rolled back.
    const first = mockFetch({ grant: "fails-403" });
    await expect(
      assignTask(
        { assignerWebId: ASSIGNER, podRoot: POD, assigneeWebId: ASSIGNEE, task: { title: "T" } },
        first.impl,
      ),
    ).rejects.toMatchObject({ reason: "grant-failed" });
    const firstUrl = taskPut(first.captured)?.url;
    expect(taskDelete(first.captured)?.url).toBe(firstUrl); // rolled back

    // Retry (grant now succeeds): exactly ONE task is created and it is not the
    // orphan from the failed attempt — the failed one was deleted, so no
    // duplicate unreadable assignment remains.
    const retry = mockFetch();
    const res = await assignTask(
      { assignerWebId: ASSIGNER, podRoot: POD, assigneeWebId: ASSIGNEE, task: { title: "T" } },
      retry.impl,
    );
    expect(res.granted).toBe(true);
    const created = retry.captured.filter(
      (c) =>
        c.method === "PUT" &&
        c.url.startsWith(`${POD}issues/`) &&
        c.url.endsWith(".ttl") &&
        c.headers["if-none-match"] === "*",
    );
    expect(created).toHaveLength(1); // one task, not stacked
    expect(taskDelete(retry.captured)).toBeUndefined(); // nothing rolled back on success
  });

  it("still surfaces grant-failed even if the rollback delete itself fails", async () => {
    // Grant fails AND the rollback DELETE 500s — we must still reject (never
    // resolve as if the assignment worked), with the grant error as the cause.
    const captured: Captured[] = [];
    const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      captured.push({ url, method, headers: headerObj(init?.headers) });
      if (url === ASSIGNER || url === ASSIGNER_DOC) return ttl(PROFILE_TTL);
      if (url === INDEX) return ttl(INDEX_TTL);
      if (url === `${POD}issues/` || url === POD) {
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/turtle", link: `<${url}.acl>; rel="acl"`, etag: '"c"' },
        });
      }
      if (url.startsWith(`${POD}issues/`) && url.endsWith(".ttl")) {
        if (method === "PUT") return new Response(null, { status: 201, headers: { etag: '"t"' } });
        if (method === "DELETE") return new Response("boom", { status: 500 }); // rollback fails
        if (method === "GET") {
          return new Response("", {
            status: 200,
            headers: { "content-type": "text/turtle", link: `<${url}.acl>; rel="acl"`, etag: '"t"' },
          });
        }
      }
      if (url.endsWith(".acl")) {
        if (method === "GET") return new Response("nf", { status: 404 });
        if (method === "PUT") return new Response("forbidden", { status: 403 }); // grant fails
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    await expect(
      assignTask(
        { assignerWebId: ASSIGNER, podRoot: POD, assigneeWebId: ASSIGNEE, task: { title: "T" } },
        impl,
      ),
    ).rejects.toMatchObject({ reason: "grant-failed" });
    // The rollback was attempted (a DELETE was issued) even though it failed.
    expect(captured.some((c) => c.method === "DELETE")).toBe(true);
  });
});

describe("assignTask — ACP pods: fail clean BEFORE any write (no orphan)", () => {
  it("rejects grant-failed and writes NO task when the pod is ACP-backed", async () => {
    const { impl, captured } = mockFetch({ accessControl: "acp" });
    await expect(
      assignTask(
        { assignerWebId: ASSIGNER, podRoot: POD, assigneeWebId: ASSIGNEE, task: { title: "T" } },
        impl,
      ),
    ).rejects.toMatchObject({ reason: "grant-failed" });

    // The pod's ACP nature is detected on the container BEFORE the write, so the
    // task is NEVER created (no orphan to clean up) …
    expect(taskPut(captured)).toBeUndefined();
    // … and consequently nothing is rolled back and no grant is attempted.
    expect(taskDelete(captured)).toBeUndefined();
    expect(aclPut(captured)).toBeUndefined();
    // The container WAS probed (a GET to issues/ that returned the .acr slot).
    expect(captured.some((c) => c.method === "GET" && c.url === `${POD}issues/`)).toBe(true);
  });
});
