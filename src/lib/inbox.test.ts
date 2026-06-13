// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect, vi } from "vitest";
import { Inbox, inboxFor, parseInboxNotification } from "./inbox.js";
import { buildNotification } from "./notify-send.js";
import { serializeTurtle } from "./pod-data.js";
import { InboxScopeError } from "./errors.js";

const STORAGE = "https://alice.example/";
const WEBID = "https://alice.example/profile/card#me";
const DOC = "https://alice.example/profile/card";
const INBOX = "https://alice.example/inbox/";
const N1 = "https://alice.example/inbox/n1.ttl";
const N2 = "https://alice.example/inbox/n2.ttl";

function ttl(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/turtle" } });
}

async function notifTtl(opts: { actor: string; summary?: string; published?: Date }): Promise<string> {
  const ds = buildNotification({
    type: "Announce",
    actor: opts.actor,
    summary: opts.summary,
    published: opts.published,
  });
  return serializeTurtle(ds, { as: "https://www.w3.org/ns/activitystreams#" });
}

/** A container listing (Turtle) advertising the given member resources. */
function containerTtl(members: string[]): string {
  const LDP = "http://www.w3.org/ns/ldp#";
  const contains = members.map((m) => `<${m}>`).join(", ");
  return `
    @prefix ldp: <${LDP}> .
    <${INBOX}> a ldp:Container, ldp:BasicContainer ; ldp:contains ${contains} .`;
}

describe("parseInboxNotification", () => {
  it("parses an AS2.0 notification regardless of its subject IRI", async () => {
    const body = await notifTtl({ actor: WEBID, summary: "Hello" });
    const ds = new (await import("n3")).Parser().parse(body);
    const store = new (await import("n3")).Store(ds);
    const n = parseInboxNotification(N1, store);
    expect(n?.actor).toBe(WEBID);
    expect(n?.summary).toBe("Hello");
    expect(n?.type).toBe("Announce");
    expect(n?.read).toBe(false);
  });

  it("returns undefined for a document with no activity markers", async () => {
    const store = new (await import("n3")).Store(
      new (await import("n3")).Parser().parse(`<x> <y> "z" .`),
    );
    expect(parseInboxNotification(N1, store)).toBeUndefined();
  });

  it("parses object/target/content/published fields", async () => {
    const { Parser, Store } = await import("n3");
    const ttlBody = `
      @prefix as: <https://www.w3.org/ns/activitystreams#> .
      <${N1}#it> a as:Invite ;
        as:actor <${WEBID}> ;
        as:object <https://alice.example/schedule/p.ttl> ;
        as:target <https://bob.example/x> ;
        as:content "Join us" ;
        as:published "2026-06-13T12:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .`;
    const n = parseInboxNotification(N1, new Store(new Parser().parse(ttlBody)));
    expect(n?.type).toBe("Invite");
    expect(n?.object).toBe("https://alice.example/schedule/p.ttl");
    expect(n?.target).toBe("https://bob.example/x");
    expect(n?.content).toBe("Join us");
    expect(n?.published).toBe("2026-06-13T12:00:00.000Z");
  });

  it("falls back to the #it subject for a typeless payload carrying as:actor", async () => {
    const { Parser, Store } = await import("n3");
    // No rdf:type, but an as:actor on the conventional #it subject.
    const ttlBody = `
      @prefix as: <https://www.w3.org/ns/activitystreams#> .
      <${N1}#it> as:actor <${WEBID}> ; as:summary "ping" .`;
    const n = parseInboxNotification(N1, new Store(new Parser().parse(ttlBody)));
    expect(n?.actor).toBe(WEBID);
    expect(n?.summary).toBe("ping");
    expect(n?.type).toBe("Notification"); // no as: type → generic label
  });
});

