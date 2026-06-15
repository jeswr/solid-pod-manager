// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import {
  parseBookmark,
  buildBookmark,
  bookmarksStore,
  normaliseTags,
  parseTagsInput,
  bookmarkHost,
  BOOKMARK_CLASS,
  type Bookmark,
} from "./bookmarks.js";
import { createMemoryPod, TEST_POD_ROOT, TEST_WEBID } from "./integrations/core/testing.js";

const url = `${TEST_POD_ROOT}bookmarks/b.ttl`;

describe("tag helpers", () => {
  it("trims, dedupes (case-insensitive) and drops blanks, order-preserving", () => {
    expect(normaliseTags([" Work ", "work", "", "Reading"])).toEqual(["Work", "Reading"]);
  });
  it("parses a comma/newline-separated input string", () => {
    expect(parseTagsInput("a, b\nc, a")).toEqual(["a", "b", "c"]);
    expect(parseTagsInput("   ")).toEqual([]);
  });
});

describe("bookmarkHost", () => {
  it("extracts the host, undefined for non-URLs", () => {
    expect(bookmarkHost("https://example.com/x")).toBe("example.com");
    expect(bookmarkHost("not a url")).toBeUndefined();
    expect(bookmarkHost(undefined)).toBeUndefined();
  });
});

describe("buildBookmark / parseBookmark round-trip", () => {
  it("preserves title, url, description and tags", () => {
    const ds = buildBookmark(url, {
      title: "Solid Project",
      url: "https://solidproject.org/",
      description: "The spec home",
      tags: ["solid", "spec"],
    });
    const b = parseBookmark(url, ds);
    expect(b?.title).toBe("Solid Project");
    expect(b?.url).toBe("https://solidproject.org/");
    expect(b?.description).toBe("The spec home");
    expect(b?.tags).toEqual(["solid", "spec"]);
  });

  it("stamps bookmark:Bookmark and writes recalls as an IRI", () => {
    const ds = buildBookmark(url, { title: "X", url: "https://x.test/", tags: [] });
    expect([...ds].some((q) => q.object.value === BOOKMARK_CLASS)).toBe(true);
    expect(
      [...ds].some(
        (q) => q.predicate.value.endsWith("recalls") && q.object.termType === "NamedNode",
      ),
    ).toBe(true);
  });

  it("handles a bookmark with no tags or description", () => {
    const ds = buildBookmark(url, { title: "", url: "https://min.test/", tags: [] });
    const b = parseBookmark(url, ds);
    expect(b?.url).toBe("https://min.test/");
    expect(b?.tags).toEqual([]);
    expect(b?.description).toBeUndefined();
  });

  it("returns undefined for a non-bookmark document", () => {
    const ds = buildBookmark(url, { title: "X", url: "https://x.test/", tags: [] });
    expect(parseBookmark(`${TEST_POD_ROOT}bookmarks/other.ttl`, ds)).toBeUndefined();
  });
});

describe("bookmarksStore (I/O)", () => {
  it("creates, updates and deletes a bookmark", async () => {
    const pod = createMemoryPod();
    const store = bookmarksStore({ podRoot: TEST_POD_ROOT, webId: TEST_WEBID, fetchImpl: pod.fetch });
    const bm: Bookmark = { title: "Example", url: "https://example.com/", tags: ["test"] };
    const { url: created, etag } = await store.create(bm, "Example");
    let items = await store.list();
    expect(items).toHaveLength(1);
    expect(items[0].data.tags).toEqual(["test"]);

    await store.update(created, { ...bm, title: "Example Updated" }, etag);
    const reread = await store.read(created);
    expect(reread?.data.title).toBe("Example Updated");

    await store.remove(created);
    items = await store.list();
    expect(items).toHaveLength(0);
  });
});
