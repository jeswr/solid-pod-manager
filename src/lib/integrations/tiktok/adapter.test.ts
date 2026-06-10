import { DataFactory } from "n3";
import { describe, expect, it } from "vitest";
import { demoImport, TEST_POD_ROOT } from "../core/testing.js";
import { CLASSES, MediaItem, SocialMediaPosting } from "../core/vocab.js";
import { tiktokAdapter } from "./adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/tiktok/`;
const MEDIA_DOC = `${ROOT}media/videos.ttl`;
const SOCIAL_DOC = `${ROOT}social/posts.ttl`;

describe("tiktok adapter contract", () => {
  it("writes videos as VideoObject (Media) and as SocialMediaPosting (Social)", async () => {
    const { pod, report } = await demoImport(tiktokAdapter);

    expect(report.written.map((w) => w.url).sort()).toEqual([MEDIA_DOC, SOCIAL_DOC]);
    expect(report.categories.sort()).toEqual(["media", "social"]);

    const media = pod.dataset(MEDIA_DOC);
    const clip = new MediaItem(`${MEDIA_DOC}#video-7341234567890123456`, media, DataFactory);
    expect(clip.types.has(CLASSES.VideoObject)).toBe(true);
    expect(clip.name).toBe("Sunrise timelapse");
    expect(clip.duration).toBe("PT17S");
    expect(clip.sourceUrl).toBe("https://www.tiktok.com/@user/video/7341234567890123456");

    const social = pod.dataset(SOCIAL_DOC);
    const post = new SocialMediaPosting(`${SOCIAL_DOC}#post-7341234567890123456`, social, DataFactory);
    expect(post.types.has(CLASSES.SocialMediaPosting)).toBe(true);
    expect(post.isPartOf).toBe("TikTok");
  });

  it("registers both classes into their containers", async () => {
    const { pod, report } = await demoImport(tiktokAdapter);
    const index = pod.get(report.indexUrl) ?? "";
    expect(index).toContain(CLASSES.VideoObject);
    expect(index).toContain(CLASSES.SocialMediaPosting);
  });

  it("is tier B with proxy token exchange", () => {
    expect(tiktokAdapter.metadata.tier).toBe("B");
    expect(tiktokAdapter.oauth?.tokenExchange).toBe("proxy");
  });

  it("re-import is idempotent", async () => {
    const { pod } = await demoImport(tiktokAdapter);
    const before = pod.urls();
    const sizeBefore = pod.dataset(MEDIA_DOC).size;
    await demoImport(tiktokAdapter, { pod });
    expect(pod.urls()).toEqual(before);
    expect(pod.dataset(MEDIA_DOC).size).toBe(sizeBefore);
  });
});
