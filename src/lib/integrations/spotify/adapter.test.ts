import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import { demoImport, TEST_POD_ROOT } from "../core/testing.js";
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
});
