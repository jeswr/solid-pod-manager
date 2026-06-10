import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import { demoImport, TEST_POD_ROOT } from "../core/testing.js";
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
});
