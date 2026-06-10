import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import { fileImport, memoryFile, TEST_POD_ROOT } from "../core/testing.js";
import { CLASSES, WatchAction } from "../core/vocab.js";
import { netflixFileAdapter, parseNetflixDate } from "./file-adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/netflix/`;
const DOC = `${ROOT}media/viewing-history.ttl`;

// A realistic sample of Netflix's NetflixViewingHistory.csv (Title,Date).
const SAMPLE = `Title,Date
"The Crown: Season 1: Smoke and Mirrors",1/2/2021
"Stranger Things: Season 4: Chapter One: The Hellfire Club",12/31/2022
"Glass Onion: A Knives Out Mystery",2/14/2023`;

describe("netflix file adapter", () => {
  it("writes each viewing as a schema:WatchAction in Media", async () => {
    const { pod, report } = await fileImport(
      netflixFileAdapter,
      memoryFile("NetflixViewingHistory.csv", SAMPLE, "text/csv"),
    );

    expect(report.written.map((w) => w.url)).toEqual([DOC]);
    expect(report.categories).toEqual(["media"]);

    const ds = pod.dataset(DOC);
    const subjects = [...ds].filter((q) => q.predicate.value.endsWith("type"));
    expect(subjects).toHaveLength(3);

    const titles = [...ds]
      .filter((q) => q.predicate.value === "https://schema.org/name")
      .map((q) => q.object.value);
    expect(titles).toContain("Glass Onion: A Knives Out Mystery");
  });

  it("stamps the WatchAction type and parses the date", async () => {
    const { pod } = await fileImport(
      netflixFileAdapter,
      memoryFile("nf.csv", SAMPLE, "text/csv"),
    );
    const ds = pod.dataset(DOC);
    // Find the Glass Onion subject by its name triple.
    const nameQuad = [...ds].find(
      (q) =>
        q.predicate.value === "https://schema.org/name" &&
        q.object.value === "Glass Onion: A Knives Out Mystery",
    );
    expect(nameQuad).toBeDefined();
    const watch = new WatchAction(nameQuad!.subject.value, ds, DataFactory);
    expect(watch.types.has(CLASSES.WatchAction)).toBe(true);
    expect(watch.startTime?.toISOString().slice(0, 10)).toBe("2023-02-14");
  });

  it("re-import is idempotent (same doc, no growth)", async () => {
    const file = memoryFile("nf.csv", SAMPLE, "text/csv");
    const { pod } = await fileImport(netflixFileAdapter, file);
    const before = pod.dataset(DOC).size;
    await fileImport(netflixFileAdapter, file, { pod });
    expect(pod.dataset(DOC).size).toBe(before);
  });

  it("registers WatchAction in the type index", async () => {
    const { pod, report } = await fileImport(
      netflixFileAdapter,
      memoryFile("nf.csv", SAMPLE, "text/csv"),
    );
    expect(pod.get(report.indexUrl)).toContain(CLASSES.WatchAction);
    expect(pod.get(report.indexUrl)).toContain(`${ROOT}media/`);
  });
});

describe("parseNetflixDate", () => {
  it("parses M/D/YYYY", () => {
    expect(parseNetflixDate("2/14/2023")?.toISOString().slice(0, 10)).toBe("2023-02-14");
  });
  it("swaps to D/M when the first part can't be a month", () => {
    expect(parseNetflixDate("14/2/2023")?.toISOString().slice(0, 10)).toBe("2023-02-14");
  });
  it("returns undefined for junk", () => {
    expect(parseNetflixDate("not-a-date")).toBeUndefined();
  });
});
