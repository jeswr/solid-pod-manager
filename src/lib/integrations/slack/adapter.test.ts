import { DataFactory } from "n3";
import { describe, expect, it } from "vitest";
import { demoImport, TEST_POD_ROOT } from "../core/testing.js";
import { CLASSES, Organisation } from "../core/vocab.js";
import { slackAdapter } from "./adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/slack/`;
const WS_DOC = `${ROOT}work/workspace.ttl`;

describe("slack adapter contract", () => {
  it("writes the workspace and channels as schema:Organization into Work & education", async () => {
    const { pod, report } = await demoImport(slackAdapter);

    expect(report.written.map((w) => w.url)).toEqual([WS_DOC]);
    expect(report.categories).toEqual(["work-education"]);

    const ds = pod.dataset(WS_DOC);
    const team = new Organisation(`${WS_DOC}#team-T01ABCDEF`, ds, DataFactory);
    expect(team.types.has(CLASSES.Organization)).toBe(true);
    expect(team.name).toBe("Acme Team");
    expect(team.sourceUrl).toBe("https://acme-team.slack.com/");

    const general = new Organisation(`${WS_DOC}#channel-C01GENERAL`, ds, DataFactory);
    expect(general.name).toBe("#general");
    expect(general.description).toBe("This channel is for team-wide communication.");
  });

  it("registers Organization for the work container", async () => {
    const { pod, report } = await demoImport(slackAdapter);
    const index = pod.get(report.indexUrl) ?? "";
    expect(index).toContain(CLASSES.Organization);
    expect(index).toContain(`${ROOT}work/`);
  });

  it("is tier B with proxy token exchange", () => {
    expect(slackAdapter.metadata.tier).toBe("B");
    expect(slackAdapter.oauth?.tokenExchange).toBe("proxy");
  });

  it("re-import is idempotent", async () => {
    const { pod } = await demoImport(slackAdapter);
    const before = pod.urls();
    const sizeBefore = pod.dataset(WS_DOC).size;
    await demoImport(slackAdapter, { pod });
    expect(pod.urls()).toEqual(before);
    expect(pod.dataset(WS_DOC).size).toBe(sizeBefore);
  });
});
