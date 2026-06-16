// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect, vi } from "vitest";
import { Parser, Store } from "n3";
import {
  buildMessage,
  parseMessage,
  sortMessages,
  chatContainerUrl,
  chatContainerFromUrl,
  openChat,
  Chat,
  MESSAGE_CLASS,
  type ChatMessage,
} from "./chat.js";
import { ChatScopeError, ChatMessageError } from "./errors.js";

const STORAGE = "https://alice.example/";
const WEBID = "https://alice.example/profile/card#me";
const CONTAINER = "https://alice.example/chat/team/";
const INDEX = "https://alice.example/chat/team/index.ttl";
const M1 = "https://alice.example/chat/team/1.ttl";

/** A Turtle Response (200) for a fetch stub. */
function ttlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/turtle" } });
}
/** A 404 Response. */
function notFound(): Response {
  return new Response("nf", { status: 404 });
}

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

// --- SolidOS meeting:LongChat detect-and-read interop (read-first, read-only) --

/** A mee:LongChat channel index document at INDEX (#this typed mee:LongChat). */
const LONGCHAT_INDEX = `
@prefix dc:   <http://purl.org/dc/elements/1.1/> .
@prefix dct:  <http://purl.org/dc/terms/> .
@prefix flow: <http://www.w3.org/2005/01/wf/flow#> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix mee:  <http://www.w3.org/ns/pim/meeting#> .
@prefix sioc: <http://rdfs.org/sioc/ns#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
<#this>
  a mee:LongChat ;
  dc:title "Team long chat" ;
  flow:message <#Msg1> .
<#Msg1>
  sioc:content "Hello from SolidOS" ;
  dct:created "2026-04-07T10:00:00Z"^^xsd:dateTime ;
  foaf:maker <https://carol.example/profile/card#me> .
`;

/** An ldp container listing advertising the index + a dated year folder. */
function containerListing(members: { url: string; container?: boolean }[]): string {
  const triples = members
    .map((m) => (m.container ? `<${m.url}> a ldp:Container .` : ""))
    .join("\n");
  const contains =
    members.length > 0 ? ` ; ldp:contains ${members.map((m) => `<${m.url}>`).join(", ")}` : "";
  return `@prefix ldp: <http://www.w3.org/ns/ldp#> .
    <${CONTAINER}> a ldp:Container${contains} .
    ${triples}`;
}

