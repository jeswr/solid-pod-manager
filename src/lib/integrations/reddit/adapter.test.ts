import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import { demoImport, TEST_POD_ROOT } from "../core/testing.js";
import { CLASSES, Group, SocialMediaPosting } from "../core/vocab.js";
import { redditAdapter } from "./adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/reddit/`;
const SAVED_DOC = `${ROOT}social/saved-posts.ttl`;
const SUBS_DOC = `${ROOT}social/communities.ttl`;

describe("reddit adapter contract", () => {
  it("writes saved posts as schema:SocialMediaPosting into Social & interests", async () => {
    const { pod, report } = await demoImport(redditAdapter);

    expect(report.categories).toEqual(["social"]);
    const ds = pod.dataset(SAVED_DOC);
    const post = new SocialMediaPosting(`${SAVED_DOC}#post-1kx9wz`, ds, DataFactory);
    expect(post.types.has(CLASSES.SocialMediaPosting)).toBe(true);
    expect(post.headline).toBe("Solid pods explained for normal humans");
    expect(post.isPartOf).toBe("r/solidproject");
    expect(post.sourceUrl).toBe(
      "https://www.reddit.com/r/solidproject/comments/1kx9wz/solid_pods_explained/",
    );
    expect(post.datePublished?.getTime()).toBe(1748854800 * 1000);
  });

  it("writes subscribed subreddits as foaf:Group", async () => {
    const { pod } = await demoImport(redditAdapter);
    const ds = pod.dataset(SUBS_DOC);
    const sub = new Group(`${SUBS_DOC}#sub-Breadit`, ds, DataFactory);
    expect(sub.types.has(CLASSES.Group)).toBe(true);
    expect(sub.name).toBe("Breadit");
    expect(sub.description).toBe("A community for bread bakers.");
  });

  it("returns the newest saved fullname as the incremental cursor", async () => {
    const { report } = await demoImport(redditAdapter);
    expect(report.cursor).toBe("t3_1kx9wz");
  });

  it("registers both social classes for the social container", async () => {
    const { pod, report } = await demoImport(redditAdapter);
    const index = pod.get(report.indexUrl) ?? "";
    expect(index).toContain(CLASSES.SocialMediaPosting);
    expect(index).toContain(CLASSES.Group);
    expect(index).toContain(`${ROOT}social/`);
  });

  it("merge re-import with the cursor stays idempotent", async () => {
    const { pod, report } = await demoImport(redditAdapter);
    const sizeBefore = pod.dataset(SAVED_DOC).size;
    await demoImport(redditAdapter, { pod, cursor: report.cursor });
    expect(pod.dataset(SAVED_DOC).size).toBe(sizeBefore);
  });
});
