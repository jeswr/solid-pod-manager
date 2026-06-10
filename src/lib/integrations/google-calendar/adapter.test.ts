import { DataFactory } from "n3";
import { describe, expect, it } from "vitest";
import { demoImport, TEST_POD_ROOT } from "../core/testing.js";
import { CalendarEvent, CLASSES } from "../core/vocab.js";
import { googleCalendarAdapter } from "./adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/google-calendar/`;
const EVENTS_DOC = `${ROOT}calendar/events.ttl`;

describe("google-calendar adapter contract", () => {
  it("writes events as typed schema:Event into Calendar", async () => {
    const { pod, report } = await demoImport(googleCalendarAdapter);

    expect(report.written.map((w) => w.url)).toEqual([EVENTS_DOC]);
    expect(report.categories).toEqual(["calendar"]);

    const ds = pod.dataset(EVENTS_DOC);
    const standup = new CalendarEvent(`${EVENTS_DOC}#event-7p4f2k9q1m3n8s0a`, ds, DataFactory);
    expect(standup.types.has(CLASSES.Event)).toBe(true);
    expect(standup.name).toBe("Team standup");
    expect(standup.location).toBe("Meet: meet.google.com/abc-defg-hij");
    expect(standup.startDate?.toISOString()).toBe("2026-06-11T08:00:00.000Z");
    expect(standup.endDate?.toISOString()).toBe("2026-06-11T08:15:00.000Z");
  });

  it("handles all-day events (bare date)", async () => {
    const { pod } = await demoImport(googleCalendarAdapter);
    const ds = pod.dataset(EVENTS_DOC);
    const holiday = new CalendarEvent(`${EVENTS_DOC}#event-z9y8x7w6v5u4t3s2`, ds, DataFactory);
    expect(holiday.name).toBe("Public holiday");
    expect(holiday.startDate?.toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });

  it("registers the Event class for the calendar container", async () => {
    const { pod, report } = await demoImport(googleCalendarAdapter);
    const index = pod.get(report.indexUrl) ?? "";
    expect(index).toContain(CLASSES.Event);
    expect(index).toContain(`${ROOT}calendar/`);
  });

  it("is tier B with proxy token exchange", () => {
    expect(googleCalendarAdapter.metadata.tier).toBe("B");
    expect(googleCalendarAdapter.oauth?.tokenExchange).toBe("proxy");
  });

  it("re-import is idempotent (same docs, no growth)", async () => {
    const { pod } = await demoImport(googleCalendarAdapter);
    const before = pod.urls();
    const sizeBefore = pod.dataset(EVENTS_DOC).size;
    await demoImport(googleCalendarAdapter, { pod });
    expect(pod.urls()).toEqual(before);
    expect(pod.dataset(EVENTS_DOC).size).toBe(sizeBefore);
  });
});
