import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import { fileImport, memoryFile, TEST_POD_ROOT } from "../core/testing.js";
import { CLASSES, ExerciseAction } from "../core/vocab.js";
import { appleHealthFileAdapter, humanWorkoutType, parseAppleDate } from "./file-adapter.js";

const DOC = `${TEST_POD_ROOT}integrations/apple-health/health/workouts.ttl`;

// Realistic apple_health_export/export.xml fragment.
const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_GB">
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30.5" durationUnit="min" totalDistance="5.2" totalDistanceUnit="km" startDate="2023-02-14 09:00:00 +0000" endDate="2023-02-14 09:30:30 +0000"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" value="1200" startDate="2023-02-14 08:00:00 +0000"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeCycling" duration="45" durationUnit="min" startDate="2023-02-15 07:00:00 +0100">
   <MetadataEntry key="HKIndoorWorkout" value="0"/>
 </Workout>
</HealthData>`;

describe("apple-health file adapter", () => {
  it("imports each Workout as a schema:ExerciseAction in Health", async () => {
    const { pod, report } = await fileImport(
      appleHealthFileAdapter,
      memoryFile("export.xml", SAMPLE, "application/xml"),
    );
    expect(report.categories).toEqual(["health"]);
    const ds = pod.dataset(DOC);
    const types = [...ds].filter(
      (q) => q.object.value === CLASSES.ExerciseAction && q.predicate.value.endsWith("type"),
    );
    expect(types).toHaveLength(2);
  });

  it("maps activity type, ISO duration and distance", async () => {
    const { pod } = await fileImport(
      appleHealthFileAdapter,
      memoryFile("export.xml", SAMPLE, "application/xml"),
    );
    const ds = pod.dataset(DOC);
    const run = [...ds].find(
      (q) => q.predicate.value === "https://schema.org/exerciseType" && q.object.value === "Running",
    );
    expect(run).toBeDefined();
    const ex = new ExerciseAction(run!.subject.value, ds, DataFactory);
    expect(ex.duration).toBe("PT30M30S");
    expect(ex.distance).toBe("5.2 km");
    expect(ex.startTime?.toISOString()).toBe("2023-02-14T09:00:00.000Z");
  });

  it("registers ExerciseAction in the type index", async () => {
    const { pod, report } = await fileImport(
      appleHealthFileAdapter,
      memoryFile("export.xml", SAMPLE, "application/xml"),
    );
    expect(pod.get(report.indexUrl)).toContain(CLASSES.ExerciseAction);
  });
});

describe("humanWorkoutType", () => {
  it("strips the HK prefix and spaces camelCase", () => {
    expect(humanWorkoutType("HKWorkoutActivityTypeFunctionalStrengthTraining")).toBe(
      "Functional Strength Training",
    );
  });
  it("falls back to Workout for empty input", () => {
    expect(humanWorkoutType("")).toBe("Workout");
  });
});

describe("parseAppleDate", () => {
  it("honours the timezone offset", () => {
    expect(parseAppleDate("2023-02-15 07:00:00 +0100")?.toISOString()).toBe(
      "2023-02-15T06:00:00.000Z",
    );
  });
  it("returns undefined for junk", () => {
    expect(parseAppleDate("nope")).toBeUndefined();
  });
});
