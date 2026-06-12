import { describe, it, expect } from "vitest";
import { decodeXmlEntities, extractBlocks, extractElements, firstTagText } from "./mini-xml.js";

describe("decodeXmlEntities", () => {
  it("decodes the five predefined entities", () => {
    expect(decodeXmlEntities("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;")).toBe(
      "a & b <c> \"d\" 'e'",
    );
  });
  it("decodes numeric and hex character refs", () => {
    expect(decodeXmlEntities("&#65;&#x42;")).toBe("AB");
  });
  it("leaves unknown entities untouched", () => {
    expect(decodeXmlEntities("&nbsp;")).toBe("&nbsp;");
  });
});

describe("extractElements", () => {
  const xml = `<HealthData>
    <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30.5" durationUnit="min" startDate="2023-02-14 09:00:00 +0000"/>
    <Record type="HKQuantityTypeIdentifierStepCount" value="1200"/>
    <Workout workoutActivityType="HKWorkoutActivityTypeCycling" duration="45" durationUnit="min" startDate="2023-02-15 07:00:00 +0000">
      <MetadataEntry key="x" value="y"/>
    </Workout>
  </HealthData>`;

  it("extracts attributes of each matching element", () => {
    const workouts = [...extractElements(xml, "Workout")];
    expect(workouts).toHaveLength(2);
    expect(workouts[0].workoutActivityType).toBe("HKWorkoutActivityTypeRunning");
    expect(workouts[0].duration).toBe("30.5");
    expect(workouts[1].workoutActivityType).toBe("HKWorkoutActivityTypeCycling");
  });

  it("handles both self-closing and open start tags", () => {
    expect([...extractElements(xml, "Record")]).toHaveLength(1);
  });

  it("respects the limit", () => {
    expect([...extractElements(xml, "Workout", 1)]).toHaveLength(1);
  });

  it("decodes entity-escaped attribute values", () => {
    const x = `<E note="Tom &amp; Jerry"/>`;
    expect([...extractElements(x, "E")][0].note).toBe("Tom & Jerry");
  });
});

describe("extractBlocks", () => {
  const gpx = `<gpx><trk><name>Morning Run</name><type>running</type>
    <trkseg>
      <trkpt lat="51.50" lon="-0.12"><time>2026-06-08T06:30:00Z</time></trkpt>
      <trkpt lat="51.51" lon="-0.13"/>
    </trkseg></trk></gpx>`;

  it("returns attrs + raw inner markup for open elements", () => {
    const trks = [...extractBlocks(gpx, "trk")];
    expect(trks).toHaveLength(1);
    expect(trks[0].inner).toContain("<name>Morning Run</name>");
  });

  it("handles self-closing elements (empty inner) and attributes", () => {
    const pts = [...extractBlocks(gpx, "trkpt")];
    expect(pts).toHaveLength(2);
    expect(pts[0].attrs.lat).toBe("51.50");
    expect(pts[0].inner).toContain("<time>");
    expect(pts[1].attrs.lon).toBe("-0.13");
    expect(pts[1].inner).toBe("");
  });

  it("does not confuse a tag with a longer-named tag (trk vs trkpt/trkseg)", () => {
    expect([...extractBlocks(gpx, "trk")]).toHaveLength(1);
  });

  it("respects the limit and survives a truncated close tag", () => {
    expect([...extractBlocks(gpx, "trkpt", 1)]).toHaveLength(1);
    const truncated = `<a><b>one</b><b>two`;
    const bs = [...extractBlocks(truncated, "b")];
    expect(bs).toHaveLength(2);
    expect(bs[1].inner).toBe("two");
  });
});

describe("firstTagText", () => {
  it("returns the decoded, trimmed text of the first leaf element", () => {
    expect(firstTagText(`<x><name> Tom &amp; Jerry </name><name>second</name></x>`, "name")).toBe(
      "Tom & Jerry",
    );
  });
  it("returns undefined for absent tags, empty text, or nested markup", () => {
    expect(firstTagText(`<x/>`, "name")).toBeUndefined();
    expect(firstTagText(`<x><name>  </name></x>`, "name")).toBeUndefined();
    expect(firstTagText(`<x><name><b>no</b></name></x>`, "name")).toBeUndefined();
  });
});
