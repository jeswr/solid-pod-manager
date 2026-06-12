import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import {
  demoImport,
  expectCleanTurtle,
  sparseImport,
  TEST_POD_ROOT,
} from "../core/testing.js";
import { CLASSES, DataCollection, DigitalDocument } from "../core/vocab.js";
import { notionAdapter } from "./adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/notion/`;
const PAGES_DOC = `${ROOT}documents/pages.ttl`;
const DB_DOC = `${ROOT}documents/databases.ttl`;

describe("notion adapter contract", () => {
  it("writes pages as schema:TextDigitalDocument into Documents", async () => {
    const { pod, report } = await demoImport(notionAdapter);
    expect(report.categories).toEqual(["documents"]);

    const ds = pod.dataset(PAGES_DOC);
    const page = new DigitalDocument(
      `${PAGES_DOC}#page-59833787-2cf9-4fdf-8782-e53db20768a5`,
      ds,
      DataFactory,
    );
    expect(page.types.has(CLASSES.TextDigitalDocument)).toBe(true);
    expect(page.name).toBe("Reading notes");
    expect(page.dateModified?.toISOString()).toBe("2026-06-01T09:30:00.000Z");
  });

  it("writes databases as schema:Dataset with their descriptions", async () => {
    const { pod } = await demoImport(notionAdapter);
    const ds = pod.dataset(DB_DOC);
    const db = new DataCollection(
      `${DB_DOC}#db-d9824bdc-8445-4327-be8b-5b47500af6ce`,
      ds,
      DataFactory,
    );
    expect(db.types.has(CLASSES.Dataset)).toBe(true);
    expect(db.name).toBe("Habit tracker");
    expect(db.description).toBe("Daily habits, one row per day.");
  });

  it("registers both documents classes", async () => {
    const { pod, report } = await demoImport(notionAdapter);
    const index = pod.get(report.indexUrl) ?? "";
    expect(index).toContain(CLASSES.TextDigitalDocument);
    expect(index).toContain(CLASSES.Dataset);
    expect(index).toContain(`${ROOT}documents/`);
  });

  it("re-import is idempotent", async () => {
    const { pod } = await demoImport(notionAdapter);
    const before = pod.urls();
    const sizeBefore = pod.dataset(PAGES_DOC).size;
    await demoImport(notionAdapter, { pod });
    expect(pod.urls()).toEqual(before);
    expect(pod.dataset(PAGES_DOC).size).toBe(sizeBefore);
  });

  // Robustness: a page can have no `properties` object, a database no title,
  // dates can be malformed, and the results array can carry a null.
  it("survives a sparse live response (no properties, no title, null entry)", async () => {
    const { pod, report } = await sparseImport(notionAdapter, [
      {
        method: "POST",
        url: "https://api.notion.com/v1/search",
        json: {
          results: [
            // Page with no properties at all (Object.values must not throw).
            {
              object: "page",
              id: "p1",
              url: "https://www.notion.so/p1",
              created_time: "2026-01-01T00:00:00.000Z",
              last_edited_time: "bad-date",
            },
            // Database with no title/description and a null created_time.
            {
              object: "database",
              id: "d1",
              url: "https://www.notion.so/d1",
              created_time: null,
              last_edited_time: "2026-02-01T00:00:00.000Z",
            },
            null, // null result entry
            { object: "page", url: "https://www.notion.so/noid" }, // no id ⇒ skipped
          ],
        },
      },
    ]);

    expect(report.written.map((w) => w.url).sort()).toEqual([DB_DOC, PAGES_DOC]);
    expect(report.skipped).toBe(2); // null entry + id-less page

    const pages = expectCleanTurtle(pod, PAGES_DOC);
    const dbs = expectCleanTurtle(pod, DB_DOC);

    const p1 = new DigitalDocument(`${PAGES_DOC}#page-p1`, pages, DataFactory);
    expect(p1.name).toBe("Untitled"); // no title property ⇒ fallback
    expect(p1.dateModified).toBeUndefined(); // malformed date omitted

    const d1 = new DataCollection(`${DB_DOC}#db-d1`, dbs, DataFactory);
    expect(d1.name).toBe("Untitled database"); // no title ⇒ fallback
    expect(d1.description).toBeUndefined(); // omitted, not "null"
    expect(d1.dateCreated).toBeUndefined();
  });
});
