import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import {
  demoImport,
  expectCleanTurtle,
  sparseImport,
  TEST_POD_ROOT,
} from "../core/testing.js";
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

  // Robustness: manual activities omit distance/moving_time, a fresh activity
  // can momentarily lack a sport type, the array can carry a null, and a
  // malformed start_date must not crash the cursor computation.
  it("survives a sparse live response (missing metrics, null entry, no sport type)", async () => {
    const { pod, report } = await sparseImport(stravaAdapter, [
      {
        url: "https://www.strava.com/api/v3/athlete/activities",
        json: [
          // No distance, no moving_time, no sport_type → lands as a workout.
          { id: 1, name: "Manual Entry", start_date: "2026-06-05T06:31:00Z" },
          // Ride with everything present.
          {
            id: 2,
            name: "Ride",
            sport_type: "Ride",
            distance: 8000,
            moving_time: 1200,
            start_date: "2026-06-04T07:00:00Z",
          },
          null, // null activity entry
          { name: "No Id", sport_type: "Run" }, // no id ⇒ skipped
          // Malformed date must not break the cursor.
          { id: 3, name: "Bad Date", sport_type: "Run", start_date: "not-a-date" },
        ],
      },
    ]);

    expect(report.written.map((w) => w.url).sort()).toEqual([WORKOUTS_DOC, RIDES_DOC]);
    expect(report.skipped).toBe(2); // null entry + id-less activity
    // Cursor is the newest *valid* start time (the bad date is ignored).
    expect(report.cursor).toBe(String(Math.floor(Date.parse("2026-06-05T06:31:00Z") / 1000)));

    const workouts = expectCleanTurtle(pod, WORKOUTS_DOC);
    expectCleanTurtle(pod, RIDES_DOC);

    const manual = new ExerciseAction(`${WORKOUTS_DOC}#activity-1`, workouts, DataFactory);
    expect(manual.name).toBe("Manual Entry");
    expect(manual.distance).toBeUndefined(); // omitted, not "NaN km"
    expect(manual.duration).toBeUndefined();
    expect(manual.exerciseType).toBeUndefined(); // no sport type, no crash

    const badDate = new ExerciseAction(`${WORKOUTS_DOC}#activity-3`, workouts, DataFactory);
    expect(badDate.name).toBe("Bad Date");
    expect(badDate.startTime).toBeUndefined(); // invalid date omitted
  });
});
