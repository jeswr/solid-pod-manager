import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import {
  demoImport,
  expectCleanTurtle,
  sparseImport,
  TEST_POD_ROOT,
} from "../core/testing.js";
import { CLASSES, MusicPlaylist, MusicRecording } from "../core/vocab.js";
import { spotifyAdapter } from "./adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/spotify/`;
const TRACKS_DOC = `${ROOT}music/top-tracks.ttl`;
const LISTS_DOC = `${ROOT}music/playlists.ttl`;

describe("spotify adapter contract", () => {
  it("writes top tracks as typed schema:MusicRecording into Media", async () => {
    const { pod, report } = await demoImport(spotifyAdapter);

    expect(report.written.map((w) => w.url).sort()).toEqual([LISTS_DOC, TRACKS_DOC]);
    expect(report.categories).toEqual(["media"]);

    const ds = pod.dataset(TRACKS_DOC);
    const rick = new MusicRecording(`${TRACKS_DOC}#track-4uLU6hMCjMI75M1A2tKUQC`, ds, DataFactory);
    expect(rick.types.has(CLASSES.MusicRecording)).toBe(true);
    expect(rick.name).toBe("Never Gonna Give You Up");
    expect(rick.byArtist).toBe("Rick Astley");
    expect(rick.inAlbum).toBe("Whenever You Need Somebody");
    expect(rick.duration).toBe("PT3M34S");
    expect(rick.sourceUrl).toBe("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC");
  });

  it("writes playlists as schema:MusicPlaylist with track counts", async () => {
    const { pod } = await demoImport(spotifyAdapter);
    const ds = pod.dataset(LISTS_DOC);
    const focus = new MusicPlaylist(`${LISTS_DOC}#playlist-37i9dQZF1DXcBWIGoYBM5M`, ds, DataFactory);
    expect(focus.types.has(CLASSES.MusicPlaylist)).toBe(true);
    expect(focus.name).toBe("Focus Flow");
    expect(focus.numTracks).toBe(74);
  });

  it("registers both classes for the music container in the type index", async () => {
    const { pod, report } = await demoImport(spotifyAdapter);
    const index = pod.get(report.indexUrl) ?? "";
    expect(index).toContain(CLASSES.MusicRecording);
    expect(index).toContain(CLASSES.MusicPlaylist);
    expect(index).toContain(`${ROOT}music/`);
  });

  it("re-import is idempotent (same docs, no growth)", async () => {
    const { pod } = await demoImport(spotifyAdapter);
    const before = pod.urls();
    const sizeBefore = pod.dataset(TRACKS_DOC).size;
    await demoImport(spotifyAdapter, { pod });
    expect(pod.urls()).toEqual(before);
    expect(pod.dataset(TRACKS_DOC).size).toBe(sizeBefore);
  });

  // Regression for the live crash: GET /me/playlists returned items whose
  // `tracks` was absent (and a null entry), which the recorded fixtures never
  // exercised — `p.tracks.total` threw "Cannot read properties of undefined".
  it("survives a sparse live response (null entries, absent nested fields)", async () => {
    const { pod, report } = await sparseImport(spotifyAdapter, [
      {
        url: "https://api.spotify.com/v1/me/top/tracks",
        json: {
          items: [
            // Healthy track.
            {
              id: "ok1",
              name: "Good Track",
              duration_ms: 200000,
              artists: [{ name: "Real Artist" }],
              album: { name: "Real Album" },
              external_urls: { spotify: "https://open.spotify.com/track/ok1" },
            },
            // Missing album, null artist entry, absent external_urls/duration.
            { id: "ok2", name: "Bare Track", artists: [null, { name: "Solo" }] },
            null, // null array entry
            { name: "No Id" }, // no id ⇒ skipped
          ],
        },
      },
      {
        url: "https://api.spotify.com/v1/me/playlists",
        json: {
          items: [
            // The exact live shape: no `tracks` object at all.
            {
              id: "pl1",
              name: "No Tracks Object",
              external_urls: { spotify: "https://open.spotify.com/playlist/pl1" },
            },
            // tracks present but total null.
            { id: "pl2", name: "Null Total", description: null, tracks: { total: null } },
            null, // null playlist entry (lost collaborative access)
          ],
        },
      },
    ]);

    // Completed without throwing and wrote both documents.
    expect(report.written.map((w) => w.url).sort()).toEqual([LISTS_DOC, TRACKS_DOC]);
    // Three items lacked a stable id (null track, id-less track, null
    // playlist) → all skipped, none fatal.
    expect(report.skipped).toBe(3);

    // Both documents are valid Turtle with no leaked undefined/null literals.
    const tracks = expectCleanTurtle(pod, TRACKS_DOC);
    const lists = expectCleanTurtle(pod, LISTS_DOC);

    // The "no tracks object" playlist defaulted its count to 0 (not a crash).
    const pl1 = new MusicPlaylist(`${LISTS_DOC}#playlist-pl1`, lists, DataFactory);
    expect(pl1.numTracks).toBe(0);

    // The bare track kept its id, name and the one non-null artist.
    const bare = new MusicRecording(`${TRACKS_DOC}#track-ok2`, tracks, DataFactory);
    expect(bare.name).toBe("Bare Track");
    expect(bare.byArtist).toBe("Solo");
    expect(bare.inAlbum).toBeUndefined();
  });
});
