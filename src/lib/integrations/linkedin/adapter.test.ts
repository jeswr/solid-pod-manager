import { DataFactory } from "n3";
import { describe, expect, it } from "vitest";
import { demoImport, TEST_POD_ROOT } from "../core/testing.js";
import { CLASSES, WorkPosition } from "../core/vocab.js";
import { linkedinAdapter } from "./adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/linkedin/`;
const POS_DOC = `${ROOT}work/positions.ttl`;

describe("linkedin adapter contract", () => {
  it("writes positions as typed schema:Organization into Work & education", async () => {
    const { pod, report } = await demoImport(linkedinAdapter);

    expect(report.written.map((w) => w.url)).toEqual([POS_DOC]);
    expect(report.categories).toEqual(["work-education"]);

    const ds = pod.dataset(POS_DOC);
    const senior = new WorkPosition(`${POS_DOC}#position-1234567890`, ds, DataFactory);
    expect(senior.types.has(CLASSES.Organization)).toBe(true);
    expect(senior.name).toBe("Acme Corp");
    expect(senior.jobTitle).toBe("Senior Software Engineer");
    expect(senior.startDate?.toISOString()).toBe("2022-03-01T00:00:00.000Z");
    expect(senior.endDate).toBeUndefined();

    const prev = new WorkPosition(`${POS_DOC}#position-1234567891`, ds, DataFactory);
    expect(prev.endDate?.toISOString()).toBe("2022-02-01T00:00:00.000Z");
  });

  it("registers Organization for the work container", async () => {
    const { pod, report } = await demoImport(linkedinAdapter);
    const index = pod.get(report.indexUrl) ?? "";
    expect(index).toContain(CLASSES.Organization);
    expect(index).toContain(`${ROOT}work/`);
  });

  it("is tier B with proxy token exchange", () => {
    expect(linkedinAdapter.metadata.tier).toBe("B");
    expect(linkedinAdapter.oauth?.tokenExchange).toBe("proxy");
  });

  it("re-import is idempotent", async () => {
    const { pod } = await demoImport(linkedinAdapter);
    const before = pod.urls();
    const sizeBefore = pod.dataset(POS_DOC).size;
    await demoImport(linkedinAdapter, { pod });
    expect(pod.urls()).toEqual(before);
    expect(pod.dataset(POS_DOC).size).toBe(sizeBefore);
  });
});
