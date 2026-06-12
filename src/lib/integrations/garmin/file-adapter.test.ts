import { describe, it, expect } from "vitest";
import { DataFactory, type Store } from "n3";
import { fileImport, memoryFile, TEST_POD_ROOT } from "../core/testing.js";
import { CLASSES, ExerciseAction, TravelAction } from "../core/vocab.js";
import {
  cleanNumber,
  detectShape,
  garminFileAdapter,
  isTravelActivity,
  parseClockDuration,
  parseGarminCsvDate,
} from "./file-adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/garmin/`;
const EX_DOC = `${ROOT}health/activities.ttl`;
const TRAVEL_DOC = `${ROOT}mobility/journeys.ttl`;
const SCHEMA = "https://schema.org/";

/**
 * A realistic slice of Garmin Connect's Activities.csv ("Export CSV" on the
 * activities list; post-Nov-2024 column order). Includes a quoted title with
 * an embedded comma and doubled quotes, a thousands-separated calorie cell,
 * and a hostile row (IRI-breaking distance, junk date/time).
 */
const ACTIVITIES_CSV = `Activity Type,Date,Favorite,Title,Distance,Calories,Time,Avg HR,Max HR
Running,2026-06-01 06:30:00,false,"Morning Run, 5k ""PB""",5.43,345,00:33:05,150,176
Cycling,2026-06-02 11:45:00,false,Lunch Ride,22.1,"1,234",01:00:00,132,158
Indoor Cycling,2026-06-03 18:00:00,false,Spin Class,15.0,300,00:45:00,140,166
Commuting,2026-06-04 08:05:00,false,,8.2,180,00:25:00,110,134
Running,not-a-date,false,<script>alert(1)</script>,"12> . <x> <y> <z",NaN,whenever,0,0`;

