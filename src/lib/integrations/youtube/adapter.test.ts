import { DataFactory } from "n3";
import { describe, expect, it } from "vitest";
import { demoImport, TEST_POD_ROOT } from "../core/testing.js";
import { CLASSES, MediaItem, MusicPlaylist } from "../core/vocab.js";
import { youtubeAdapter } from "./adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/youtube/`;
const VIDEOS_DOC = `${ROOT}media/videos.ttl`;
const LISTS_DOC = `${ROOT}media/playlists.ttl`;

describe("youtube adapter contract", () => {
  it("writes liked videos as typed schema:VideoObject into Media", async () => {
    const { pod, report } = await demoImport(youtubeAdapter);

    expect(report.written.map((w) => w.url).sort()).toEqual([LISTS_DOC, VIDEOS_DOC]);
    expect(report.categories).toEqual(["media"]);

    const ds = pod.dataset(VIDEOS_DOC);
    const rick = new MediaItem(`${VIDEOS_DOC}#video-dQw4w9WgXcQ`, ds, DataFactory);
    expect(rick.types.has(CLASSES.VideoObject)).toBe(true);
    expect(rick.name).toBe("Rick Astley - Never Gonna Give You Up (Official Video)");
    expect(rick.duration).toBe("PT3M33S");
    expect(rick.sourceUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("writes playlists as schema:MusicPlaylist with item counts", async () => {
    const { pod } = await demoImport(youtubeAdapter);
    const ds = pod.dataset(LISTS_DOC);
    const watch = new MusicPlaylist(`${LISTS_DOC}#playlist-PLrAXtmRdnEQy6nuLMHjMZOz59O`, ds, DataFactory);
    expect(watch.types.has(CLASSES.MusicPlaylist)).toBe(true);
    expect(watch.name).toBe("Watch later");
    expect(watch.numTracks).toBe(42);
  });

  it("registers both classes for the media container", async () => {
    const { pod, report } = await demoImport(youtubeAdapter);
    const index = pod.get(report.indexUrl) ?? "";
    expect(index).toContain(CLASSES.VideoObject);
    expect(index).toContain(CLASSES.MusicPlaylist);
    expect(index).toContain(`${ROOT}media/`);
  });

  it("is tier B with proxy token exchange", () => {
    expect(youtubeAdapter.metadata.tier).toBe("B");
    expect(youtubeAdapter.oauth?.tokenExchange).toBe("proxy");
  });

  it("re-import is idempotent", async () => {
    const { pod } = await demoImport(youtubeAdapter);
    const before = pod.urls();
    const sizeBefore = pod.dataset(VIDEOS_DOC).size;
    await demoImport(youtubeAdapter, { pod });
    expect(pod.urls()).toEqual(before);
    expect(pod.dataset(VIDEOS_DOC).size).toBe(sizeBefore);
  });
});
