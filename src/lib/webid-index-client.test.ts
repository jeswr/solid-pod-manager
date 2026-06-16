// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Exhaustive tests for the vendored WebID-index consumer client
 * (`webid-index-client.ts`). This is the SSRF/privacy-critical surface that the
 * Pod Manager's people search talks to a third-party origin through, so it is
 * tested thoroughly: the RDF projection, the same-origin `fetchPage` guard, the
 * `https:`-only photo guard, the fail-closed `isIndexed`, the suggest status
 * mapping + WebID validation, credentials-omit on every request, and the
 * env-gated `null` factory. The `fetch` is fully stubbed — no network.
 *
 * Mirrors the source suite in jeswr/solid-webid-index
 * (`src/lib/client/indexClient.test.ts`).
 */
import { describe, expect, it, vi } from "vitest";
import { createIndexClient } from "./webid-index-client.js";

const ORIGIN = "https://idx.example";

/** A fetch stub returning a Turtle body with the given Content-Type + status. */
function rdfFetch(body: string, init?: { status?: number; contentType?: string }) {
  return vi.fn(async () =>
    new Response(body, {
      status: init?.status ?? 200,
      headers: { "Content-Type": init?.contentType ?? "text/turtle" },
    }),
  ) as unknown as typeof globalThis.fetch;
}

/** A Hydra collection of two members, one with full metadata, plus a next page. */
const SEARCH_TTL = `
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix dct: <http://purl.org/dc/terms/> .

<https://idx.example/search?q=ada> a hydra:Collection ;
  hydra:member <https://alice.pod/card#me>, <https://bob.pod/card#me> ;
  hydra:view <https://idx.example/search?q=ada&page=1> .

<https://idx.example/search?q=ada&page=1> a hydra:PartialCollectionView ;
  hydra:next <https://idx.example/search?q=ada&page=2> .

<https://alice.pod/card#me> foaf:name "Ada Lovelace" ;
  foaf:img <https://alice.pod/avatar.png> ;
  dct:modified "2026-01-01T00:00:00Z" .

<https://bob.pod/card#me> foaf:name "Bob" ;
  foaf:img <javascript:alert(1)> .
`;

describe("createIndexClient — env gating", () => {
  it("returns null for an empty / whitespace origin (feature inert)", () => {
    expect(createIndexClient({ origin: "" })).toBeNull();
    expect(createIndexClient({ origin: "   " })).toBeNull();
    // @ts-expect-error — exercising the runtime ?? "" fallback for an undefined origin.
    expect(createIndexClient({ origin: undefined })).toBeNull();
  });

  it("strips a trailing slash and exposes the canonical origin", () => {
    const c = createIndexClient({ origin: `${ORIGIN}/` });
    expect(c?.origin).toBe(ORIGIN);
  });

  it("throws on an unparseable origin (a loud config error)", () => {
    expect(() => createIndexClient({ origin: "not a url" })).toThrow(/invalid origin/);
  });
});

describe("search — Hydra projection + photo guard", () => {
  it("projects members into UI-ready entries and resolves hydra:next", async () => {
    const fetch = rdfFetch(SEARCH_TTL);
    const client = createIndexClient({ origin: ORIGIN, fetch });
    const page = await client!.search("ada");

    expect(page.entries).toHaveLength(2);
    const ada = page.entries.find((e) => e.webid === "https://alice.pod/card#me");
    expect(ada).toEqual({
      webid: "https://alice.pod/card#me",
      name: "Ada Lovelace",
      photoUrl: "https://alice.pod/avatar.png",
      modified: "2026-01-01T00:00:00Z",
    });
    expect(page.next).toBe("https://idx.example/search?q=ada&page=2");
  });

  it("rejects a non-https foaf:img (javascript:/data:) to null", async () => {
    const fetch = rdfFetch(SEARCH_TTL);
    const client = createIndexClient({ origin: ORIGIN, fetch });
    const page = await client!.search("ada");
    const bob = page.entries.find((e) => e.webid === "https://bob.pod/card#me");
    expect(bob?.photoUrl).toBeNull();
  });

  it("sends the query (and limit) as params and omits credentials", async () => {
    const fetch = rdfFetch(SEARCH_TTL);
    const client = createIndexClient({ origin: ORIGIN, fetch });
    await client!.search("ada lovelace", { limit: 5 });
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.searchParams.get("q")).toBe("ada lovelace");
    expect(parsed.searchParams.get("limit")).toBe("5");
    expect((init as RequestInit).credentials).toBe("omit");
  });

  it("throws on a non-2xx search response", async () => {
    const fetch = rdfFetch("", { status: 503 });
    const client = createIndexClient({ origin: ORIGIN, fetch });
    await expect(client!.search("x")).rejects.toThrow(/failed: 503/);
  });
});

