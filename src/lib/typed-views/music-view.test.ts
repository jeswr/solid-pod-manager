// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import { demoImport, TEST_POD_ROOT } from "../integrations/core/testing.js";
import { spotifyAdapter } from "../integrations/spotify/adapter.js";
import { musicViewer, humanizeDuration, type MusicModel } from "./music-view.js";
import { contactsViewer } from "./contacts-view.js";
import { buildViewerContext, selectTypedViewer } from "./select.js";
import { buildContact } from "../contacts.js";
import type { ViewerContext } from "./types.js";

const TRACKS_DOC = `${TEST_POD_ROOT}integrations/spotify/music/top-tracks.ttl`;
const URL = "https://alice.example/music/m.ttl";

async function ctxFromTurtle(turtle: string, url = URL): Promise<ViewerContext> {
  const ds = await parseRdf(turtle, "text/turtle", { baseIRI: url });
  return buildViewerContext(url, ds);
}

/** Real Spotify adapter output — drive the adapter over its recorded fixtures. */
async function realTopTracksCtx(): Promise<ViewerContext> {
  const { pod } = await demoImport(spotifyAdapter);
  const turtle = pod.get(TRACKS_DOC) ?? "";
  return ctxFromTurtle(turtle, TRACKS_DOC);
}

describe("musicViewer.matches", () => {
  it("matches a schema:MusicRecording document (the class Spotify writes)", async () => {
    expect(musicViewer.matches(await realTopTracksCtx())).toBe(true);
  });

  it("matches a schema:MusicPlaylist document", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <https://schema.org/>. <${URL}#p> a schema:MusicPlaylist ; schema:name "Focus" .`,
    );
    expect(musicViewer.matches(c)).toBe(true);
  });

  it("matches the legacy http://schema.org/ scheme", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <http://schema.org/>. <${URL}#a> a schema:MusicRecording ; schema:name "X" .`,
    );
    expect(musicViewer.matches(c)).toBe(true);
  });

  it("matches an untyped subject by the schema:byArtist signature predicate (shape rescue)", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <https://schema.org/>. <${URL}#a> schema:byArtist "Some Artist" .`,
    );
    expect(musicViewer.matches(c)).toBe(true);
  });

  it("does not match an unrelated (contacts) document", async () => {
    const ds = buildContact(URL, { fn: "Ada Lovelace", email: "ada@example.com" });
    expect(musicViewer.matches(buildViewerContext(URL, ds))).toBe(false);
  });
});

describe("musicViewer.extract", () => {
  it("extracts title/artist/album/duration from real adapter output", async () => {
    const { items } = musicViewer.extract(await realTopTracksCtx());
    expect(items).toHaveLength(3);
    const rick = items.find((t) => t.id.endsWith("#track-4uLU6hMCjMI75M1A2tKUQC"));
    expect(rick).toBeDefined();
    expect(rick?.title).toBe("Never Gonna Give You Up");
    expect(rick?.artist).toBe("Rick Astley");
    expect(rick?.album).toBe("Whenever You Need Somebody");
    // 213573 ms → adapter writes PT3M34S.
    expect(rick?.duration).toBe("PT3M34S");
  });

  it("derives the Open-in-Spotify action and suppresses the raw URL", async () => {
    const { items } = musicViewer.extract(await realTopTracksCtx());
    const rick = items.find((t) => t.id.endsWith("#track-4uLU6hMCjMI75M1A2tKUQC"));
    // The source action is derived (schema:url → "Open in Spotify")…
    expect(rick?.source?.id).toBe("spotify");
    expect(rick?.source?.label).toBe("Open in Spotify");
    expect(rick?.source?.href).toBe(
      "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
    );
    // …and the model carries NO raw `url`/`sourceUrl` field — only the action.
    expect(rick).not.toHaveProperty("url");
    expect(rick).not.toHaveProperty("sourceUrl");
  });

  it("sorts tracks by title for a stable, human order", async () => {
    const { items } = musicViewer.extract(await realTopTracksCtx());
    expect(items.map((t) => t.title)).toEqual([
      "Blinding Lights",
      "Never Gonna Give You Up",
      "Walking on a Dream",
    ]);
  });

  it("falls back to 'Untitled track' when schema:name is absent", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <https://schema.org/>. <${URL}#a> a schema:MusicRecording ; schema:byArtist "Anon" .`,
    );
    const { items } = musicViewer.extract(c);
    expect(items[0].title).toBe("Untitled track");
    expect(items[0].artist).toBe("Anon");
  });

  it("leaves source undefined for an unrecognised host (no raw-URL row)", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <https://schema.org/>.
       <${URL}#a> a schema:MusicRecording ; schema:name "Local" ;
         schema:url <https://example.com/x> .`,
    );
    expect(musicViewer.extract(c).items[0].source).toBeUndefined();
  });
});

