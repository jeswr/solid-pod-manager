// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
//
// No integration writes bookmarks today, so these tests target the **generic
// interop shape** standard Solid bookmark apps (and SolidOS) write:
// `bookmark:Bookmark` + `bookmark:recalls` + `dct:title` (design §2.2). This is
// deliberately the externally-authored shape, not an app-internal one.
import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import { bookmarkViewer, type BookmarkModel } from "./bookmark-view.js";
import { buildContact } from "../contacts.js";
import { buildViewerContext, selectTypedViewer } from "./select.js";
import type { ViewerContext } from "./types.js";

const URL = "https://alice.example/bookmarks/b.ttl";

const PREFIXES = `@prefix bookmark: <http://www.w3.org/2002/01/bookmark#>.
@prefix dct: <http://purl.org/dc/terms/>.
@prefix dc: <http://purl.org/dc/elements/1.1/>.
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>.
@prefix schema: <https://schema.org/>.
`;

async function ctxFromTurtle(turtle: string, url = URL): Promise<ViewerContext> {
  const ds = await parseRdf(`${PREFIXES}${turtle}`, "text/turtle", { baseIRI: url });
  return buildViewerContext(url, ds);
}

/** The canonical generic-bookmark document a Solid bookmark app writes. */
const TYPICAL = `<${URL}#one> a bookmark:Bookmark ;
  dct:title "Solid Project" ;
  bookmark:recalls <https://solidproject.org/> .
<${URL}#two> a bookmark:Bookmark ;
  dct:title "Awesome Solid" ;
  bookmark:recalls <https://github.com/solid/awesome-solid> .`;

describe("bookmarkViewer.matches", () => {
  it("matches a bookmark:Bookmark document (the generic interop class)", async () => {
    expect(bookmarkViewer.matches(await ctxFromTurtle(TYPICAL))).toBe(true);
  });

  it("matches an untyped subject by the bookmark:recalls signature predicate (shape rescue)", async () => {
    const c = await ctxFromTurtle(`<${URL}#x> bookmark:recalls <https://example.org/page> .`);
    expect(bookmarkViewer.matches(c)).toBe(true);
  });

  it("does NOT match a document that only carries schema:url (would over-match — every integration writes it)", async () => {
    const c = await ctxFromTurtle(`<${URL}#x> a schema:Thing ; schema:url <https://example.org/> .`);
    expect(bookmarkViewer.matches(c)).toBe(false);
  });

  it("does not match an unrelated (contacts) document", () => {
    const ds = buildContact(URL, { fn: "Ada Lovelace" });
    expect(bookmarkViewer.matches(buildViewerContext(URL, ds))).toBe(false);
  });
});

describe("bookmarkViewer.extract", () => {
  it("extracts title + safe href + host from the canonical shape", async () => {
    const { items } = bookmarkViewer.extract(await ctxFromTurtle(TYPICAL));
    expect(items).toHaveLength(2);
    const solid = items.find((b) => b.title === "Solid Project");
    expect(solid?.href).toBe("https://solidproject.org/");
    expect(solid?.host).toBe("solidproject.org");
  });

  it("accepts schema:url as the link (the predicate this app uses + the P3 task names)", async () => {
    const c = await ctxFromTurtle(
      `<${URL}#x> a bookmark:Bookmark ; dct:title "Via schema:url" ; schema:url <https://example.org/page> .`,
    );
    const b = bookmarkViewer.extract(c).items[0];
    expect(b.href).toBe("https://example.org/page");
    expect(b.host).toBe("example.org");
  });

  it("prefers bookmark:recalls over schema:url when both are present", async () => {
    const c = await ctxFromTurtle(
      `<${URL}#x> a bookmark:Bookmark ; dct:title "Both" ;
        bookmark:recalls <https://recalls.example/> ; schema:url <https://schema.example/> .`,
    );
    expect(bookmarkViewer.extract(c).items[0].href).toBe("https://recalls.example/");
  });

  it("reads dc:title / rdfs:label / schema:name as title fallbacks", async () => {
    const dc = await ctxFromTurtle(
      `<${URL}#a> a bookmark:Bookmark ; dc:title "DC titled" ; bookmark:recalls <https://a.example/> .`,
    );
    expect(dc.dataset && bookmarkViewer.extract(dc).items[0].title).toBe("DC titled");
    const label = await ctxFromTurtle(
      `<${URL}#b> a bookmark:Bookmark ; rdfs:label "Labelled" ; bookmark:recalls <https://b.example/> .`,
    );
    expect(bookmarkViewer.extract(label).items[0].title).toBe("Labelled");
    const name = await ctxFromTurtle(
      `<${URL}#c> a bookmark:Bookmark ; schema:name "Named" ; bookmark:recalls <https://c.example/> .`,
    );
    expect(bookmarkViewer.extract(name).items[0].title).toBe("Named");
  });

  it("falls back to the host as the title when no title triple exists", async () => {
    const c = await ctxFromTurtle(
      `<${URL}#x> a bookmark:Bookmark ; bookmark:recalls <https://news.ycombinator.com/> .`,
    );
    expect(bookmarkViewer.extract(c).items[0].title).toBe("news.ycombinator.com");
  });

  it("falls back to 'Untitled bookmark' when neither title nor a usable link exists", async () => {
    const c = await ctxFromTurtle(`<${URL}#x> a bookmark:Bookmark .`);
    const b = bookmarkViewer.extract(c).items[0];
    expect(b.title).toBe("Untitled bookmark");
    expect(b.href).toBeUndefined();
    expect(b.host).toBeUndefined();
  });

  it("rejects an unsafe (non-http) recalls link (safety: no javascript:/data:)", async () => {
    const c = await ctxFromTurtle(
      `<${URL}#x> a bookmark:Bookmark ; dct:title "Evil" ; bookmark:recalls <mailto:a@b.com> .`,
    );
    // mailto is not a navigable bookmark target → no href, title preserved.
    const b = bookmarkViewer.extract(c).items[0];
    expect(b.href).toBeUndefined();
    expect(b.title).toBe("Evil");
  });

  it("accepts a recalls value written as a string literal (some apps do)", async () => {
    const c = await ctxFromTurtle(
      `<${URL}#x> a bookmark:Bookmark ; dct:title "Literal link" ; bookmark:recalls "https://lit.example/" .`,
    );
    expect(bookmarkViewer.extract(c).items[0].href).toBe("https://lit.example/");
  });

  it("sorts bookmarks by title for a stable, human order", async () => {
    const { items } = bookmarkViewer.extract(await ctxFromTurtle(TYPICAL));
    expect(items.map((b) => b.title)).toEqual(["Awesome Solid", "Solid Project"]);
  });
});

describe("selection precedence (Bookmark vs others)", () => {
  it("a bookmark document selects the bookmark viewer", async () => {
    expect(selectTypedViewer(await ctxFromTurtle(TYPICAL))?.id).toBe("bookmark");
  });

  it("bookmark viewer sits at priority 60", () => {
    expect(bookmarkViewer.priority).toBe(60);
  });

  it("a contacts document does not select the bookmark viewer", () => {
    const ds = buildContact(URL, { fn: "Grace Hopper" });
    const _m: BookmarkModel = bookmarkViewer.extract(buildViewerContext(URL, ds));
    expect(_m.items).toEqual([]);
  });
});
