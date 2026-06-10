import { DataFactory } from "n3";
import { describe, expect, it } from "vitest";
import { demoImport, TEST_POD_ROOT } from "../core/testing.js";
import { CLASSES, SocialMediaPosting } from "../core/vocab.js";
import { xTwitterAdapter } from "./adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/x-twitter/`;
const POSTS_DOC = `${ROOT}social/posts.ttl`;

describe("x-twitter adapter contract", () => {
  it("writes tweets as typed schema:SocialMediaPosting into Social", async () => {
    const { pod, report } = await demoImport(xTwitterAdapter);

    expect(report.written.map((w) => w.url)).toEqual([POSTS_DOC]);
    expect(report.categories).toEqual(["social"]);

    const ds = pod.dataset(POSTS_DOC);
    const post = new SocialMediaPosting(`${POSTS_DOC}#post-1789012345678901234`, ds, DataFactory);
    expect(post.types.has(CLASSES.SocialMediaPosting)).toBe(true);
    expect(post.headline).toContain("data portability");
    expect(post.isPartOf).toBe("X");
    expect(post.sourceUrl).toBe("https://x.com/i/web/status/1789012345678901234");
    expect(post.datePublished?.toISOString()).toBe("2026-05-19T14:22:07.000Z");
  });

  it("registers SocialMediaPosting for the social container", async () => {
    const { pod, report } = await demoImport(xTwitterAdapter);
    const index = pod.get(report.indexUrl) ?? "";
    expect(index).toContain(CLASSES.SocialMediaPosting);
    expect(index).toContain(`${ROOT}social/`);
  });

  it("is tier B with public (PKCE) token exchange", () => {
    expect(xTwitterAdapter.metadata.tier).toBe("B");
    expect(xTwitterAdapter.oauth?.tokenExchange).toBe("public");
  });

  it("re-import is idempotent", async () => {
    const { pod } = await demoImport(xTwitterAdapter);
    const before = pod.urls();
    const sizeBefore = pod.dataset(POSTS_DOC).size;
    await demoImport(xTwitterAdapter, { pod });
    expect(pod.urls()).toEqual(before);
    expect(pod.dataset(POSTS_DOC).size).toBe(sizeBefore);
  });
});
