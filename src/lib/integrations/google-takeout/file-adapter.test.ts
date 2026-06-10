import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import { fileImport, memoryFile, TEST_POD_ROOT } from "../core/testing.js";
import { CalendarEvent, CLASSES, WatchAction } from "../core/vocab.js";
import { googleTakeoutFileAdapter, parseMyActivity } from "./file-adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/google-takeout/`;
const DOCS = `${ROOT}documents/google-activity.ttl`;
const MEDIA = `${ROOT}media/youtube-activity.ttl`;
const CAL = `${ROOT}calendar/google-calendar-activity.ttl`;

const SAMPLE = JSON.stringify([
  {
    header: "YouTube",
    title: "Watched Solid in 5 minutes",
    titleUrl: "https://www.youtube.com/watch?v=abc",
    time: "2023-02-14T09:00:00Z",
  },
  {
    header: "Search",
    title: "Searched for solid pods",
    titleUrl: "https://www.google.com/search?q=solid+pods",
    time: "2023-02-14T09:05:00Z",
  },
  {
    header: "Calendar",
    title: "Attended Standup",
    time: "2023-02-14T10:00:00Z",
  },
  {
    header: "Search",
    title: "javascript:alert(1)", // hostile title — must become an inert literal
    titleUrl: "javascript:alert(1)", // hostile url — must be dropped
    time: "2023-02-14T11:00:00Z",
  },
]);

describe("google-takeout file adapter", () => {
  it("routes activity to Documents, Media and Calendar", async () => {
    const { pod, report } = await fileImport(
      googleTakeoutFileAdapter,
      memoryFile("MyActivity.json", SAMPLE, "application/json"),
    );
    expect(report.categories.sort()).toEqual(["calendar", "documents", "media"]);
    expect(report.written.map((w) => w.url).sort()).toEqual([CAL, DOCS, MEDIA].sort());

    const media = pod.dataset(MEDIA);
    const watch = [...media].find((q) => q.predicate.value === "https://schema.org/name");
    const w = new WatchAction(watch!.subject.value, media, DataFactory);
    expect(w.types.has(CLASSES.WatchAction)).toBe(true);
    expect(w.sourceUrl).toBe("https://www.youtube.com/watch?v=abc");

    const cal = pod.dataset(CAL);
    const evQuad = [...cal].find((q) => q.predicate.value === "https://schema.org/name");
    const ev = new CalendarEvent(evQuad!.subject.value, cal, DataFactory);
    expect(ev.types.has(CLASSES.Event)).toBe(true);
    expect(ev.startDate?.toISOString()).toBe("2023-02-14T10:00:00.000Z");
  });

  it("stores a hostile title as a plain literal and drops a javascript: url", async () => {
    const { pod } = await fileImport(
      googleTakeoutFileAdapter,
      memoryFile("a.json", SAMPLE, "application/json"),
    );
    const docs = pod.dataset(DOCS);
    const hostile = [...docs].find(
      (q) => q.predicate.value === "https://schema.org/name" && q.object.value === "javascript:alert(1)",
    );
    expect(hostile).toBeDefined(); // present, but as an inert string literal
    expect(hostile!.object.termType).toBe("Literal");
    // No schema:url triple was written for the dropped javascript: URL.
    const urls = [...docs].filter((q) => q.predicate.value === "https://schema.org/url");
    expect(urls.map((q) => q.object.value)).not.toContain("javascript:alert(1)");
  });

  it("registers all three classes in the type index", async () => {
    const { pod, report } = await fileImport(
      googleTakeoutFileAdapter,
      memoryFile("a.json", SAMPLE, "application/json"),
    );
    const index = pod.get(report.indexUrl) ?? "";
    expect(index).toContain(CLASSES.WatchAction);
    expect(index).toContain(CLASSES.Event);
    expect(index).toContain(CLASSES.TextDigitalDocument);
  });
});

describe("parseMyActivity", () => {
  it("returns [] for a non-array / invalid JSON", () => {
    expect(parseMyActivity("{}")).toEqual([]);
    expect(parseMyActivity("nope")).toEqual([]);
  });
  it("respects the limit", () => {
    expect(parseMyActivity(SAMPLE, 2)).toHaveLength(2);
  });
});