describe("Inbox.list", () => {
  it("lists + parses notifications newest-first, resolving read-state from sidecars", async () => {
    const n1 = await notifTtl({ actor: WEBID, summary: "first", published: new Date("2026-06-01T00:00:00Z") });
    const n2 = await notifTtl({ actor: WEBID, summary: "second", published: new Date("2026-06-10T00:00:00Z") });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === INBOX) return ttl(containerTtl([N1, N2, `${N1}.read.ttl`]));
      if (url === N1) return ttl(n1);
      if (url === N2) return ttl(n2);
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const inbox = new Inbox(INBOX, fetchImpl);
    const items = await inbox.list();
    expect(items.map((i) => i.summary)).toEqual(["second", "first"]); // newest first
    // n1 has a read-marker sidecar; n2 does not.
    expect(items.find((i) => i.summary === "first")?.read).toBe(true);
    expect(items.find((i) => i.summary === "second")?.read).toBe(false);
    // The sidecar itself is not surfaced as a notification.
    expect(items).toHaveLength(2);
  });

  it("skips an off-container member in the listing without dereferencing it (read-path scope guard)", async () => {
    const EVIL = "https://evil.example/steal.ttl";
    const n1 = await notifTtl({ actor: WEBID, summary: "legit" });
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === INBOX) return ttl(containerTtl([N1, EVIL]));
      if (url === N1) return ttl(n1);
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const inbox = new Inbox(INBOX, fetchImpl);
    const items = await inbox.list();
    expect(items.map((i) => i.summary)).toEqual(["legit"]); // evil member excluded
    expect(requested).not.toContain(EVIL); // and never fetched with our auth
  });

  it("lists empty for a missing inbox (404)", async () => {
    const fetchImpl = (async () => new Response("nf", { status: 404 })) as unknown as typeof fetch;
    const inbox = new Inbox(INBOX, fetchImpl);
    await expect(inbox.list()).resolves.toEqual([]);
  });
});

describe("Inbox scope guard (confused-deputy)", () => {
  it("refuses markRead/dismiss on a URL outside the inbox container", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const inbox = new Inbox(INBOX, fetchImpl);
    await expect(inbox.markRead("https://evil.example/x.ttl")).rejects.toBeInstanceOf(InboxScopeError);
    await expect(inbox.dismiss("https://alice.example/other/x.ttl")).rejects.toBeInstanceOf(
      InboxScopeError,
    );
    await expect(inbox.dismiss(INBOX)).rejects.toBeInstanceOf(InboxScopeError); // the container itself
    await expect(inbox.markRead(`${N1}?q=1`)).rejects.toBeInstanceOf(InboxScopeError); // query
    expect(fetchImpl).not.toHaveBeenCalled(); // fail closed before any I/O
  });

  it("markRead writes a scoped same-pod sidecar; dismiss deletes the resource + sidecar", async () => {
    const calls: { url: string; method: string }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const inbox = new Inbox(INBOX, fetchImpl);

    await inbox.markRead(N1);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe(`${N1}.read.ttl`); // sidecar within the inbox

    calls.length = 0;
    await inbox.dismiss(N1);
    const deletes = calls.filter((c) => c.method === "DELETE").map((c) => c.url);
    expect(deletes).toContain(N1);
    expect(deletes).toContain(`${N1}.read.ttl`);
  });
});

describe("inboxFor — own-inbox discovery + same-pod guard", () => {
  it("returns an Inbox when the profile advertises an inbox inside the active storage", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input) === DOC) {
        return ttl(`@prefix ldp: <http://www.w3.org/ns/ldp#> . <${WEBID}> ldp:inbox <${INBOX}> .`);
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const inbox = await inboxFor({ webId: WEBID, activeStorage: STORAGE, fetchImpl });
    expect(inbox?.inboxUrl).toBe(INBOX);
  });

  it("returns undefined when the advertised inbox is OUTSIDE the active storage", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input) === DOC) {
        return ttl(
          `@prefix ldp: <http://www.w3.org/ns/ldp#> . <${WEBID}> ldp:inbox <https://other.example/inbox/> .`,
        );
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const inbox = await inboxFor({ webId: WEBID, activeStorage: STORAGE, fetchImpl });
    expect(inbox).toBeUndefined();
  });

  it("returns undefined when no inbox is advertised", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input) === DOC) return ttl(`<${WEBID}> <http://x/y> "z" .`);
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    await expect(
      inboxFor({ webId: WEBID, activeStorage: STORAGE, fetchImpl }),
    ).resolves.toBeUndefined();
  });
});
