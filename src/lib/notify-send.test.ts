// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect, vi } from "vitest";
import { Parser } from "n3";
import { buildNotification, sendNotification } from "./notify-send.js";
import { serializeTurtle } from "./pod-data.js";
import { InvalidTargetError, NoInboxError, NotificationSendError } from "./errors.js";

const AS = "https://www.w3.org/ns/activitystreams#";
const ACTOR = "https://alice.example/profile/card#me";
const RECIPIENT = "https://bob.example/profile/card#me";
const RECIPIENT_DOC = "https://bob.example/profile/card";
const INBOX = "https://bob.example/inbox/";

function ttl(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/turtle" } });
}

const INBOX_TTL = `
  @prefix ldp: <http://www.w3.org/ns/ldp#> .
  <${RECIPIENT}> ldp:inbox <${INBOX}> .`;

describe("buildNotification — well-formed AS2.0", () => {
  it("round-trips actor/object/target/summary/content/published/type into quads", async () => {
    const published = new Date("2026-06-13T12:00:00.000Z");
    const ds = buildNotification({
      type: "Invite",
      actor: ACTOR,
      object: "https://alice.example/schedule/poll-1.ttl#it",
      target: RECIPIENT,
      summary: "You're invited",
      content: "Pick a time",
      published,
    });
    const turtle = await serializeTurtle(ds, { as: AS });
    const quads = new Parser().parse(turtle);
    const has = (p: string, o: string) =>
      quads.some((q) => q.predicate.value === AS + p && q.object.value === o);
    expect(
      quads.some(
        (q) =>
          q.predicate.value === "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" &&
          q.object.value === `${AS}Invite`,
      ),
    ).toBe(true);
    expect(has("actor", ACTOR)).toBe(true);
    expect(has("object", "https://alice.example/schedule/poll-1.ttl#it")).toBe(true);
    expect(has("target", RECIPIENT)).toBe(true);
    expect(has("summary", "You're invited")).toBe(true);
    expect(has("content", "Pick a time")).toBe(true);
    expect(has("published", "2026-06-13T12:00:00.000Z")).toBe(true);
  });

  it("serialises a RELATIVE `#it` subject (the inbox assigns the final IRI)", async () => {
    const ds = buildNotification({ type: "Announce", actor: ACTOR });
    const turtle = await serializeTurtle(ds, { as: AS });
    // n3 emits the subject as a relative IRI `<#it>` (not absolute, not a blank
    // node) so the LDN inbox resolves it against the POST request URL.
    expect(turtle).toContain("<#it>");
    expect(turtle).not.toMatch(/_:/); // no blank-node subject
  });

  it("emits an as:published triple by default when none is supplied", async () => {
    const ds = buildNotification({ type: "Announce", actor: ACTOR });
    const turtle = await serializeTurtle(ds, { as: AS });
    const quads = new Parser().parse(turtle);
    const published = quads.find((q) => q.predicate.value === `${AS}published`);
    expect(published).toBeDefined();
    // It is a valid ISO date-time literal.
    expect(Number.isNaN(Date.parse(published!.object.value))).toBe(false);
  });

  it("drops non-http(s) actor/object rather than minting a malformed node", async () => {
    const ds = buildNotification({ type: "Announce", actor: "not-a-url", object: "also bad" });
    const turtle = await serializeTurtle(ds, { as: AS });
    const quads = new Parser().parse(turtle);
    expect(quads.some((q) => q.predicate.value === `${AS}actor`)).toBe(false);
    expect(quads.some((q) => q.predicate.value === `${AS}object`)).toBe(false);
  });
});