describe("fetchPage — same-origin guard", () => {
  it("follows a same-origin next URL verbatim", async () => {
    const fetch = rdfFetch(SEARCH_TTL);
    const client = createIndexClient({ origin: ORIGIN, fetch });
    const page = await client!.fetchPage(`${ORIGIN}/search?q=ada&page=2`);
    expect(page.entries.length).toBeGreaterThan(0);
  });

  it("REFUSES a cross-origin next URL (no fetch to a foreign host)", async () => {
    const fetch = rdfFetch(SEARCH_TTL);
    const client = createIndexClient({ origin: ORIGIN, fetch });
    await expect(client!.fetchPage("https://evil.example/steal")).rejects.toThrow(
      /cross-origin/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws on an unparseable next URL", async () => {
    const fetch = rdfFetch(SEARCH_TTL);
    const client = createIndexClient({ origin: ORIGIN, fetch });
    await expect(client!.fetchPage("::::")).rejects.toThrow(/invalid next URL/);
  });
});

describe("isIndexed — fail-closed JSON existence check", () => {
  function jsonFetch(body: unknown, status = 200) {
    return vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof globalThis.fetch;
  }

  it("true only when the JSON body says indexed:true", async () => {
    const fetch = jsonFetch({ indexed: true });
    const client = createIndexClient({ origin: ORIGIN, fetch });
    expect(await client!.isIndexed("https://alice.pod/card#me")).toBe(true);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(new URL(url as string).searchParams.get("format")).toBe("json");
    expect((init as RequestInit).redirect).toBe("error");
    expect((init as RequestInit).credentials).toBe("omit");
  });

  it("false when indexed is false / missing", async () => {
    const client = createIndexClient({ origin: ORIGIN, fetch: jsonFetch({ indexed: false }) });
    expect(await client!.isIndexed("https://a.pod/card#me")).toBe(false);
    const c2 = createIndexClient({ origin: ORIGIN, fetch: jsonFetch({}) });
    expect(await c2!.isIndexed("https://a.pod/card#me")).toBe(false);
  });

  it("fails closed (false) on a non-2xx, a network throw, or bad JSON", async () => {
    const c1 = createIndexClient({ origin: ORIGIN, fetch: jsonFetch({}, 400) });
    expect(await c1!.isIndexed("bad")).toBe(false);

    const throwing = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof globalThis.fetch;
    const c2 = createIndexClient({ origin: ORIGIN, fetch: throwing });
    expect(await c2!.isIndexed("https://a.pod/card#me")).toBe(false);
  });
});

describe("suggestWebId — validation + status mapping", () => {
  function statusFetch(status: number) {
    return vi.fn(async () => new Response(null, { status })) as unknown as typeof globalThis.fetch;
  }

  it("rejects a non-https / unparseable WebID without a network call", async () => {
    const fetch = statusFetch(201);
    const client = createIndexClient({ origin: ORIGIN, fetch });
    expect(await client!.suggestWebId("http://insecure.pod/card#me")).toBe("invalid");
    expect(await client!.suggestWebId("not a url")).toBe("invalid");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps inbox statuses to outcomes", async () => {
    const cases: Array<[number, string]> = [
      [201, "submitted"],
      [202, "submitted"],
      [200, "already-indexed"],
      [409, "already-indexed"],
      [429, "rate-limited"],
      [400, "invalid"],
      [415, "invalid"],
      [422, "invalid"],
      [413, "invalid"],
      [500, "error"],
    ];
    for (const [status, expected] of cases) {
      const client = createIndexClient({ origin: ORIGIN, fetch: statusFetch(status) });
      expect(await client!.suggestWebId("https://alice.pod/card#me")).toBe(expected);
    }
  });

  it("posts an AS2 Announce with the actor, omitting credentials", async () => {
    const fetch = statusFetch(201);
    const client = createIndexClient({ origin: ORIGIN, fetch });
    await client!.suggestWebId("https://alice.pod/card#me", {
      actor: "https://me.pod/card#me",
    });
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${ORIGIN}/inbox/`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "Announce",
      object: "https://alice.pod/card#me",
      actor: "https://me.pod/card#me",
    });
    expect((init as RequestInit).credentials).toBe("omit");
  });

  it("returns error (transient) on a network failure", async () => {
    const throwing = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof globalThis.fetch;
    const client = createIndexClient({ origin: ORIGIN, fetch: throwing });
    expect(await client!.suggestWebId("https://alice.pod/card#me")).toBe("error");
  });
});

describe("checkHealth", () => {
  it("normalises the health snapshot, defaulting degraded/unknown", async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ status: "ok", entries: 3, triples: 9, queueDepth: 1, version: "v2" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof globalThis.fetch;
    const client = createIndexClient({ origin: ORIGIN, fetch });
    expect(await client!.checkHealth()).toEqual({
      status: "ok",
      entries: 3,
      triples: 9,
      queueDepth: 1,
      version: "v2",
    });
  });
});
