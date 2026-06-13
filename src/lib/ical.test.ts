// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { exportICal, importICal, formatICalDate, parseICalDate } from "./ical.js";
import type { CalendarEvent } from "./calendar.js";
import type { Task } from "./tasks.js";

describe("formatICalDate / parseICalDate", () => {
  it("round-trips a UTC date-time", () => {
    const d = new Date("2026-07-01T09:30:00Z");
    const s = formatICalDate(d);
    expect(s).toBe("20260701T093000Z");
    expect(parseICalDate(s)?.getTime()).toBe(d.getTime());
  });
  it("parses a date-only value", () => {
    const d = parseICalDate("20260701");
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(6);
    expect(d?.getDate()).toBe(1);
  });
  it("returns undefined for garbage", () => {
    expect(parseICalDate("nope")).toBeUndefined();
  });
  it("rejects out-of-range fields instead of rolling them over", () => {
    expect(parseICalDate("20260231")).toBeUndefined(); // Feb 31 → would roll to Mar
    expect(parseICalDate("20261301")).toBeUndefined(); // month 13
    expect(parseICalDate("20260101T250000Z")).toBeUndefined(); // hour 25
    expect(parseICalDate("20260101T006000Z")).toBeUndefined(); // minute 60
  });
});

describe("iCal events round-trip", () => {
  it("exports and re-imports an event with all fields", () => {
    const event: CalendarEvent = {
      name: "Team sync; planning",
      start: new Date("2026-07-01T09:00:00Z"),
      end: new Date("2026-07-01T10:00:00Z"),
      location: "Room 1, Floor 2",
      description: "Agenda:\n- one\n- two",
    };
    const ics = exportICal({ events: [event] });
    expect(ics).toContain("BEGIN:VEVENT");
    const { events } = importICal(ics);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.name).toBe("Team sync; planning");
    expect(e.start.getTime()).toBe(event.start.getTime());
    expect(e.end?.getTime()).toBe(event.end?.getTime());
    expect(e.location).toBe("Room 1, Floor 2");
    expect(e.description).toBe("Agenda:\n- one\n- two");
  });

  it("emits a stable UID for the same event across exports", () => {
    const event: CalendarEvent = { name: "Standup", start: new Date("2026-01-01T09:00:00Z") };
    const uid = (ics: string) => /UID:([^\r\n]+)/.exec(ics)?.[1];
    expect(uid(exportICal({ events: [event] }))).toBe(uid(exportICal({ events: [event] })));
    // A different event yields a different UID.
    const other: CalendarEvent = { name: "Standup", start: new Date("2026-02-01T09:00:00Z") };
    expect(uid(exportICal({ events: [event] }))).not.toBe(uid(exportICal({ events: [other] })));
  });

  it("gives same-titled, same-time events distinct UIDs when a url seeds them", () => {
    const data: CalendarEvent = { name: "Sync", start: new Date("2026-01-01T09:00:00Z") };
    const ics = exportICal({
      events: [
        { data, url: "https://pod.test/alice/calendar/a.ttl" },
        { data, url: "https://pod.test/alice/calendar/b.ttl" },
      ],
    });
    const uids = [...ics.matchAll(/UID:([^\r\n]+)/g)].map((m) => m[1]);
    expect(uids).toHaveLength(2);
    expect(uids[0]).not.toBe(uids[1]);
  });

  it("escapes and unescapes special characters", () => {
    const event: CalendarEvent = {
      name: "A, B; C\\D",
      start: new Date("2026-01-01T00:00:00Z"),
    };
    const ics = exportICal({ events: [event] });
    const { events } = importICal(ics);
    expect(events[0].name).toBe("A, B; C\\D");
  });

  it("normalises bare CR / CRLF in text to escaped newlines", () => {
    const event: CalendarEvent = {
      name: "x",
      start: new Date("2026-01-01T00:00:00Z"),
      description: "line one\r\nline two\rline three",
    };
    const ics = exportICal({ events: [event] });
    // No raw CR should survive into the serialised output's logical content.
    expect(/DESCRIPTION:[^\r\n]*\\nline two\\nline three/.test(ics)).toBe(true);
    const { events } = importICal(ics);
    expect(events[0].description).toBe("line one\nline two\nline three");
  });
});