describe("Chat — meeting:LongChat detect-and-read (read-first interop)", () => {
  it("detects a meeting:LongChat channel and reads it READ-ONLY", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === INDEX) return ttlResponse(LONGCHAT_INDEX);
      // Container listing: only the index file (no dated folders), so the read
      // resolves to the inline channel message.
      if (url === CONTAINER) return ttlResponse(containerListing([{ url: INDEX }]));
      return notFound();
    }) as unknown as typeof fetch;

    const chat = new Chat(CONTAINER, [STORAGE], WEBID, fetchImpl);
    const msgs = await chat.messages();
    expect(chat.detectedKind).toBe("longchat");
    expect(chat.readOnly).toBe(true);
    // Author / time / body parsed via the long-chat typed accessors.
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Hello from SolidOS");
    expect(msgs[0].author).toBe("https://carol.example/profile/card#me");
    expect(msgs[0].created).toBe("2026-04-07T10:00:00.000Z");
  });

  it("reads dated chat files (YYYY/MM/DD/chat.ttl) and orders them after inline", async () => {
    const YEAR = `${CONTAINER}2026/`;
    const MONTH = `${YEAR}04/`;
    const DAY = `${MONTH}07/`;
    const DATED = `${DAY}chat.ttl`;
    const DATED_BODY = `
      @prefix dct:  <http://purl.org/dc/terms/> .
      @prefix foaf: <http://xmlns.com/foaf/0.1/> .
      @prefix sioc: <http://rdfs.org/sioc/ns#> .
      @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
      <#Msg100>
        sioc:content "Dated message" ;
        dct:created "2026-04-07T11:00:00Z"^^xsd:dateTime ;
        foaf:maker <https://carol.example/profile/card#me> .`;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === INDEX) return ttlResponse(LONGCHAT_INDEX);
      if (url === CONTAINER)
        return ttlResponse(containerListing([{ url: INDEX }, { url: YEAR, container: true }]));
      if (url === YEAR) return ttlResponse(containerListing([{ url: MONTH, container: true }]));
      if (url === MONTH) return ttlResponse(containerListing([{ url: DAY, container: true }]));
      if (url === DAY) return ttlResponse(containerListing([{ url: DATED }]));
      if (url === DATED) return ttlResponse(DATED_BODY);
      return notFound();
    }) as unknown as typeof fetch;

    const chat = new Chat(CONTAINER, [STORAGE], WEBID, fetchImpl);
    const msgs = await chat.messages();
    expect(msgs.map((m) => m.content)).toEqual(["Hello from SolidOS", "Dated message"]);
  });

  it("PROPAGATES a dated-file read failure (never shows a deceptively short history)", async () => {
    // A 5xx on a LISTED dated chat.ttl means we failed to read an existing file;
    // surfacing the error (not silently dropping it) is the read-only-history
    // correctness contract. A 404 (delete race) would instead be skipped.
    const YEAR = `${CONTAINER}2026/`;
    const MONTH = `${YEAR}04/`;
    const DAY = `${MONTH}07/`;
    const DATED = `${DAY}chat.ttl`;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === INDEX) return ttlResponse(LONGCHAT_INDEX);
      if (url === CONTAINER)
        return ttlResponse(containerListing([{ url: INDEX }, { url: YEAR, container: true }]));
      if (url === YEAR) return ttlResponse(containerListing([{ url: MONTH, container: true }]));
      if (url === MONTH) return ttlResponse(containerListing([{ url: DAY, container: true }]));
      if (url === DAY) return ttlResponse(containerListing([{ url: DATED }]));
      if (url === DATED) return new Response("boom", { status: 500 }); // exists, unreadable
      return notFound();
    }) as unknown as typeof fetch;
    const chat = new Chat(CONTAINER, [STORAGE], WEBID, fetchImpl);
    await expect(chat.messages()).rejects.toBeTruthy();
  });

  it("PROPAGATES a 5xx on a dated DIRECTORY listing (incomplete history is an error)", async () => {
    // A 5xx when listing a date directory means it EXISTS but we couldn't read its
    // dated files — surfacing the error (not silently continuing) is the read-only
    // history correctness contract.
    const YEAR = `${CONTAINER}2026/`;
    const MONTH = `${YEAR}04/`;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === INDEX) return ttlResponse(LONGCHAT_INDEX);
      if (url === CONTAINER)
        return ttlResponse(containerListing([{ url: INDEX }, { url: YEAR, container: true }]));
      if (url === YEAR) return ttlResponse(containerListing([{ url: MONTH, container: true }]));
      if (url === MONTH) return new Response("boom", { status: 503 }); // exists, unlistable
      return notFound();
    }) as unknown as typeof fetch;
    const chat = new Chat(CONTAINER, [STORAGE], WEBID, fetchImpl);
    await expect(chat.messages()).rejects.toBeTruthy();
  });

  it("a 404 on a listed dated file is SKIPPED (delete race), not an error", async () => {
    const YEAR = `${CONTAINER}2026/`;
    const MONTH = `${YEAR}04/`;
    const DAY = `${MONTH}07/`;
    const DATED = `${DAY}chat.ttl`;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === INDEX) return ttlResponse(LONGCHAT_INDEX);
      if (url === CONTAINER)
        return ttlResponse(containerListing([{ url: INDEX }, { url: YEAR, container: true }]));
      if (url === YEAR) return ttlResponse(containerListing([{ url: MONTH, container: true }]));
      if (url === MONTH) return ttlResponse(containerListing([{ url: DAY, container: true }]));
      if (url === DAY) return ttlResponse(containerListing([{ url: DATED }]));
      if (url === DATED) return notFound(); // 404 — vanished between listing and read
      return notFound();
    }) as unknown as typeof fetch;
    const chat = new Chat(CONTAINER, [STORAGE], WEBID, fetchImpl);
    const msgs = await chat.messages();
    // The inline channel message still renders; the missing dated file is skipped.
    expect(msgs.map((m) => m.content)).toEqual(["Hello from SolidOS"]);
  });

  it("a detected long-chat REFUSES to send (PM never writes the long-chat shape)", async () => {
    const writes: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method && init.method !== "GET") writes.push(`${init.method} ${url}`);
      if (url === INDEX) return ttlResponse(LONGCHAT_INDEX);
      if (url === CONTAINER) return ttlResponse(containerListing([{ url: INDEX }]));
      return notFound();
    }) as unknown as typeof fetch;

    const chat = new Chat(CONTAINER, [STORAGE], WEBID, fetchImpl);
    await chat.messages(); // detect → longchat
    await expect(chat.send("nope")).rejects.toBeInstanceOf(ChatMessageError);
    expect(writes).toEqual([]); // NO write of any kind reached the pod
  });

  it("a NATIVE channel (no mee:LongChat index) still reads AND writes", async () => {
    const M2 = "https://alice.example/chat/team/2.ttl";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "PUT") return new Response(null, { status: 201 }); // accept the append
      if (url === INDEX) return notFound(); // no long-chat index → native
      if (url === CONTAINER)
        return ttlResponse(
          `@prefix ldp: <http://www.w3.org/ns/ldp#> . <${CONTAINER}> ldp:contains <${M1}>, <${M2}> .`,
        );
      if (url === M1)
        return ttlResponse(
          await serialize(buildMessage(M1, { author: WEBID, content: "native-one", created: new Date("2026-06-01T00:00:00Z") })),
        );
      if (url === M2)
        return ttlResponse(
          await serialize(buildMessage(M2, { author: WEBID, content: "native-two", created: new Date("2026-06-02T00:00:00Z") })),
        );
      return notFound();
    }) as unknown as typeof fetch;

    const chat = new Chat(CONTAINER, [STORAGE], WEBID, fetchImpl);
    const msgs = await chat.messages();
    expect(chat.detectedKind).toBe("native");
    expect(chat.readOnly).toBe(false);
    expect(msgs.map((m) => m.content)).toEqual(["native-one", "native-two"]);
    // The native write path still works.
    const { url } = await chat.send("native-three");
    expect(url.startsWith(CONTAINER)).toBe(true);
  });

  it("send() on a long-chat REFUSES even BEFORE any read (detect-on-send, fail-closed)", async () => {
    // The write guard must not be bypassable before classification: a fresh Chat
    // (detectedKind undefined) that is actually a meeting:LongChat must detect on
    // send() and refuse — never PUT a native message into a SolidOS channel.
    const writes: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET") !== "GET") writes.push(`${init?.method} ${url}`);
      if (url === INDEX) return ttlResponse(LONGCHAT_INDEX);
      if (url === CONTAINER) return ttlResponse(containerListing([{ url: INDEX }]));
      return notFound();
    }) as unknown as typeof fetch;
    const chat = new Chat(CONTAINER, [STORAGE], WEBID, fetchImpl);
    expect(chat.detectedKind).toBeUndefined(); // never read yet
    await expect(chat.send("sneaky")).rejects.toBeInstanceOf(ChatMessageError);
    expect(chat.detectedKind).toBe("longchat"); // detected on the send path
    expect(writes).toEqual([]); // NO write reached the pod
  });

  it("FAILS CLOSED on an ambiguous index error (never downgrades to writable native)", async () => {
    // A 500 on the index probe is AMBIGUOUS — the channel COULD be a long-chat
    // we failed to read. messages() must throw, not silently treat it as native
    // (which would let send() append PM messages into a SolidOS channel).
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === INDEX) return new Response("boom", { status: 500 });
      return notFound();
    }) as unknown as typeof fetch;
    const chat = new Chat(CONTAINER, [STORAGE], WEBID, fetchImpl);
    await expect(chat.messages()).rejects.toBeTruthy();
    // detectedKind was never set to native, so send stays guarded by the native
    // assertInContainer path only AFTER an explicit native detection — here it is
    // undefined, so the chat is not yet classified writable.
    expect(chat.detectedKind).toBeUndefined();
  });

  it("a 403 on the index is NOT native (an append-only LongChat must not be writable)", async () => {
    // 403 means the index COULD exist and be unreadable to us — e.g. a SolidOS
    // LongChat with acl:Append (read-denied, append-allowed). It must FAIL CLOSED
    // (throw), never classify native, so send() can't PUT into a real long-chat.
    const writes: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET") !== "GET") writes.push(`${init?.method} ${url}`);
      if (url === INDEX) return new Response("forbidden", { status: 403 });
      return notFound();
    }) as unknown as typeof fetch;
    const chat = new Chat(CONTAINER, [STORAGE], WEBID, fetchImpl);
    await expect(chat.messages()).rejects.toBeTruthy();
    expect(chat.detectedKind).toBeUndefined();
    // And send() likewise fails closed (its detect-on-send re-probes → throws).
    await expect(chat.send("nope")).rejects.toBeTruthy();
    expect(writes).toEqual([]);
  });

  it("only a 404 index downgrades to native (genuinely absent channel doc)", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === INDEX) return notFound(); // 404 → no channel doc
      if (url === CONTAINER)
        return ttlResponse(
          `@prefix ldp: <http://www.w3.org/ns/ldp#> . <${CONTAINER}> a ldp:Container .`,
        ); // empty native chat
      return notFound();
    }) as unknown as typeof fetch;
    const chat = new Chat(CONTAINER, [STORAGE], WEBID, fetchImpl);
    const msgs = await chat.messages();
    expect(chat.detectedKind).toBe("native");
    expect(chat.readOnly).toBe(false);
    expect(msgs).toEqual([]);
  });

  it("ONLY parses YYYY/MM/DD/chat.ttl dated files — ignores other .ttl under the subtree", async () => {
    const YEAR = `${CONTAINER}2026/`;
    const MONTH = `${YEAR}04/`;
    const DAY = `${MONTH}07/`;
    const DATED = `${DAY}chat.ttl`;
    // A decoy message-shaped doc that is NOT a dated chat file (wrong dir name +
    // wrong filename) must NEVER be read as chat history.
    const DECOY_DIR = `${CONTAINER}notes/`;
    const DECOY = `${DECOY_DIR}evil.ttl`;
    const requested: string[] = [];
    const datedBody = `
      @prefix dct:<http://purl.org/dc/terms/> . @prefix foaf:<http://xmlns.com/foaf/0.1/> .
      @prefix sioc:<http://rdfs.org/sioc/ns#> . @prefix xsd:<http://www.w3.org/2001/XMLSchema#> .
      <#m> sioc:content "legit dated" ; dct:created "2026-04-07T11:00:00Z"^^xsd:dateTime ; foaf:maker <https://carol.example/profile/card#me> .`;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === INDEX) return ttlResponse(LONGCHAT_INDEX);
      if (url === CONTAINER)
        return ttlResponse(
          containerListing([
            { url: INDEX },
            { url: YEAR, container: true },
            { url: DECOY_DIR, container: true }, // a non-date dir — must be skipped
          ]),
        );
      if (url === YEAR) return ttlResponse(containerListing([{ url: MONTH, container: true }]));
      if (url === MONTH) return ttlResponse(containerListing([{ url: DAY, container: true }]));
      if (url === DAY) return ttlResponse(containerListing([{ url: DATED }]));
      if (url === DATED) return ttlResponse(datedBody);
      return notFound();
    }) as unknown as typeof fetch;

    const chat = new Chat(CONTAINER, [STORAGE], WEBID, fetchImpl);
    const msgs = await chat.messages();
    // Only the inline channel message + the legit dated chat.ttl — never the decoy.
    expect(msgs.map((m) => m.content)).toEqual(["Hello from SolidOS", "legit dated"]);
    // The walk never even LISTED the non-date directory, and never read the decoy.
    expect(requested).not.toContain(DECOY_DIR);
    expect(requested).not.toContain(DECOY);
  });
});