describe("musicViewer cover art (art-absent fallback vs art-present)", () => {
  it("imageUrl is undefined for today's real adapter output (no art triple imported)", async () => {
    const { items } = musicViewer.extract(await realTopTracksCtx());
    for (const t of items) expect(t.imageUrl).toBeUndefined();
  });

  it("reads schema:image when present (lights up once art is imported)", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <https://schema.org/>.
       <${URL}#a> a schema:MusicRecording ; schema:name "Song" ;
         schema:image <https://i.scdn.co/image/cover.jpg> .`,
    );
    expect(musicViewer.extract(c).items[0].imageUrl).toBe(
      "https://i.scdn.co/image/cover.jpg",
    );
  });

  it("reads schema:thumbnailUrl as an alternative art triple", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <https://schema.org/>.
       <${URL}#a> a schema:MusicRecording ; schema:name "Song" ;
         schema:thumbnailUrl <https://i.scdn.co/image/thumb.jpg> .`,
    );
    expect(musicViewer.extract(c).items[0].imageUrl).toBe(
      "https://i.scdn.co/image/thumb.jpg",
    );
  });
});

describe("humanizeDuration", () => {
  it("formats minutes:seconds", () => {
    expect(humanizeDuration("PT3M34S")).toBe("3:34");
    expect(humanizeDuration("PT0M9S")).toBe("0:09");
    expect(humanizeDuration("PT45S")).toBe("0:45");
  });

  it("formats hours:minutes:seconds", () => {
    expect(humanizeDuration("PT1H2M3S")).toBe("1:02:03");
  });

  it("returns undefined for absent/unparsable input", () => {
    expect(humanizeDuration(undefined)).toBeUndefined();
    expect(humanizeDuration("")).toBeUndefined();
    expect(humanizeDuration("3:34")).toBeUndefined();
    expect(humanizeDuration("PT")).toBeUndefined();
  });
});

describe("selection precedence (Music vs Contacts + fallback)", () => {
  it("a MusicRecording document selects the music viewer, not contacts", async () => {
    const c = await realTopTracksCtx();
    expect(selectTypedViewer(c)?.id).toBe("music");
  });

  it("a contacts document selects contacts, not music (disjoint shapes)", () => {
    const ds = buildContact(URL, { fn: "Ada Lovelace", email: "ada@example.com" });
    expect(selectTypedViewer(buildViewerContext(URL, ds))?.id).toBe("contacts");
  });

  it("an unknown shape selects nothing → caller falls back to RdfViewer", async () => {
    const c = await ctxFromTurtle(
      `@prefix foaf: <http://xmlns.com/foaf/0.1/>. <${URL}#a> a foaf:Document .`,
    );
    expect(selectTypedViewer(c)).toBeUndefined();
  });

  it("music and contacts share priority 70 (the registry tie-break never decides between them)", () => {
    expect(musicViewer.priority).toBe(contactsViewer.priority);
    const _m: MusicModel = musicViewer.extract(buildViewerContext(URL, buildContact(URL, { fn: "x" })));
    expect(_m.items).toEqual([]); // music extractor finds no recordings in a contact doc
  });
});
