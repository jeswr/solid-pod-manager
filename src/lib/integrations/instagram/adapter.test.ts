import { DataFactory } from "n3";
import { describe, expect, it } from "vitest";
import { demoImport, TEST_POD_ROOT } from "../core/testing.js";
import { CLASSES, MediaItem, SocialMediaPosting } from "../core/vocab.js";
import { instagramAdapter } from "./adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/instagram/`;
const MEDIA_DOC = `${ROOT}media/posts.ttl`;
const SOCIAL_DOC = `${ROOT}social/posts.ttl`;

describe("instagram adapter contract", () => {
  it("writes posts as media (ImageObject/VideoObject) and as SocialMediaPosting", async () => {
    const { pod, report } = await demoImport(instagramAdapter);

    expect(report.written.map((w) => w.url).sort()).toEqual([MEDIA_DOC, SOCIAL_DOC]);
    expect(report.categories.sort()).toEqual(["media", "social"]);

    const media = pod.dataset(MEDIA_DOC);
    const photo = new MediaItem(`${MEDIA_DOC}#media-17895695668004550`, media, DataFactory);
    expect(photo.types.has(CLASSES.ImageObject)).toBe(true);
    expect(photo.name).toBe("Golden hour at the coast 🌅 #sunset");
    expect(photo.sourceUrl).toBe("https://www.instagram.com/p/CqL8z3kAbCd/");

    const reel = new MediaItem(`${MEDIA_DOC}#media-17912345678901234`, media, DataFactory);
    expect(reel.types.has(CLASSES.VideoObject)).toBe(true);

    const social = pod.dataset(SOCIAL_DOC);
    const post = new SocialMediaPosting(`${SOCIAL_DOC}#post-17895695668004550`, social, DataFactory);
    expect(post.types.has(CLASSES.SocialMediaPosting)).toBe(true);
    expect(post.isPartOf).toBe("Instagram");
  });

  it("registers both classes into their containers", async () => {
    const { pod, report } = await demoImport(instagramAdapter);
    const index = pod.get(report.indexUrl) ?? "";
    expect(index).toContain(CLASSES.ImageObject);
    expect(index).toContain(CLASSES.SocialMediaPosting);
  });

  it("is tier B with proxy token exchange", () => {
    expect(instagramAdapter.metadata.tier).toBe("B");
    expect(instagramAdapter.oauth?.tokenExchange).toBe("proxy");
  });

  it("re-import is idempotent", async () => {
    const { pod } = await demoImport(instagramAdapter);
    const before = pod.urls();
    const sizeBefore = pod.dataset(MEDIA_DOC).size;
    await demoImport(instagramAdapter, { pod });
    expect(pod.urls()).toEqual(before);
    expect(pod.dataset(MEDIA_DOC).size).toBe(sizeBefore);
  });
});
