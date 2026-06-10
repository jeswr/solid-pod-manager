import { describe, it, expect } from "vitest";
import { decodeXmlEntities, extractElements } from "./mini-xml.js";

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