const RUN_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" creator="Garmin Connect">
  <metadata><time>2026-06-08T06:29:55Z</time></metadata>
  <trk>
    <name>Morning Run</name>
    <type>running</type>
    <trkseg>
      <trkpt lat="51.5000" lon="-0.1200"><ele>12</ele><time>2026-06-08T06:30:00Z</time></trkpt>
      <trkpt lat="51.5045" lon="-0.1200"><ele>13</ele><time>2026-06-08T06:30:50Z</time></trkpt>
      <trkpt lat="51.5090" lon="-0.1200"><ele>14</ele><time>2026-06-08T06:31:40Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`;

const RIDE_TCX = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="Biking">
      <Id>2026-06-09T11:45:00.000Z</Id>
      <Lap StartTime="2026-06-09T11:45:00.000Z">
        <TotalTimeSeconds>1200.0</TotalTimeSeconds>
        <DistanceMeters>3200.0</DistanceMeters>
        <Calories>200</Calories>
        <Track>
          <Trackpoint><Time>2026-06-09T11:45:01.000Z</Time><DistanceMeters>1.7</DistanceMeters></Trackpoint>
        </Track>
      </Lap>
      <Lap StartTime="2026-06-09T12:05:00.000Z">
        <TotalTimeSeconds>780.0</TotalTimeSeconds>
        <DistanceMeters>2230.0</DistanceMeters>
        <Calories>145</Calories>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;

/** All subjects in `ds` typed as `classIri`. */
function subjectsOf(ds: Store, classIri: string): string[] {
  return [...ds]
    .filter((q) => q.predicate.value.endsWith("#type") && q.object.value === classIri)
    .map((q) => q.subject.value)
    .sort();
}

describe("garmin file adapter — Activities.csv", () => {
  it("splits runs/workouts into Health and rides/commutes into Mobility", async () => {
    const { pod, report } = await fileImport(
      garminFileAdapter,
      memoryFile("Activities.csv", ACTIVITIES_CSV, "text/csv"),
    );

    expect(report.written.map((w) => w.url).sort()).toEqual([EX_DOC, TRAVEL_DOC].sort());
    expect([...report.categories].sort()).toEqual(["health", "mobility"]);

    // Running ×2 (incl. the hostile row) + Indoor Cycling → ExerciseAction.
    expect(subjectsOf(pod.dataset(EX_DOC), CLASSES.ExerciseAction)).toHaveLength(3);
    // Cycling + Commuting → TravelAction.
    expect(subjectsOf(pod.dataset(TRAVEL_DOC), CLASSES.TravelAction)).toHaveLength(2);
  });

  it("parses quoted fields, units and dates into typed schema properties", async () => {
    const { pod } = await fileImport(
      garminFileAdapter,
      memoryFile("Activities.csv", ACTIVITIES_CSV, "text/csv"),
    );
    const ds = pod.dataset(EX_DOC);
    const nameQuad = [...ds].find(
      (q) => q.predicate.value === `${SCHEMA}name` && q.object.value === 'Morning Run, 5k "PB"',
    );
    expect(nameQuad).toBeDefined();
    const run = new ExerciseAction(nameQuad!.subject.value, ds, DataFactory);
    expect(run.types.has(CLASSES.ExerciseAction)).toBe(true);
    expect(run.exerciseType).toBe("Running");
    expect(run.startTime?.toISOString()).toBe("2026-06-01T06:30:00.000Z");
    expect(run.duration).toBe("PT33M5S");
    // The CSV states no distance unit (account display units) — bare value.
    expect(run.distance).toBe("5.43");
    expect(run.calories).toBe("345 kcal");
  });

  it("normalises thousands separators and titles falling back to the type", async () => {
    const { pod } = await fileImport(
      garminFileAdapter,
      memoryFile("Activities.csv", ACTIVITIES_CSV, "text/csv"),
    );
    const ds = pod.dataset(TRAVEL_DOC);
    const ride = new TravelAction(
      subjectsOf(ds, CLASSES.TravelAction).find((s) =>
        [...ds].some((q) => q.subject.value === s && q.object.value === "Lunch Ride"),
      )!,
      ds,
      DataFactory,
    );
    expect(ride.calories).toBe("1234 kcal");
    expect(ride.duration).toBe("PT1H");
    // The Commuting row has no Title → named after its activity type.
    const names = [...ds].filter((q) => q.predicate.value === `${SCHEMA}name`).map((q) => q.object.value);
    expect(names).toContain("Commuting");
  });

  it("keeps hostile cells as inert literals and drops non-numeric values", async () => {
    const { pod } = await fileImport(
      garminFileAdapter,
      memoryFile("Activities.csv", ACTIVITIES_CSV, "text/csv"),
    );
    const ds = pod.dataset(EX_DOC);
    const hostile = [...ds].find(
      (q) => q.predicate.value === `${SCHEMA}name` && q.object.value === "<script>alert(1)</script>",
    );
    expect(hostile).toBeDefined();
    expect(hostile!.object.termType).toBe("Literal"); // inert, never an IRI
    const row = new ExerciseAction(hostile!.subject.value, ds, DataFactory);
    // Junk date/time and the IRI-breaking distance are dropped, not guessed.
    expect(row.startTime).toBeUndefined();
    expect(row.duration).toBeUndefined();
    expect(row.distance).toBeUndefined();
    expect(row.calories).toBeUndefined();
    // The injection attempt never appears as a subject/object IRI.
    expect([...ds].some((q) => q.object.termType === "NamedNode" && q.object.value.includes("<"))).toBe(false);
  });

  it("uses deterministic fragment IRIs — re-import is idempotent", async () => {
    const file = memoryFile("Activities.csv", ACTIVITIES_CSV, "text/csv");
    const { pod } = await fileImport(garminFileAdapter, file);
    const before = {
      ex: subjectsOf(pod.dataset(EX_DOC), CLASSES.ExerciseAction),
      travel: subjectsOf(pod.dataset(TRAVEL_DOC), CLASSES.TravelAction),
      size: pod.dataset(EX_DOC).size + pod.dataset(TRAVEL_DOC).size,
    };
    for (const s of [...before.ex, ...before.travel]) {
      expect(s).toMatch(new RegExp(`^${ROOT}(health/activities\\.ttl#activity-|mobility/journeys\\.ttl#journey-)`));
    }
    await fileImport(garminFileAdapter, file, { pod });
    expect(subjectsOf(pod.dataset(EX_DOC), CLASSES.ExerciseAction)).toEqual(before.ex);
    expect(subjectsOf(pod.dataset(TRAVEL_DOC), CLASSES.TravelAction)).toEqual(before.travel);
    expect(pod.dataset(EX_DOC).size + pod.dataset(TRAVEL_DOC).size).toBe(before.size);
  });

  it("registers both classes in the type index", async () => {
    const { pod, report } = await fileImport(
      garminFileAdapter,
      memoryFile("Activities.csv", ACTIVITIES_CSV, "text/csv"),
    );
    const index = pod.get(report.indexUrl);
    expect(index).toContain(CLASSES.ExerciseAction);
    expect(index).toContain(CLASSES.TravelAction);
    expect(index).toContain(`${ROOT}health/`);
    expect(index).toContain(`${ROOT}mobility/`);
  });
});

describe("garmin file adapter — single-activity GPX", () => {
  it("imports a run as schema:ExerciseAction with derived duration and distance", async () => {
    const { pod, report } = await fileImport(
      garminFileAdapter,
      memoryFile("activity_19283746.gpx", RUN_GPX, "application/gpx+xml"),
    );
    expect(report.written.map((w) => w.url)).toEqual([EX_DOC]);
    expect(report.categories).toEqual(["health"]);

    const ds = pod.dataset(EX_DOC);
    const [subject] = subjectsOf(ds, CLASSES.ExerciseAction);
    const run = new ExerciseAction(subject, ds, DataFactory);
    expect(run.name).toBe("Morning Run");
    expect(run.exerciseType).toBe("running");
    expect(run.startTime?.toISOString()).toBe("2026-06-08T06:30:00.000Z");
    expect(run.duration).toBe("PT1M40S"); // first → last trackpoint time
    expect(run.distance).toBe("1.00 km"); // haversine over the track
    expect(run.calories).toBeUndefined(); // GPX has none — never invented
  });

  it("classifies a cycling GPX track as schema:TravelAction in Mobility", async () => {
    const ride = RUN_GPX.replace("Morning Run", "Evening Ride").replace(
      "<type>running</type>",
      "<type>cycling</type>",
    );
    const { pod, report } = await fileImport(
      garminFileAdapter,
      memoryFile("activity.gpx", ride, "application/gpx+xml"),
    );
    expect(report.written.map((w) => w.url)).toEqual([TRAVEL_DOC]);
    const ds = pod.dataset(TRAVEL_DOC);
    const [subject] = subjectsOf(ds, CLASSES.TravelAction);
    expect(new TravelAction(subject, ds, DataFactory).name).toBe("Evening Ride");
  });
});