describe("iCal tasks round-trip", () => {
  it("exports and re-imports a task with due/status/priority", () => {
    const task: Task = {
      title: "Finish slides",
      description: "for Friday",
      due: new Date("2026-07-03T17:00:00Z"),
      completed: false,
      priority: "high",
    };
    const ics = exportICal({ tasks: [task] });
    expect(ics).toContain("BEGIN:VTODO");
    const { tasks } = importICal(ics);
    expect(tasks).toHaveLength(1);
    const t = tasks[0];
    expect(t.title).toBe("Finish slides");
    expect(t.description).toBe("for Friday");
    expect(t.due?.getTime()).toBe(task.due?.getTime());
    expect(t.completed).toBe(false);
    expect(t.priority).toBe("high");
  });

  it("round-trips a completed task", () => {
    const task: Task = { title: "Done thing", completed: true, priority: "none" };
    const { tasks } = importICal(exportICal({ tasks: [task] }));
    expect(tasks[0].completed).toBe(true);
    expect(tasks[0].priority).toBe("none");
  });

  it("treats PERCENT-COMPLETE:100 or a COMPLETED timestamp as done", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VTODO",
      "SUMMARY:By percent",
      "PERCENT-COMPLETE:100",
      "END:VTODO",
      "BEGIN:VTODO",
      "SUMMARY:By timestamp",
      "COMPLETED:20260101T000000Z",
      "END:VTODO",
      "BEGIN:VTODO",
      "SUMMARY:Still open",
      "PERCENT-COMPLETE:50",
      "END:VTODO",
      "END:VCALENDAR",
    ].join("\r\n");
    const { tasks } = importICal(ics);
    expect(tasks.map((t) => t.completed)).toEqual([true, true, false]);
  });
});

describe("iCal mixed + resilience", () => {
  it("exports events and tasks into one VCALENDAR", () => {
    const ics = exportICal({
      events: [{ name: "E", start: new Date("2026-01-01T00:00:00Z") }],
      tasks: [{ title: "T", completed: false, priority: "none" }],
    });
    const { events, tasks } = importICal(ics);
    expect(events).toHaveLength(1);
    expect(tasks).toHaveLength(1);
  });

  it("skips an event with no DTSTART, keeps the rest", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:No start",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "SUMMARY:Has start",
      "DTSTART:20260101T000000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const { events } = importICal(ics);
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("Has start");
  });

  it("unfolds long folded lines", () => {
    const long = "A".repeat(200);
    const ics = exportICal({ events: [{ name: long, start: new Date("2026-01-01T00:00:00Z") }] });
    // Exported content must have been folded somewhere.
    expect(ics.split("\r\n").some((l) => l.startsWith(" "))).toBe(true);
    const { events } = importICal(ics);
    expect(events[0].name).toBe(long);
  });

  it("counts recurring components but imports the base occurrence", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:Standup",
      "DTSTART:20260101T090000Z",
      "RRULE:FREQ=DAILY;COUNT=10",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "SUMMARY:One-off",
      "DTSTART:20260102T090000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const { events, recurringCount } = importICal(ics);
    expect(events).toHaveLength(2);
    expect(recurringCount).toBe(1);
  });

  it("imports a BOM-prefixed .ics", () => {
    const ics = `\uFEFF${[
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:Bommed",
      "DTSTART:20260101T000000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n")}`;
    const { events } = importICal(ics);
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("Bommed");
  });

  it("ignores unknown components and properties", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VTIMEZONE",
      "TZID:Europe/London",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "SUMMARY:Real",
      "DTSTART:20260101T000000Z",
      "X-CUSTOM:whatever",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");
    const { events } = importICal(ics);
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("Real");
  });

  it("counts TZID-qualified date properties so the UI can warn", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:Zoned",
      "DTSTART;TZID=America/New_York:20260701T090000",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "SUMMARY:Utc",
      "DTSTART:20260702T090000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const { events, timezoneQualifiedCount } = importICal(ics);
    expect(events).toHaveLength(2);
    expect(timezoneQualifiedCount).toBe(1);
  });

  it("counts VALUE=DATE all-day events (but not VALUE=DATE-TIME) for a warning", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:All day",
      "DTSTART;VALUE=DATE:20260701",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "SUMMARY:Timed",
      "DTSTART;VALUE=DATE-TIME:20260702T090000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const { events, dateOnlyCount } = importICal(ics);
    expect(events).toHaveLength(2);
    expect(dateOnlyCount).toBe(1);
  });

  it("does not let a nested VALARM leak its properties into the event", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:Real event",
      "DTSTART:20260101T090000Z",
      "DESCRIPTION:The real description",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:Alarm reminder text",
      "TRIGGER:-PT15M",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const { events } = importICal(ics);
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("Real event");
    expect(events[0].description).toBe("The real description");
  });

  it("round-trips non-ASCII content and folds on UTF-8 octet boundaries", () => {
    // 40 multi-byte chars → ~120 UTF-8 octets, forcing a fold.
    const name = "café—naïve—".repeat(8);
    const ics = exportICal({ events: [{ name, start: new Date("2026-01-01T00:00:00Z") }] });
    // No physical line may exceed 75 UTF-8 octets.
    for (const line of ics.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    const { events } = importICal(ics);
    expect(events[0].name).toBe(name);
  });
});
