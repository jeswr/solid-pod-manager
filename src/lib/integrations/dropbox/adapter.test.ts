import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import { demoImport, TEST_POD_ROOT } from "../core/testing.js";
import { CLASSES, DigitalDocument } from "../core/vocab.js";
import { dropboxAdapter } from "./adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/dropbox/`;
const DOC = `${ROOT}documents/files.ttl`;

describe("dropbox adapter contract", () => {
  it("writes file metadata (never contents) as schema:DigitalDocument", async () => {
    const { pod, report } = await demoImport(dropboxAdapter);
    expect(report.categories).toEqual(["documents"]);

    const ds = pod.dataset(DOC);
    const file = new DigitalDocument(`${DOC}#file-ida4ayc_80_OEAAAAAAAAAYa`, ds, DataFactory);
    expect(file.types.has(CLASSES.DigitalDocument)).toBe(true);
    expect(file.name).toBe("Tax return 2025.pdf");
    expect(file.description).toBe("/Tax/Tax return 2025.pdf");
    expect(file.contentSize).toBe("1.8 MB");
    expect(file.dateModified?.toISOString()).toBe("2026-01-28T14:22:00.000Z");
  });

  it("skips folders — only files become documents", async () => {
    const { pod } = await demoImport(dropboxAdapter);
    const turtle = pod.get(DOC) ?? "";
    expect(turtle).not.toContain('"Tax"'); // the folder entry
    expect(turtle).toContain("House inventory.xlsx");
  });

  it("returns Dropbox's own cursor and continues from it incrementally", async () => {
    const { pod, report } = await demoImport(dropboxAdapter);
    expect(report.cursor).toBe("AAFmZ0123recordedcursor");

    // Second import takes the /continue path (empty delta) and changes nothing.
    const sizeBefore = pod.dataset(DOC).size;
    const second = await demoImport(dropboxAdapter, { pod, cursor: report.cursor });
    expect(second.report.cursor).toBe("AAFmZ0123recordedcursor");
    expect(pod.dataset(DOC).size).toBe(sizeBefore);
  });

  it("registers DigitalDocument for the documents container", async () => {
    const { pod, report } = await demoImport(dropboxAdapter);
    const index = pod.get(report.indexUrl) ?? "";
    expect(index).toContain(CLASSES.DigitalDocument);
    expect(index).toContain(`${ROOT}documents/`);
  });
});
