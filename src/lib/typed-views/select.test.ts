// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import { collectTypes, buildViewerContext, selectTypedViewer } from "./select.js";
import type { TypedViewer, ViewerContext } from "./types.js";

const URL = "https://alice.example/data/x.ttl";

async function ctx(turtle: string, categoryId?: string): Promise<ViewerContext> {
  const ds = await parseRdf(turtle, "text/turtle", { baseIRI: URL });
  return buildViewerContext(URL, ds, categoryId);
}

/** A trivial viewer that matches when a given type is present. */
function typeViewer(id: string, priority: number, type: string): TypedViewer {
  return {
    id,
    priority,
    matches: (c) => c.types.has(type),
    extract: () => ({ id }),
  };
}

describe("collectTypes", () => {
  it("collects every rdf:type IRI across subjects", async () => {
    const ds = await parseRdf(
      `@prefix schema: <https://schema.org/>.
       <${URL}#a> a schema:MusicRecording .
       <${URL}#b> a schema:MusicPlaylist .`,
      "text/turtle",
      { baseIRI: URL },
    );
    const types = collectTypes(ds);
    expect(types.has("https://schema.org/MusicRecording")).toBe(true);
    expect(types.has("https://schema.org/MusicPlaylist")).toBe(true);
    expect(types.size).toBe(2);
  });
});

describe("selectTypedViewer", () => {
  const music = typeViewer("music", 70, "https://schema.org/MusicRecording");
  const photo = typeViewer("photo", 60, "https://schema.org/ImageObject");

  it("returns undefined when nothing matches → caller falls back to RdfViewer", async () => {
    const c = await ctx(`@prefix foaf: <http://xmlns.com/foaf/0.1/>. <${URL}#a> a foaf:Document .`);
    expect(selectTypedViewer(c, [music, photo])).toBeUndefined();
  });

  it("picks the only matching viewer", async () => {
    const c = await ctx(`@prefix schema: <https://schema.org/>. <${URL}#a> a schema:ImageObject .`);
    expect(selectTypedViewer(c, [music, photo])?.id).toBe("photo");
  });

  it("picks the highest priority among several matches", async () => {
    const c = await ctx(
      `@prefix schema: <https://schema.org/>.
       <${URL}#a> a schema:MusicRecording .
       <${URL}#b> a schema:ImageObject .`,
    );
    expect(selectTypedViewer(c, [photo, music])?.id).toBe("music"); // 70 > 60
  });

  it("breaks priority ties by registration order (earlier wins)", async () => {
    const a = typeViewer("a", 70, "https://schema.org/Thing");
    const b = typeViewer("b", 70, "https://schema.org/Thing");
    const c = await ctx(`@prefix schema: <https://schema.org/>. <${URL}#a> a schema:Thing .`);
    expect(selectTypedViewer(c, [a, b])?.id).toBe("a");
    expect(selectTypedViewer(c, [b, a])?.id).toBe("b");
  });
});
