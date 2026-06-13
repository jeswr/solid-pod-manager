// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, expect, it } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import {
  buildClassTable,
  classesInDataset,
  dominantTabulatableClass,
  DEFAULT_MEMBER_CAP,
} from "./table-of-class.js";

const URL = "https://alice.example/contacts/list";

async function ds(ttl: string) {
  return parseRdf(ttl, "text/turtle", { baseIRI: URL });
}

describe("classesInDataset", () => {
  it("lists distinct rdf:type IRIs, sorted by label", async () => {
    const dataset = await ds(`
      @prefix schema: <https://schema.org/>.
      <#a> a schema:Person .
      <#b> a schema:Person .
      <#c> a schema:Organization .
    `);
    const classes = classesInDataset(dataset);
    expect(classes.map((c) => c.label)).toEqual(["Organization", "Person"]);
    expect(classes.find((c) => c.label === "Person")?.predicate).toBe("https://schema.org/Person");
  });

  it("returns nothing for an untyped dataset", async () => {
    const dataset = await ds(`<#a> <https://schema.org/name> "x" .`);
    expect(classesInDataset(dataset)).toEqual([]);
  });
});

describe("dominantTabulatableClass", () => {
  it("picks the class with the most instances (>= 2)", async () => {
    const dataset = await ds(`
      @prefix schema: <https://schema.org/>.
      <#a> a schema:Person . <#b> a schema:Person . <#c> a schema:Person .
      <#x> a schema:Organization . <#y> a schema:Organization .
    `);
    expect(dominantTabulatableClass(dataset)).toBe("https://schema.org/Person");
  });

  it("returns undefined when no class has two instances", async () => {
    const dataset = await ds(`
      @prefix schema: <https://schema.org/>.
      <#a> a schema:Person .
      <#x> a schema:Organization .
    `);
    expect(dominantTabulatableClass(dataset)).toBeUndefined();
  });

  it("respects a custom minimum", async () => {
    const dataset = await ds(`
      @prefix schema: <https://schema.org/>.
      <#a> a schema:Person . <#b> a schema:Person .
    `);
    expect(dominantTabulatableClass(dataset, 3)).toBeUndefined();
    expect(dominantTabulatableClass(dataset, 2)).toBe("https://schema.org/Person");
  });

  it("returns undefined for an untyped dataset", async () => {
    const dataset = await ds(`<#a> <https://schema.org/name> "x" .`);
    expect(dominantTabulatableClass(dataset)).toBeUndefined();
  });
});

describe("buildClassTable", () => {
  it("tabulates instances with a column per predicate (rdf:type excluded)", async () => {
    const dataset = await ds(`
      @prefix schema: <https://schema.org/>.
      <#alice> a schema:Person ; schema:name "Alice" ; schema:email "a@x.example" .
      <#bob>   a schema:Person ; schema:name "Bob" .
      <#acme>  a schema:Organization ; schema:name "Acme" .
    `);
    const table = buildClassTable(dataset, "https://schema.org/Person");

    expect(table.classLabel).toBe("Person");
    expect(table.total).toBe(2);
    expect(table.truncated).toBe(false);
    // Columns: the union of predicates on Person instances, minus rdf:type.
    expect(table.columns.map((c) => c.label)).toEqual(["email", "name"]);
    expect(table.columns.some((c) => c.label === "type")).toBe(false);

    // Rows sorted by subject IRI: alice before bob.
    expect(table.rows.map((r) => r.label)).toEqual(["alice", "bob"]);
    const alice = table.rows[0];
    expect(alice.cells["https://schema.org/name"][0]).toMatchObject({
      value: "Alice",
      kind: "literal",
    });
    // Bob has no email — no cell entry for that predicate.
    const bob = table.rows[1];
    expect(bob.cells["https://schema.org/email"]).toBeUndefined();
  });

  it("excludes instances of other classes", async () => {
    const dataset = await ds(`
      @prefix schema: <https://schema.org/>.
      <#alice> a schema:Person ; schema:name "Alice" .
      <#acme>  a schema:Organization ; schema:name "Acme" .
    `);
    const table = buildClassTable(dataset, "https://schema.org/Organization");
    expect(table.rows.map((r) => r.label)).toEqual(["acme"]);
    expect(table.total).toBe(1);
  });

  it("carries datatype/language on literal cells (for A2 formatting)", async () => {
    const dataset = await ds(`
      @prefix schema: <https://schema.org/>.
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#>.
      <#e> a schema:Event ; schema:startDate "2026-06-13T09:00:00Z"^^xsd:dateTime ;
           schema:name "Launch"@en .
    `);
    const table = buildClassTable(dataset, "https://schema.org/Event");
    const row = table.rows[0];
    expect(row.cells["https://schema.org/startDate"][0].datatype).toBe(
      "http://www.w3.org/2001/XMLSchema#dateTime",
    );
    expect(row.cells["https://schema.org/name"][0].language).toBe("en");
  });

  it("distinguishes named-node cells from literals", async () => {
    const dataset = await ds(`
      @prefix schema: <https://schema.org/>.
      <#alice> a schema:Person ; schema:knows <https://bob.example/#me> .
    `);
    const table = buildClassTable(dataset, "https://schema.org/Person");
    const cell = table.rows[0].cells["https://schema.org/knows"][0];
    expect(cell.kind).toBe("named");
    expect(cell.value).toBe("https://bob.example/#me");
  });

  it("collects multiple values for one predicate into one cell", async () => {
    const dataset = await ds(`
      @prefix schema: <https://schema.org/>.
      <#alice> a schema:Person ; schema:name "Alice", "Alicia" .
    `);
    const table = buildClassTable(dataset, "https://schema.org/Person");
    const names = table.rows[0].cells["https://schema.org/name"].map((v) => v.value).sort();
    expect(names).toEqual(["Alice", "Alicia"]);
  });

  it("caps rows and reports total + truncated", async () => {
    const lines = Array.from(
      { length: 5 },
      (_, i) => `<#p${i}> a <https://schema.org/Person> ; <https://schema.org/name> "P${i}" .`,
    ).join("\n");
    const dataset = await ds(lines);
    const table = buildClassTable(dataset, "https://schema.org/Person", 3);
    expect(table.total).toBe(5);
    expect(table.rows).toHaveLength(3);
    expect(table.truncated).toBe(true);
  });

  it("defaults the cap to DEFAULT_MEMBER_CAP", async () => {
    const lines = Array.from(
      { length: DEFAULT_MEMBER_CAP + 2 },
      (_, i) => `<#p${i}> a <https://schema.org/Person> .`,
    ).join("\n");
    const dataset = await ds(lines);
    const table = buildClassTable(dataset, "https://schema.org/Person");
    expect(table.rows).toHaveLength(DEFAULT_MEMBER_CAP);
    expect(table.truncated).toBe(true);
  });

  it("returns an empty table for a class with no instances", async () => {
    const dataset = await ds(`<#a> a <https://schema.org/Person> .`);
    const table = buildClassTable(dataset, "https://schema.org/Organization");
    expect(table.total).toBe(0);
    expect(table.rows).toEqual([]);
    expect(table.columns).toEqual([]);
  });
});
