import { DataFactory } from "n3";
import { describe, expect, it } from "vitest";
import { demoImport, TEST_POD_ROOT } from "../core/testing.js";
import { CLASSES, ExerciseAction, TravelAction } from "../core/vocab.js";
import { garminAdapter } from "./adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/garmin/`;
const EX_DOC = `${ROOT}health/activities.ttl`;
const TRAVEL_DOC = `${ROOT}mobility/journeys.ttl`;

describe("garmin adapter contract", () => {
  it("writes workouts as ExerciseAction (Health) and journeys as TravelAction (Mobility)", async () => {
    const { pod, report } = await demoImport(garminAdapter);

    expect(report.written.map((w) => w.url).sort()).toEqual([EX_DOC, TRAVEL_DOC]);
    expect(report.categories.sort()).toEqual(["health", "mobility"]);

    const ex = pod.dataset(EX_DOC);
    const run = new ExerciseAction(`${EX_DOC}#activity-11223344551`, ex, DataFactory);
    expect(run.types.has(CLASSES.ExerciseAction)).toBe(true);
    expect(run.name).toBe("Morning Run");
    expect(run.exerciseType).toBe("running");
    expect(run.distance).toBe("5.4 km");
    expect(run.duration).toBe("PT33M");

    const tr = pod.dataset(TRAVEL_DOC);
    const commute = new TravelAction(`${TRAVEL_DOC}#journey-11223344553`, tr, DataFactory);
    expect(commute.types.has(CLASSES.TravelAction)).toBe(true);
    expect(commute.name).toBe("Commute");
    expect(commute.distance).toBe("8.2 km");
  });

  it("registers both classes into their containers", async () => {
    const { pod, report } = await demoImport(garminAdapter);
    const index = pod.get(report.indexUrl) ?? "";
    expect(index).toContain(CLASSES.ExerciseAction);
    expect(index).toContain(CLASSES.TravelAction);
    expect(index).toContain(`${ROOT}health/`);
    expect(index).toContain(`${ROOT}mobility/`);
  });

  it("is tier B with proxy token exchange", () => {
    expect(garminAdapter.metadata.tier).toBe("B");
    expect(garminAdapter.oauth?.tokenExchange).toBe("proxy");
  });

  it("re-import is idempotent", async () => {
    const { pod } = await demoImport(garminAdapter);
    const before = pod.urls();
    const sizeBefore = pod.dataset(EX_DOC).size;
    await demoImport(garminAdapter, { pod });
    expect(pod.urls()).toEqual(before);
    expect(pod.dataset(EX_DOC).size).toBe(sizeBefore);
  });
});
