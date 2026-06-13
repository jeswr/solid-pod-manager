// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect, vi } from "vitest";
import { Parser, Store } from "n3";
import {
  buildMessage,
  parseMessage,
  sortMessages,
  chatContainerUrl,
  openChat,
  Chat,
  MESSAGE_CLASS,
  type ChatMessage,
} from "./chat.js";
import { ChatScopeError, ChatMessageError } from "./errors.js";

const STORAGE = "https://alice.example/";
const WEBID = "https://alice.example/profile/card#me";
const CONTAINER = "https://alice.example/chat/team/";
const M1 = "https://alice.example/chat/team/1.ttl";

describe("buildMessage / parseMessage round-trip", () => {
  it("preserves author, content, created and stamps sioc:Note", () => {
    const created = new Date("2026-06-13T10:00:00.000Z");
    const ds = buildMessage(M1, { author: WEBID, content: "hello", created });
    const round = parseMessage(M1, ds);
    expect(round).toEqual<ChatMessage>({
      url: M1,
      author: WEBID,
      content: "hello",
      created: "2026-06-13T10:00:00.000Z",
    });
    const hasType = [...ds].some(
      (q) => q.predicate.value.endsWith("#type") && q.object.value === MESSAGE_CLASS,
    );
    expect(hasType).toBe(true);
  });

  it("drops a non-WebID author", () => {
    const ds = buildMessage(M1, { author: "just a name", content: "x" });
    expect(parseMessage(M1, ds)?.author).toBeUndefined();
  });

  it("returns undefined for a non-message document", () => {
    const store = new Store(new Parser().parse(`<x> <y> "z" .`));
    expect(parseMessage(M1, store)).toBeUndefined();
  });
});

describe("sortMessages", () => {
  it("orders oldest → newest with a stable url tiebreaker", () => {
    const m = (url: string, created: string): ChatMessage => ({ url, content: "", created });
    const out = sortMessages([
      m("c", "2026-06-03T00:00:00Z"),
      m("a", "2026-06-01T00:00:00Z"),
      m("b", "2026-06-02T00:00:00Z"),
    ]);
    expect(out.map((x) => x.url)).toEqual(["a", "b", "c"]);
  });
});

describe("chatContainerUrl", () => {
  it("slugifies the channel under chat/", () => {
    expect(chatContainerUrl(STORAGE, "Team Chat!")).toBe("https://alice.example/chat/team-chat/");
  });
});

describe("openChat — same-pod scope guard (confused-deputy)", () => {
  it("throws ChatScopeError for a container outside the user's own pods", () => {
    expect(() =>
      openChat({ containerUrl: "https://evil.example/chat/x/", storages: [STORAGE], webId: WEBID }),
    ).toThrowError(ChatScopeError);
  });

  it("opens a chat for an in-pod container (normalising trailing slash)", () => {
    const chat = openChat({
      containerUrl: "https://alice.example/chat/team",
      storages: [STORAGE],
      webId: WEBID,
    });
    expect(chat.containerUrl).toBe(CONTAINER);
    expect(chat.inScope).toBe(true);
  });
});

describe("Chat.messages + send", () => {
  function containerTtl(members: string[]): string {
    const contains = members.map((m) => `<${m}>`).join(", ");
    return `@prefix ldp: <http://www.w3.org/ns/ldp#> . <${CONTAINER}> ldp:contains ${contains} .`;
  }
  function ttl(body: string): Response {
    return new Response(body, { status: 200, headers: { "content-type": "text/turtle" } });
  }

  it("lists messages oldest-first and skips off-container members", async () => {
    const EVIL = "https://evil.example/x.ttl";
    const M2 = "https://alice.example/chat/team/2.ttl";
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === CONTAINER) return ttl(containerTtl([M1, M2, EVIL]));
      if (url === M1) {
        const ds = buildMessage(M1, { author: WEBID, content: "first", created: new Date("2026-06-01T00:00:00Z") });
        return ttl(await serialize(ds));
      }
      if (url === M2) {
        const ds = buildMessage(M2, { author: WEBID, content: "second", created: new Date("2026-06-02T00:00:00Z") });
        return ttl(await serialize(ds));
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const chat = new Chat(CONTAINER, [STORAGE], WEBID, fetchImpl);
    const msgs = await chat.messages();
    expect(msgs.map((m) => m.content)).toEqual(["first", "second"]);
    expect(requested).not.toContain(EVIL); // off-container member never fetched
  });

  it("send create-only PUTs a new message resource in the container", async () => {
    const calls: { url: string; method: string; headers?: HeadersInit }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", headers: init?.headers });
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const chat = new Chat(CONTAINER, [STORAGE], WEBID, fetchImpl);
    const { url } = await chat.send("  hi there  ");
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe(url);
    expect(url.startsWith(CONTAINER)).toBe(true);
    expect((put?.headers as Record<string, string>)["if-none-match"]).toBe("*"); // create-only
  });

  it("refuses to send an empty message (validation, not a scope error)", async () => {
    const sent = vi.fn(async () => new Response(null, { status: 201 })) as unknown as typeof fetch;
    const chat = new Chat(CONTAINER, [STORAGE], WEBID, sent);
    await expect(chat.send("   ")).rejects.toBeInstanceOf(ChatMessageError);
    expect(sent).not.toHaveBeenCalled();
  });
});

describe("Chat direct-child scope guard branches (confused-deputy)", () => {
  // Reach the private guard via messages() listing: craft a container that
  // advertises off-child members, and assert they are skipped (not fetched).
  function ttl(body: string): Response {
    return new Response(body, { status: 200, headers: { "content-type": "text/turtle" } });
  }

  it("skips nested-path, %2f, query and fragment member URLs in a listing", async () => {
    const NESTED = "https://alice.example/chat/team/sub/x.ttl";
    const ENCODED = "https://alice.example/chat/team/a%2fb.ttl";
    const QUERY = "https://alice.example/chat/team/x.ttl?q=1";
    const FRAGMENT = "https://alice.example/chat/team/x.ttl#frag";
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === CONTAINER) {
        return ttl(
          `@prefix ldp: <http://www.w3.org/ns/ldp#> . <${CONTAINER}> ldp:contains <${NESTED}>, <${ENCODED}>, <${QUERY}>, <${FRAGMENT}> .`,
        );
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const c = new Chat(CONTAINER, [STORAGE], WEBID, fetchImpl);
    const msgs = await c.messages();
    expect(msgs).toEqual([]); // nothing in-scope
    expect(requested).not.toContain(NESTED);
    expect(requested).not.toContain(ENCODED);
    expect(requested).not.toContain(QUERY);
    expect(requested).not.toContain(FRAGMENT);
  });

  it("chatContainerUrl falls back to a random slug for an empty channel name", () => {
    const url = chatContainerUrl(STORAGE, "!!!");
    expect(url.startsWith("https://alice.example/chat/")).toBe(true);
    expect(url.endsWith("/")).toBe(true);
  });
});

async function serialize(ds: import("@rdfjs/types").DatasetCore): Promise<string> {
  const { serializeTurtle } = await import("./pod-data.js");
  return serializeTurtle(ds);
}
