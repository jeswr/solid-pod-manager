import { DataFactory } from "n3";
import { describe, expect, it } from "vitest";
import { demoImport, TEST_POD_ROOT } from "../core/testing.js";
import { CLASSES, MediaItem, SocialMediaPosting } from "../core/vocab.js";
import { pinterestAdapter } from "./adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/pinterest/`;
const MEDIA_DOC = `${ROOT}media/pins.ttl`;
const SOCIAL_DOC = `${ROOT}social/pins.ttl`;

describe("pinterest adapter contract", () => {
  it("writes pins as ImageObject (Media) and SocialMediaPosting (Social) tagged by board", async () => {
    const { pod, report } = await demoImport(pinterestAdapter);

    expect(report.written.map((w) => w.url).sort()).toEqual([MEDIA_DOC, SOCIAL_DOC]);
    expect(report.categories.sort()).toEqual(["media", "social"]);

    const media = pod.dataset(MEDIA_DOC);
    const pin = new MediaItem(`${MEDIA_DOC}#pin-813034246246243478`, media, DataFactory);
    expect(pin.types.has(CLASSES.ImageObject)).toBe(true);
    expect(pin.name).toBe("Mid-century desk setup");
    expect(pin.contentUrl).toBe("https://i.pinimg.com/600x/ab/cd/ef.jpg");
    expect(pin.width).toBe(600);

    const social = pod.dataset(SOCIAL_DOC);
    const post = new SocialMediaPosting(`${SOCIAL_DOC}#pin-813034246246243478`, social, DataFactory);
    expect(post.types.has(CLASSES.SocialMediaPosting)).toBe(true);
    expect(post.isPartOf).toBe("Pinterest · Home office");
  });

  it("registers both classes into their containers", async () => {
    const { pod, report } = await demoImport(pinterestAdapter);
    const index = pod.get(report.indexUrl) ?? "";
    expect(index).toContain(CLASSES.ImageObject);
    expect(index).toContain(CLASSES.SocialMediaPosting);
  });

  it("is tier B with proxy token exchange", () => {
    expect(pinterestAdapter.metadata.tier).toBe("B");
    expect(pinterestAdapter.oauth?.tokenExchange).toBe("proxy");
  });

  it("re-import is idempotent", async () => {
    const { pod } = await demoImport(pinterestAdapter);
    const before = pod.urls();
    const sizeBefore = pod.dataset(MEDIA_DOC).size;
    await demoImport(pinterestAdapter, { pod });
    expect(pod.urls()).toEqual(before);
    expect(pod.dataset(MEDIA_DOC).size).toBe(sizeBefore);
  });
});