describe("sendNotification — discover + validate BEFORE POST", () => {
  it("POSTs Turtle to the validated discovered inbox", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === RECIPIENT_DOC) return ttl(INBOX_TTL);
      if (url === INBOX && (init?.method ?? "GET") === "POST") {
        return new Response(null, { status: 201 });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const { inbox } = await sendNotification(
      { recipientWebId: RECIPIENT, actorWebId: ACTOR, type: "Announce", summary: "Hi" },
      fetchImpl,
    );
    expect(inbox).toBe(INBOX);

    const post = calls.find((c) => (c.init?.method ?? "GET") === "POST");
    expect(post?.url).toBe(INBOX);
    expect((post?.init?.headers as Record<string, string>)["content-type"]).toBe("text/turtle");
    // Body parses as valid AS2.0 Turtle carrying the actor.
    const quads = new Parser().parse(post?.init?.body as string);
    expect(quads.some((q) => q.predicate.value === `${AS}actor` && q.object.value === ACTOR)).toBe(
      true,
    );
  });

  it("succeeds (backstop does not reject) when the final response URL equals the inbox", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === RECIPIENT_DOC) return ttl(INBOX_TTL);
      if (url === INBOX && (init?.method ?? "GET") === "POST") {
        const r = new Response(null, { status: 201 });
        Object.defineProperty(r, "url", { value: INBOX }); // final URL == target
        return r;
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    await expect(
      sendNotification({ recipientWebId: RECIPIENT, actorWebId: ACTOR }, fetchImpl),
    ).resolves.toEqual({ inbox: INBOX });
  });

  it("does NOT POST when the recipient advertises no inbox", async () => {
    const posts: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "POST") posts.push(url);
      if (url === RECIPIENT_DOC) return ttl(`<${RECIPIENT}> <http://x/y> "z" .`);
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    await expect(
      sendNotification({ recipientWebId: RECIPIENT, actorWebId: ACTOR }, fetchImpl),
    ).rejects.toBeInstanceOf(NoInboxError);
    expect(posts).toHaveLength(0); // host-leak guard: no POST ever issued
  });

  it("does NOT POST when the discovered inbox fails the SSRF validator", async () => {
    const posts: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "POST") posts.push(url);
      if (url === RECIPIENT_DOC) {
        return ttl(`
          @prefix ldp: <http://www.w3.org/ns/ldp#> .
          <${RECIPIENT}> ldp:inbox <http://169.254.169.254/latest/> .`);
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    await expect(
      sendNotification({ recipientWebId: RECIPIENT, actorWebId: ACTOR }, fetchImpl),
    ).rejects.toBeInstanceOf(InvalidTargetError);
    expect(posts).toHaveLength(0); // never POSTed to the metadata endpoint
  });

  it("does NOT follow a 3xx redirect from the inbox (redirect bypass guard)", async () => {
    // The validated public inbox answers with a redirect toward a private host.
    // The send must POST with redirect:"manual" and treat the 3xx as a failure —
    // it must NEVER issue a request to the redirect Location (token-leak guard).
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      if (url === RECIPIENT_DOC) return ttl(INBOX_TTL);
      if (url === INBOX && (init?.method ?? "GET") === "POST") {
        expect(init?.redirect).toBe("manual"); // never follow
        return new Response(null, {
          status: 307,
          headers: { location: "http://169.254.169.254/collect" },
        });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    await expect(
      sendNotification({ recipientWebId: RECIPIENT, actorWebId: ACTOR }, fetchImpl),
    ).rejects.toBeInstanceOf(NotificationSendError);
    // The metadata endpoint was never requested.
    expect(requested.some((u) => u.includes("169.254.169.254"))).toBe(false);
  });

  it("rejects when the FINAL response URL is off-target (auth-retry redirect backstop)", async () => {
    // Simulate a runtime that followed a redirect anyway: a 2xx response whose
    // final url is a private host. The backstop must reject it.
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === RECIPIENT_DOC) return ttl(INBOX_TTL);
      if (url === INBOX && (init?.method ?? "GET") === "POST") {
        // Response.url is read-only; construct then redefine for the test.
        const r = new Response(null, { status: 200 });
        Object.defineProperty(r, "url", { value: "https://169.254.169.254/collect" });
        return r;
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    await expect(
      sendNotification({ recipientWebId: RECIPIENT, actorWebId: ACTOR }, fetchImpl),
    ).rejects.toBeInstanceOf(NotificationSendError);
  });

  it("throws NotificationSendError on a non-2xx inbox response", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === RECIPIENT_DOC) return ttl(INBOX_TTL);
      if (url === INBOX && (init?.method ?? "GET") === "POST") {
        return new Response("denied", { status: 403 });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    await expect(
      sendNotification({ recipientWebId: RECIPIENT, actorWebId: ACTOR }, fetchImpl),
    ).rejects.toBeInstanceOf(NotificationSendError);
  });
});
