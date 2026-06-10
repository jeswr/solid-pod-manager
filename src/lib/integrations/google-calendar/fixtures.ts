/**
 * Recorded Google Calendar API v3 shapes
 * (www.googleapis.com/calendar/v3) — trimmed to the fields the adapter reads.
 * Source: GET /calendars/primary/events. Timed events carry
 * `start.dateTime`; all-day events carry `start.date`.
 */
import type { FixtureRoute } from "../core/types.js";

export interface GCalEventDateTime {
  /** RFC 3339 timestamp for timed events. */
  dateTime?: string;
  /** `YYYY-MM-DD` for all-day events. */
  date?: string;
  timeZone?: string;
}

export interface GCalEvent {
  id: string;
  status: string;
  htmlLink: string;
  summary?: string;
  description?: string;
  location?: string;
  start: GCalEventDateTime;
  end: GCalEventDateTime;
  created?: string;
  updated?: string;
}

export interface GCalEventsList {
  items: GCalEvent[];
  nextPageToken?: string;
}

export const EVENTS: GCalEventsList = {
  items: [
    {
      id: "7p4f2k9q1m3n8s0a",
      status: "confirmed",
      htmlLink: "https://www.google.com/calendar/event?eid=7p4f2k9q1m3n8s0a",
      summary: "Team standup",
      description: "Daily sync — what shipped, what's blocked.",
      location: "Meet: meet.google.com/abc-defg-hij",
      start: { dateTime: "2026-06-11T09:00:00+01:00", timeZone: "Europe/London" },
      end: { dateTime: "2026-06-11T09:15:00+01:00", timeZone: "Europe/London" },
      created: "2026-05-01T12:00:00Z",
      updated: "2026-06-01T08:30:00Z",
    },
    {
      id: "a1b2c3d4e5f6g7h8",
      status: "confirmed",
      htmlLink: "https://www.google.com/calendar/event?eid=a1b2c3d4e5f6g7h8",
      summary: "Dentist",
      location: "12 High Street, London",
      start: { dateTime: "2026-06-12T14:30:00+01:00", timeZone: "Europe/London" },
      end: { dateTime: "2026-06-12T15:00:00+01:00", timeZone: "Europe/London" },
      created: "2026-04-20T10:00:00Z",
      updated: "2026-04-20T10:00:00Z",
    },
    {
      id: "z9y8x7w6v5u4t3s2",
      status: "confirmed",
      htmlLink: "https://www.google.com/calendar/event?eid=z9y8x7w6v5u4t3s2",
      summary: "Public holiday",
      start: { date: "2026-06-15" },
      end: { date: "2026-06-16" },
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    },
  ],
};

export const GOOGLE_CALENDAR_FIXTURES: readonly FixtureRoute[] = [
  {
    url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    json: EVENTS,
  },
];
