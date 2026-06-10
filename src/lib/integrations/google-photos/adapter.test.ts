import { DataFactory } from "n3";
import { describe, expect, it } from "vitest";
import { demoImport, TEST_POD_ROOT } from "../core/testing.js";
import { CLASSES, MediaItem } from "../core/vocab.js";
import { googlePhotosAdapter } from "./adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/google-photos/`;
const PHOTOS_DOC = `${ROOT}media/photos.ttl`;

describe("google-photos adapter contract", () => {
  it("writes photos as typed schema:ImageObject into Media", async () => {
    const { pod, report } = await demoImport(googlePhotosAdapter);

    expect(report.written.map((w) => w.url)).toEqual([PHOTOS_DOC]);
    expect(report.categories).toEqual(["media"]);

    const ds = pod.dataset(PHOTOS_DOC);
    const sunset = new MediaItem(`${PHOTOS_DOC}#media-AGj1epU8f9k2mNq`, ds, DataFactory);
    expect(sunset.types.has(CLASSES.ImageObject)).toBe(true);
    expect(sunset.name).toBe("IMG_4821.jpg");
    expect(sunset.description).toBe("Sunset over the bay");
    expect(sunset.encodingFormat).toBe("image/jpeg");
    expect(sunset.width).toBe(4032);
    expect(sunset.height).toBe(3024);
    expect(sunset.contentUrl).toBe("https://lh3.googleusercontent.com/lr/AGj1epU8f9k2mNq");
  });

  it("stamps videos as schema:VideoObject", async () => {
    const { pod } = await demoImport(googlePhotosAdapter);
    const ds = pod.dataset(PHOTOS_DOC);
    const vid = new MediaItem(`${PHOTOS_DOC}#media-CIl3grW0h1m4pPs`, ds, DataFactory);
    expect(vid.types.has(CLASSES.VideoObject)).toBe(true);
    expect(vid.encodingFormat).toBe("video/mp4");
  });

  it("registers ImageObject for the media container", async () => {
    const { pod, report } = await demoImport(googlePhotosAdapter);
    const index = pod.get(report.indexUrl) ?? "";
    expect(index).toContain(CLASSES.ImageObject);
    expect(index).toContain(`${ROOT}media/`);
  });

  it("is tier B with proxy token exchange", () => {
    expect(googlePhotosAdapter.metadata.tier).toBe("B");
    expect(googlePhotosAdapter.oauth?.tokenExchange).toBe("proxy");
  });

  it("re-import is idempotent", async () => {
    const { pod } = await demoImport(googlePhotosAdapter);
    const before = pod.urls();
    const sizeBefore = pod.dataset(PHOTOS_DOC).size;
    await demoImport(googlePhotosAdapter, { pod });
    expect(pod.urls()).toEqual(before);
    expect(pod.dataset(PHOTOS_DOC).size).toBe(sizeBefore);
  });
});
