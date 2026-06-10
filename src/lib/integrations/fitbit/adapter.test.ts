import { DataFactory } from "n3";
import { describe, expect, it } from "vitest";
import { demoImport, TEST_POD_ROOT } from "../core/testing.js";
import { CLASSES, ExerciseAction } from "../core/vocab.js";
import { fitbitAdapter } from "./adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/fitbit/`;
const ACT_DOC = `${ROOT}health/activities.ttl`;

describe("fitbit adapter contract", () => {
  it("writes logged activities as typed schema:ExerciseAction into Health", async () => {
    const { pod, report } = await demoImport(fitbitAdapter);

    expect(report.written.map((w) => w.url)).toEqual([ACT_DOC]);
    expect(report.categories).toEqual(["health"]);

    const ds = pod.dataset(ACT_DOC);
    const run = new ExerciseAction(`${ACT_DOC}#activity-51817963271`, ds, DataFactory);
    expect(run.types.has(CLASSES.ExerciseAction)).toBe(true);
    expect(run.name).toBe("Run");
    expect(run.exerciseType).toBe("Run");
    expect(run.distance).toBe("5.2 km");
    expect(run.duration).toBe("PT31M");
    expect(run.startTime?.toISOString()).toBe("2026-06-08T07:12:00.000Z");
  });

  it("registers ExerciseAction for the health container", async () => {
    const { pod, report } = await demoImport(fitbitAdapter);
    const index = pod.get(report.indexUrl) ?? "";
    expect(index).toContain(CLASSES.ExerciseAction);
    expect(index).toContain(`${ROOT}health/`);
  });

  it("is tier B with proxy token exchange", () => {
    expect(fitbitAdapter.metadata.tier).toBe("B");
    expect(fitbitAdapter.oauth?.tokenExchange).toBe("proxy");
  });

  it("re-import is idempotent", async () => {
    const { pod } = await demoImport(fitbitAdapter);
    const before = pod.urls();
    const sizeBefore = pod.dataset(ACT_DOC).size;
    await demoImport(fitbitAdapter, { pod });
    expect(pod.urls()).toEqual(before);
    expect(pod.dataset(ACT_DOC).size).toBe(sizeBefore);
  });
});
