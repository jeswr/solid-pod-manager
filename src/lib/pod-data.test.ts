import { describe, it, expect } from "vitest";
import { Parser, Store } from "n3";
import {
  summariseCategories,
  categoriesWithDataCount,
  listContainer,
  listCategoryItems,
  nameFromUrl,
  serializeTurtle,
  writeResource,
  type CategorySummary,
} from "./pod-data.js";
import { ResourceWriteError } from "./errors.js";
import type { RegisteredLocation } from "./type-index.js";

const SCHEMA = "https://schema.org/";

describe("summariseCategories", () => {
  it("includes every known category, marking which have data", () => {
    const locs: RegisteredLocation[] = [
      { forClass: `${SCHEMA}Event`, container: "https://a.example/calendar/" },
      { forClass: `${SCHEMA}ImageObject`, instance: "https://a.example/photos.ttl" },
    ];
    const summaries = summariseCategories(locs);

    const calendar = summaries.find((s) => s.category.id === "calendar");
    const media = summaries.find((s) => s.category.id === "media");
    const health = summaries.find((s) => s.category.id === "health");

    expect(calendar?.hasData).toBe(true);
    expect(media?.hasData).toBe(true);
    expect(health?.hasData).toBe(false); // present but empty → "add" CTA
    expect(categoriesWithDataCount(summaries)).toBe(2);
  });

  it("adds the Other bucket only when an unknown class lands there", () => {
    const withUnknown = summariseCategories([
      { forClass: "https://example.com/Widget", instance: "https://a.example/w.ttl" },
    ]);
    expect(withUnknown.some((s) => s.category.id === "other")).toBe(true);

    const withoutUnknown = summariseCategories([
      { forClass: `${SCHEMA}Event`, container: "https://a.example/cal/" },
    ]);
    expect(withoutUnknown.some((s) => s.category.id === "other")).toBe(false);
  });

  it("deduplicates identical registrations", () => {
    const dup: RegisteredLocation = {
      forClass: `${SCHEMA}Event`,
      container: "https://a.example/cal/",
    };
    const summaries = summariseCategories([dup, { ...dup }]);
    const calendar = summaries.find((s) => s.category.id === "calendar");
    expect(calendar?.locations).toHaveLength(1);
  });
});

describe("nameFromUrl", () => {
  it("uses the last path segment, decoded", () => {
    expect(nameFromUrl("https://a.example/media/holiday%20photo.jpg")).toBe(
      "holiday photo.jpg",
    );
    expect(nameFromUrl("https://a.example/calendar/")).toBe("calendar");
  });
  it("returns the input for an unparseable url", () => {
    expect(nameFromUrl("not a url")).toBe("not a url");
  });
});

const CONTAINER_TTL = (base: string) => `
@prefix ldp: <http://www.w3.org/ns/ldp#>.
@prefix dct: <http://purl.org/dc/terms/>.
@prefix stat: <http://www.w3.org/ns/posix/stat#>.
<${base}> a ldp:Container, ldp:BasicContainer ;
  ldp:contains <${base}events.ttl>, <${base}sub/> .
<${base}events.ttl> a ldp:Resource ;
  stat:size 1234 ; dct:modified "2026-01-02T03:04:05Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
<${base}sub/> a ldp:Container .
`;

describe("listContainer", () => {
  it("lists children, skips self, sorts containers first", async () => {
    const base = "https://a.example/calendar/";
    const fetchImpl: typeof fetch = async () =>
      new Response(CONTAINER_TTL(base), {
        status: 200,
        headers: { "content-type": "text/turtle" },
      });

    const items = await listContainer(base, fetchImpl);
    expect(items.map((i) => i.url)).not.toContain(base); // self excluded
    expect(items[0].isContainer).toBe(true); // container sorted first
    const file = items.find((i) => i.url.endsWith("events.ttl"));
    expect(file?.size).toBe(1234);
    expect(file?.modified).toBe("2026-01-02T03:04:05.000Z");
  });

  it("appends a trailing slash to a container url that lacks one", async () => {
    let requested = "";
    const fetchImpl: typeof fetch = async (input) => {
      requested = String(input);
      return new Response(CONTAINER_TTL("https://a.example/cal/"), {
        status: 200,
        headers: { "content-type": "text/turtle" },
      });
    };
    await listContainer("https://a.example/cal", fetchImpl);
    expect(requested).toBe("https://a.example/cal/");
  });
});

describe("listCategoryItems", () => {
  it("merges instance registrations and container listings", async () => {
    const summary: CategorySummary = {
      category: { id: "media" } as CategorySummary["category"],
      hasData: true,
      locations: [
        { forClass: `${SCHEMA}ImageObject`, instance: "https://a.example/cover.jpg" },
        { forClass: `${SCHEMA}ImageObject`, container: "https://a.example/album/" },
      ],
    };
    const fetchImpl: typeof fetch = async () =>
      new Response(CONTAINER_TTL("https://a.example/album/"), {
        status: 200,
        headers: { "content-type": "text/turtle" },
      });

    const items = await listCategoryItems(summary, fetchImpl);
    expect(items.some((i) => i.url === "https://a.example/cover.jpg")).toBe(true);
    expect(items.some((i) => i.url.endsWith("events.ttl"))).toBe(true);
  });
});

function datasetWithOneTriple(): Store {
  const store = new Store();
  store.addQuads(
    new Parser().parse(
      '<https://a.example/notes.ttl#it> <https://schema.org/name> "Hello" .',
    ),
  );
  return store;
}

describe("writeResource", () => {
  it("PUTs serialised Turtle with an explicit content-type", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      captured = { url: String(input), init: init ?? {} };
      return new Response(null, { status: 201, headers: { etag: '"v1"' } });
    };

    const { etag } = await writeResource(
      "https://a.example/notes.ttl",
      datasetWithOneTriple(),
      { fetchImpl },
    );

    expect(captured?.url).toBe("https://a.example/notes.ttl");
    expect(captured?.init.method).toBe("PUT");
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("text/turtle");
    expect(String(captured?.init.body)).toContain('"Hello"');
    expect(etag).toBe('"v1"');
  });

  it("sends If-Match / If-None-Match preconditions when asked", async () => {
    const seen: Record<string, string>[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response(null, { status: 205 });
    };
    const ds = datasetWithOneTriple();
    await writeResource("https://a.example/x.ttl", ds, { fetchImpl, etag: '"v7"' });
    await writeResource("https://a.example/x.ttl", ds, { fetchImpl, createOnly: true });
    expect(seen[0]["if-match"]).toBe('"v7"');
    expect(seen[1]["if-none-match"]).toBe("*");
  });

  it("throws a typed ResourceWriteError carrying the status", async () => {
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 412 });
    await expect(
      writeResource("https://a.example/x.ttl", datasetWithOneTriple(), { fetchImpl }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ResourceWriteError && e.status === 412,
    );
  });
});

describe("serializeTurtle", () => {
  it("round-trips the dataset content", async () => {
    const turtle = await serializeTurtle(datasetWithOneTriple(), {
      schema: "https://schema.org/",
    });
    expect(turtle).toContain("schema:name");
    expect(turtle).toContain('"Hello"');
  });
});
