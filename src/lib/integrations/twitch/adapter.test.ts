import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import {
  demoImport,
  expectCleanTurtle,
  sparseImport,
  TEST_POD_ROOT,
} from "../core/testing.js";
import { CLASSES, WatchAction } from "../core/vocab.js";
import { twitchAdapter } from "./adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/twitch/`;
const DOC = `${ROOT}media/followed-channels.ttl`;

describe("twitch adapter contract", () => {
  it("writes followed channels as schema:WatchAction into Media", async () => {
    const { pod, report } = await demoImport(twitchAdapter);

    expect(report.written.map((w) => w.url)).toEqual([DOC]);
    expect(report.categories).toEqual(["media"]);

    const ds = pod.dataset(DOC);
    const follow = new WatchAction(`${DOC}#follow-71092938`, ds, DataFactory);
    expect(follow.types.has(CLASSES.WatchAction)).toBe(true);
    expect(follow.name).toBe("xQc");
    expect(follow.sourceUrl).toBe("https://www.twitch.tv/xqc");
    expect(follow.startTime?.toISOString()).toBe("2025-09-14T19:21:00.000Z");
  });

  it("registers WatchAction for the media container", async () => {
    const { pod, report } = await demoImport(twitchAdapter);
    const index = pod.get(report.indexUrl) ?? "";
    expect(index).toContain(CLASSES.WatchAction);
    expect(index).toContain(`${ROOT}media/`);
  });

  it("re-import is idempotent", async () => {
    const { pod } = await demoImport(twitchAdapter);
    const before = pod.urls();
    const sizeBefore = pod.dataset(DOC).size;
    await demoImport(twitchAdapter, { pod });
    expect(pod.urls()).toEqual(before);
    expect(pod.dataset(DOC).size).toBe(sizeBefore);
  });

  // Robustness: a follow may lack a login (→ no source URL) or a name, the
  // followed_at may be malformed, and the data array can carry a null.
  it("survives a sparse live response (null/partial follows)", async () => {
    const { pod, report } = await sparseImport(twitchAdapter, [
      {
        url: "https://api.twitch.tv/helix/users",
        json: { data: [{ id: "me1", login: "alice", display_name: "Alice" }] },
      },
      {
        url: "https://api.twitch.tv/helix/channels/followed",
        json: {
          data: [
            // No login (→ omit source URL), bad date (→ omit startTime).
            { broadcaster_id: "b1", broadcaster_name: "NoLogin", followed_at: "bad" },
            null, // null follow entry
            { broadcaster_name: "No Id" }, // no broadcaster id ⇒ skipped
          ],
        },
      },
    ]);

    expect(report.written.map((w) => w.url)).toEqual([DOC]);
    expect(report.skipped).toBe(2); // null entry + id-less follow

    const ds = expectCleanTurtle(pod, DOC);
    const b1 = new WatchAction(`${DOC}#follow-b1`, ds, DataFactory);
    expect(b1.name).toBe("NoLogin");
    expect(b1.sourceUrl).toBeUndefined(); // no login ⇒ no twitch.tv/undefined
    expect(b1.startTime).toBeUndefined(); // malformed date omitted
  });

  // An empty users.data is genuinely fatal (the follows endpoint needs our id),
  // and must fail loudly rather than throw a TypeError on `data[0].id`.
  it("fails cleanly when Twitch returns no user", async () => {
    await expect(
      sparseImport(twitchAdapter, [
        { url: "https://api.twitch.tv/helix/users", json: { data: [] } },
        { url: "https://api.twitch.tv/helix/channels/followed", json: { data: [] } },
      ]),
    ).rejects.toThrow(/user id/);
  });
});
