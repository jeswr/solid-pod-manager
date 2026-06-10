import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import { demoImport, TEST_POD_ROOT } from "../core/testing.js";
import { CLASSES, ExerciseAction, TravelAction } from "../core/vocab.js";
import { stravaAdapter } from "./adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/strava/`;
const WORKOUTS_DOC = `${ROOT}fitness/activities.ttl`;
const RIDES_DOC = `${ROOT}travel/rides.ttl`;

describe("strava adapter contract", () => {
  it("splits activities: workouts → Health, rides → Mobility", async () => {
    const { pod, report } = await demoImport(stravaAdapter);

    expect(report.categories.sort()).toEqual(["health", "mobility"]);

    const workouts = pod.dataset(WORKOUTS_DOC);
    const run = new ExerciseAction(`${WORKOUTS_DOC}#activity-11223344`, workouts, DataFactory);
    expect(run.types.has(CLASSES.ExerciseAction)).toBe(true);
    expect(run.name).toBe("Morning Run");
    expect(run.exerciseType).toBe("Run");
    expect(run.distance).toBe("5.2 km");
    expect(run.duration).toBe("PT27M2S");
    expect(run.startTime?.toISOString()).toBe("2026-06-05T06:31:00.000Z");

    const rides = pod.dataset(RIDES_DOC);
    const commute = new TravelAction(`${RIDES_DOC}#activity-11223345`, rides, DataFactory);
    expect(commute.types.has(CLASSES.TravelAction)).toBe(true);
    expect(commute.name).toBe("Commute to work");
    // The ride must NOT be in the workouts doc.
    expect(
      new TravelAction(`${WORKOUTS_DOC}#activity-11223345`, workouts, DataFactory).name,
    ).toBeUndefined();
  });

  it("registers ExerciseAction and TravelAction for their own containers", async () => {
    const { pod, report } = await demoImport(stravaAdapter);
    const index = pod.get(report.indexUrl) ?? "";
    expect(index).toContain(CLASSES.ExerciseAction);
    expect(index).toContain(`${ROOT}fitness/`);
    expect(index).toContain(CLASSES.TravelAction);
    expect(index).toContain(`${ROOT}travel/`);
  });

  it("returns the newest start time as the incremental cursor", async () => {
    const { report } = await demoImport(stravaAdapter);
    expect(report.cursor).toBe(String(Math.floor(Date.parse("2026-06-05T06:31:00Z") / 1000)));
  });

  it("merge re-import with the cursor stays idempotent (no duplicates)", async () => {
    const { pod, report } = await demoImport(stravaAdapter);
    const sizeBefore = pod.dataset(WORKOUTS_DOC).size;
    const urlsBefore = pod.urls();

    const second = await demoImport(stravaAdapter, { pod, cursor: report.cursor });

    expect(pod.urls()).toEqual(urlsBefore);
    expect(pod.dataset(WORKOUTS_DOC).size).toBe(sizeBefore); // merged, deduped
    expect(second.report.cursor).toBe(report.cursor); // cursor preserved
  });
});
