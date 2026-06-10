import { DataFactory } from "n3";
import { describe, expect, it } from "vitest";
import { demoImport, TEST_POD_ROOT } from "../core/testing.js";
import { CLASSES, Group, SocialMediaPosting } from "../core/vocab.js";
import { facebookAdapter } from "./adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/facebook/`;
const POSTS_DOC = `${ROOT}social/posts.ttl`;
const GROUPS_DOC = `${ROOT}social/groups.ttl`;

describe("facebook adapter contract", () => {
  it("writes posts as SocialMediaPosting and groups as foaf:Group into Social", async () => {
    const { pod, report } = await demoImport(facebookAdapter);

    expect(report.written.map((w) => w.url).sort()).toEqual([GROUPS_DOC, POSTS_DOC]);
    expect(report.categories).toEqual(["social"]);

    const posts = pod.dataset(POSTS_DOC);
    const post = new SocialMediaPosting(
      `${POSTS_DOC}#post-10221234567890123_10224567890123456`,
      posts,
      DataFactory,
    );
    expect(post.types.has(CLASSES.SocialMediaPosting)).toBe(true);
    expect(post.headline).toContain("mountains");
    expect(post.isPartOf).toBe("Facebook");

    const groups = pod.dataset(GROUPS_DOC);
    const grp = new Group(`${GROUPS_DOC}#group-284756192837465`, groups, DataFactory);
    expect(grp.types.has(CLASSES.Group)).toBe(true);
    expect(grp.name).toBe("Local Hiking Club");
  });

  it("registers both classes into the social containers", async () => {
    const { pod, report } = await demoImport(facebookAdapter);
    const index = pod.get(report.indexUrl) ?? "";
    expect(index).toContain(CLASSES.SocialMediaPosting);
    expect(index).toContain(CLASSES.Group);
  });

  it("is tier B with proxy token exchange", () => {
    expect(facebookAdapter.metadata.tier).toBe("B");
    expect(facebookAdapter.oauth?.tokenExchange).toBe("proxy");
  });

  it("re-import is idempotent", async () => {
    const { pod } = await demoImport(facebookAdapter);
    const before = pod.urls();
    const sizeBefore = pod.dataset(POSTS_DOC).size;
    await demoImport(facebookAdapter, { pod });
    expect(pod.urls()).toEqual(before);
    expect(pod.dataset(POSTS_DOC).size).toBe(sizeBefore);
  });
});
