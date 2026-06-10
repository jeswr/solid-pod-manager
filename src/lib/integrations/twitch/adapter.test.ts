import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import { demoImport, TEST_POD_ROOT } from "../core/testing.js";
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
});