describe("openChat — foreign-origin read-only path (SSRF-guarded, native fetch)", () => {
  const FOREIGN = "https://carol.example/chat/team/";

  it("by default blocks a foreign channel (allowForeign unset) → ChatScopeError", () => {
    expect(() => openChat({ containerUrl: FOREIGN, storages: [STORAGE], webId: WEBID })).toThrowError(
      ChatScopeError,
    );
  });

  it("with allowForeign + a SAFE https host → a read-only foreign Chat", () => {
    const chat = openChat({
      containerUrl: FOREIGN,
      storages: [STORAGE],
      webId: WEBID,
      allowForeign: true,
    });
    expect(chat.readOnly).toBe(true); // foreign is read-only from construction
    expect(chat.inScope).toBe(false);
  });

  it("a foreign chat REFUSES to send even before any read", async () => {
    const chat = openChat({
      containerUrl: FOREIGN,
      storages: [STORAGE],
      webId: WEBID,
      allowForeign: true,
    });
    await expect(chat.send("x")).rejects.toBeInstanceOf(ChatMessageError);
  });

  it("with allowForeign but an UNSAFE host (loopback) → still blocked (SSRF guard)", () => {
    expect(() =>
      openChat({
        containerUrl: "http://127.0.0.1/chat/x/",
        storages: [STORAGE],
        webId: WEBID,
        allowForeign: true,
      }),
    ).toThrowError(ChatScopeError);
  });

  it("with allowForeign but a non-https host → blocked (token-leak / cleartext)", () => {
    expect(() =>
      openChat({
        containerUrl: "http://carol.example/chat/x/",
        storages: [STORAGE],
        webId: WEBID,
        allowForeign: true,
      }),
    ).toThrowError(ChatScopeError);
  });
});

describe("chatContainerFromUrl — normalise a document/fragment ?url= to its container", () => {
  it("drops a trailing index.ttl + #this fragment to the container", () => {
    expect(chatContainerFromUrl("https://alice.example/chat/team/index.ttl#this")).toBe(CONTAINER);
  });
  it("drops a trailing index.ttl to the container", () => {
    expect(chatContainerFromUrl("https://alice.example/chat/team/index.ttl")).toBe(CONTAINER);
  });
  it("leaves an already-container URL unchanged", () => {
    expect(chatContainerFromUrl(CONTAINER)).toBe(CONTAINER);
  });
  it("strips a query string", () => {
    expect(chatContainerFromUrl("https://alice.example/chat/team/?x=1")).toBe(CONTAINER);
  });
  it("rejects a non-http(s) URL", () => {
    expect(chatContainerFromUrl("ftp://alice.example/chat/")).toBeUndefined();
    expect(chatContainerFromUrl("not a url")).toBeUndefined();
  });
});
