import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import { fileImport, memoryFile, TEST_POD_ROOT } from "../core/testing.js";
import { CLASSES, Invoice } from "../core/vocab.js";
import { amazonOrdersFileAdapter, parseDate } from "./file-adapter.js";

const DOC = `${TEST_POD_ROOT}integrations/amazon-orders/finance/amazon-orders.ttl`;

// Realistic Amazon "Retail.OrderHistory" CSV columns.
const SAMPLE = `Order ID,Order Date,Product Name,Total Owed,Currency,Order Status
111-2223334-5556667,2023-02-14,"USB-C Cable, 2-pack",12.99,USD,Closed
111-9998887-6665554,2023-03-01,Mechanical Keyboard,89.00,USD,Closed`;

describe("amazon-orders file adapter", () => {
  it("writes each order as a schema:Invoice in Finance", async () => {
    const { pod, report } = await fileImport(
      amazonOrdersFileAdapter,
      memoryFile("Retail.OrderHistory.1.csv", SAMPLE, "text/csv"),
    );
    expect(report.categories).toEqual(["finance"]);
    expect(report.written.map((w) => w.url)).toEqual([DOC]);

    const ds = pod.dataset(DOC);
    const types = [...ds].filter(
      (q) => q.predicate.value.endsWith("type") && q.object.value === CLASSES.Invoice,
    );
    expect(types).toHaveLength(2);
  });

  it("captures product, total, currency, status and date", async () => {
    const { pod } = await fileImport(
      amazonOrdersFileAdapter,
      memoryFile("orders.csv", SAMPLE, "text/csv"),
    );
    const ds = pod.dataset(DOC);
    const nameQuad = [...ds].find(
      (q) => q.predicate.value === "https://schema.org/name" && q.object.value === "Mechanical Keyboard",
    );
    expect(nameQuad).toBeDefined();
    const inv = new Invoice(nameQuad!.subject.value, ds, DataFactory);
    expect(inv.provider).toBe("Amazon");
    expect(inv.totalPaymentDue).toBe("89.00");
    expect(inv.priceCurrency).toBe("USD");
    expect(inv.paymentStatus).toBe("Closed");
    expect(inv.identifier).toBe("111-9998887-6665554");
    expect(inv.dateCreated?.toISOString().slice(0, 10)).toBe("2023-03-01");
  });

  it("registers Invoice in the type index", async () => {
    const { pod, report } = await fileImport(
      amazonOrdersFileAdapter,
      memoryFile("orders.csv", SAMPLE, "text/csv"),
    );
    expect(pod.get(report.indexUrl)).toContain(CLASSES.Invoice);
  });
});

describe("parseDate", () => {
  it("parses ISO and US formats", () => {
    expect(parseDate("2023-02-14")?.toISOString().slice(0, 10)).toBe("2023-02-14");
    expect(parseDate("2/14/2023")?.toISOString().slice(0, 10)).toBe("2023-02-14");
  });
  it("returns undefined for empty/junk", () => {
    expect(parseDate(undefined)).toBeUndefined();
    expect(parseDate("soon")).toBeUndefined();
  });
});
