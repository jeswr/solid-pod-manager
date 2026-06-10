import { describe, it, expect } from "vitest";
import {
  parseEvent,
  buildEvent,
  calendarStore,
  EVENT_CLASS,
  sortByStart,
  groupByDay,
  monthMatrix,
  dayKey,
  monthKey,
  type CalendarEvent,
} from "./calendar.js";
import type { StoredItem } from "./productivity-store.js";
import {
  createMemoryPod,
  TEST_POD_ROOT,
  TEST_WEBID,
} from "./integrations/core/testing.js";

const url = `${TEST_POD_ROOT}calendar/e.ttl`;

describe("buildEvent / parseEvent round-trip", () => {
  it("preserves all fields", () => {
    const start = new Date("2026-07-01T10:00:00.000Z");
    const end = new Date("2026-07-01T11:00:00.000Z");
    const ds = buildEvent(url, {
      name: "Standup",
      start,
      end,
      location: "Room 1",
      description: "Daily sync",
    });
    const ev = parseEvent(url, ds);
    expect(ev?.name).toBe("Standup");
    expect(ev?.start.toISOString()).toBe(start.toISOString());
    expect(ev?.end?.toISOString()).toBe(end.toISOString());
    expect(ev?.location).toBe("Room 1");
    expect(ev?.description).toBe("Daily sync");
  });

  it("stamps the Event class and allows an open-ended event", () => {
    const ds = buildEvent(url, { name: "Open", start: new Date("2026-07-02T09:00:00Z") });
    expect([...ds].some((q) => q.object.value === EVENT_CLASS)).toBe(true);
    const ev = parseEvent(url, ds);
    expect(ev?.end).toBeUndefined();
  });

  it("returns undefined when there is no start date", () => {
    // An Event with no start is not usable in the agenda — treat as absent.
    const ds = buildEvent(url, { name: "No start", start: new Date("2026-07-02T09:00:00Z") });
    // Strip the startDate triple.
    for (const q of [...ds]) {
      if (q.predicate.value.endsWith("startDate")) ds.delete(q);
    }
    expect(parseEvent(url, ds)).toBeUndefined();
  });
});

function item(name: string, iso: string): StoredItem<CalendarEvent> {
  return { url: `${url}#${name}`, etag: null, data: { name, start: new Date(iso) } };
}

describe("agenda helpers (pure)", () => {
  const events = [
    item("c", "2026-07-03T08:00:00Z"),
    item("a", "2026-07-01T09:00:00Z"),
    item("b", "2026-07-01T07:00:00Z"),
  ];

  it("sortByStart orders chronologically", () => {
    expect(sortByStart(events).map((e) => e.data.name)).toEqual(["b", "a", "c"]);
  });

  it("groupByDay buckets by day, days earliest-first, each sorted", () => {
    const days = groupByDay(events);
    expect(days).toHaveLength(2);
    expect(days[0].events.map((e) => e.data.name)).toEqual(["b", "a"]);
    expect(days[1].events.map((e) => e.data.name)).toEqual(["c"]);
  });

  it("dayKey / monthKey produce stable zero-padded keys", () => {
    const d = new Date(2026, 0, 5); // 5 Jan 2026 local
    expect(dayKey(d)).toBe("2026-01-05");
    expect(monthKey(d)).toBe("2026-01");
  });
});

describe("monthMatrix", () => {
  it("is always 6 weeks of 7 days and flags in/out-of-month cells", () => {
    const anchor = new Date(2026, 6, 15); // July 2026
    const grid = monthMatrix(anchor, []);
    expect(grid).toHaveLength(6);
    expect(grid.every((w) => w.length === 7)).toBe(true);
    // First cell is the Sunday on/before 1 July 2026 (1 July is a Wednesday).
    expect(grid[0][0].inMonth).toBe(false);
    const allDays = grid.flat();
    expect(allDays.filter((c) => c.inMonth)).toHaveLength(31); // July has 31 days
  });

  it("places an event in the correct day cell", () => {
    const anchor = new Date(2026, 6, 1);
    const ev = item("party", "2026-07-15T18:00:00");
    const grid = monthMatrix(anchor, [ev]);
    const cell = grid.flat().find((c) => c.events.length > 0);
    expect(cell?.date.getDate()).toBe(15);
    expect(cell?.events[0].data.name).toBe("party");
  });
});

describe("calendarStore (I/O)", () => {
  it("creates and lists events, ignoring non-events", async () => {
    const pod = createMemoryPod();
    const store = calendarStore({ podRoot: TEST_POD_ROOT, webId: TEST_WEBID, fetchImpl: pod.fetch });
    await store.create({ name: "A", start: new Date("2026-07-01T10:00:00Z") }, "A");
    await store.create({ name: "B", start: new Date("2026-07-02T10:00:00Z") }, "B");
    const items = await store.list();
    expect(items.map((i) => i.data.name).sort()).toEqual(["A", "B"]);
  });
});
