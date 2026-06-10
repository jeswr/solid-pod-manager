import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import { fileImport, memoryFile, TEST_POD_ROOT } from "../core/testing.js";
import { CLASSES, Invoice, TravelAction } from "../core/vocab.js";
import { uberFileAdapter } from "./file-adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/uber/`;
const TRIPS = `${ROOT}mobility/uber-trips.ttl`;
const FARES = `${ROOT}finance/uber-fares.ttl`;

const SAMPLE = `City,Product Type,Trip or Order Status,Begin Trip Time,Begin Trip Address,Dropoff Address,Distance (miles),Fare Amount,Fare Currency
London,UberX,COMPLETED,2023-02-14 09:30:00 +0000 UTC,10 Downing St,Liverpool St Station,3.40,14.50,GBP
London,UberX,CANCELED,2023-02-15 18:00:00 +0000 UTC,Soho,Camden,0,0,GBP`;

describe("uber file adapter", () => {
  it("writes trips to Mobility and fares to Finance", async () => {
    const { pod, report } = await fileImport(
      uberFileAdapter,
      memoryFile("trips_data.csv", SAMPLE, "text/csv"),
    );
    expect(report.categories.sort()).toEqual(["finance", "mobility"]);
    expect(report.written.map((w) => w.url).sort()).toEqual([FARES, TRIPS]);

    const trips = pod.dataset(TRIPS);
    const tripTypes = [...trips].filter(
      (q) => q.object.value === CLASSES.TravelAction && q.predicate.value.endsWith("type"),
    );
    expect(tripTypes).toHaveLength(2); // both trips (even the cancelled one)

    const fares = pod.dataset(FARES);
    const fareTypes = [...fares].filter(
      (q) => q.object.value === CLASSES.Invoice && q.predicate.value.endsWith("type"),
    );
    expect(fareTypes).toHaveLength(1); // only the completed (non-zero-fare) trip
  });

  it("captures distance, start time and fare details", async () => {
    const { pod } = await fileImport(
      uberFileAdapter,
      memoryFile("t.csv", SAMPLE, "text/csv"),
    );
    const trips = pod.dataset(TRIPS);
    const startQuad = [...trips].find((q) => q.predicate.value === "https://schema.org/startTime");
    const trip = new TravelAction(startQuad!.subject.value, trips, DataFactory);
    expect(trip.types.has(CLASSES.TravelAction)).toBe(true);
    expect(trip.distance).toBe("3.40 miles");
    expect(trip.startTime?.toISOString()).toBe("2023-02-14T09:30:00.000Z");

    const fares = pod.dataset(FARES);
    const fareQuad = [...fares].find((q) => q.predicate.value === "https://schema.org/totalPaymentDue");
    const inv = new Invoice(fareQuad!.subject.value, fares, DataFactory);
    expect(inv.totalPaymentDue).toBe("14.50");
    expect(inv.priceCurrency).toBe("GBP");
    expect(inv.provider).toBe("Uber");
  });

  it("registers both classes in the type index", async () => {
    const { pod, report } = await fileImport(
      uberFileAdapter,
      memoryFile("t.csv", SAMPLE, "text/csv"),
    );
    const index = pod.get(report.indexUrl) ?? "";
    expect(index).toContain(CLASSES.TravelAction);
    expect(index).toContain(CLASSES.Invoice);
  });
});