describe("garmin file adapter — single-activity TCX", () => {
  it("sums lap totals (time, distance, calories) and reads the sport", async () => {
    const { pod, report } = await fileImport(
      garminFileAdapter,
      memoryFile("activity_19283747.tcx", RIDE_TCX, "application/vnd.garmin.tcx+xml"),
    );
    // Sport="Biking" → a ride → Mobility.
    expect(report.written.map((w) => w.url)).toEqual([TRAVEL_DOC]);
    const ds = pod.dataset(TRAVEL_DOC);
    const [subject] = subjectsOf(ds, CLASSES.TravelAction);
    const ride = new TravelAction(subject, ds, DataFactory);
    expect(ride.name).toBe("Garmin Biking");
    expect(ride.startTime?.toISOString()).toBe("2026-06-09T11:45:00.000Z");
    expect(ride.duration).toBe("PT33M"); // 1200s + 780s
    expect(ride.distance).toBe("5.43 km"); // 3200m + 2230m — lap totals, not trackpoints
    expect(ride.calories).toBe("345 kcal"); // 200 + 145
  });
});

describe("garmin file adapter — rejects what it can't read", () => {
  it("reports 'nothing importable' for an unrecognised file", async () => {
    await expect(
      fileImport(garminFileAdapter, memoryFile("notes.txt", "hello world")),
    ).rejects.toThrow(/No importable records/);
  });
});

describe("garmin helpers", () => {
  it("detectShape: extension first, then content sniffing", () => {
    expect(detectShape("Activities.csv", "")).toBe("csv");
    expect(detectShape("a.GPX", "")).toBe("gpx");
    expect(detectShape("a.tcx", "")).toBe("tcx");
    expect(detectShape("export", RUN_GPX)).toBe("gpx");
    expect(detectShape("export", RIDE_TCX)).toBe("tcx");
    expect(detectShape("export", ACTIVITIES_CSV)).toBe("csv");
    expect(detectShape("export", "\uFEFFActivity Type,Date")).toBe("csv");
    expect(detectShape("export", "junk")).toBe("unknown");
  });

  it("isTravelActivity: rides/commutes travel; indoor/virtual riding stays exercise", () => {
    for (const t of ["Cycling", "Road Cycling", "Mountain Biking", "Gravel Ride", "Commuting", "driving", "Motorcycling"]) {
      expect(isTravelActivity(t), t).toBe(true);
    }
    for (const t of ["Running", "Trail Running", "Pool Swim", "Strength Training", "Indoor Cycling", "Virtual Ride", "Walking", ""]) {
      expect(isTravelActivity(t), t).toBe(false);
    }
  });

  it("parseGarminCsvDate: Garmin's local timestamp (treated as UTC) or undefined", () => {
    expect(parseGarminCsvDate("2026-06-01 06:30:00")?.toISOString()).toBe("2026-06-01T06:30:00.000Z");
    expect(parseGarminCsvDate("not-a-date")).toBeUndefined();
    expect(parseGarminCsvDate("2026-13-45 99:99:99")).toBeUndefined();
  });

  it("parseClockDuration: hh:mm:ss / mm:ss clock → ISO duration, junk → undefined", () => {
    expect(parseClockDuration("00:33:05")).toBe("PT33M5S");
    expect(parseClockDuration("01:00:00")).toBe("PT1H");
    expect(parseClockDuration("45:30")).toBe("PT45M30S");
    expect(parseClockDuration("00:25:00.0")).toBe("PT25M");
    expect(parseClockDuration("whenever")).toBeUndefined();
    expect(parseClockDuration("")).toBeUndefined();
  });

  it("cleanNumber: strict numerics only — injection attempts are dropped", () => {
    expect(cleanNumber("5.43")).toBe("5.43");
    expect(cleanNumber("1,234")).toBe("1234");
    expect(cleanNumber("1,234.5")).toBe("1234.5");
    expect(cleanNumber("0")).toBeUndefined(); // zero = "not recorded"
    expect(cleanNumber("NaN")).toBeUndefined();
    expect(cleanNumber("12> . <x> <y> <z")).toBeUndefined();
    expect(cleanNumber("=1+2")).toBeUndefined();
  });
});
