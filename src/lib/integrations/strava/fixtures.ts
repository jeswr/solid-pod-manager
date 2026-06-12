/**
 * Recorded Strava API v3 shapes (www.strava.com/api/v3) — trimmed to the
 * fields the adapter reads. Source: GET /athlete/activities.
 */
import type { FixtureRoute } from "../core/types.js";

// Optionality reflects the live API: manual entries omit distance/time, and a
// freshly-created activity can lack a sport type momentarily.
export interface StravaActivity {
  id: number;
  name?: string | null;
  sport_type?: string | null; // "Run" | "Ride" | "Swim" | "Walk" | …
  distance?: number | null; // metres
  moving_time?: number | null; // seconds
  start_date?: string | null; // ISO
}

export const ACTIVITIES: StravaActivity[] = [
  {
    id: 11223344,
    name: "Morning Run",
    sport_type: "Run",
    distance: 5210.3,
    moving_time: 1622,
    start_date: "2026-06-05T06:31:00Z",
  },
  {
    id: 11223345,
    name: "Commute to work",
    sport_type: "Ride",
    distance: 8350.0,
    moving_time: 1410,
    start_date: "2026-06-04T07:58:00Z",
  },
  {
    id: 11223346,
    name: "Lunch swim",
    sport_type: "Swim",
    distance: 1000.0,
    moving_time: 1845,
    start_date: "2026-06-02T12:10:00Z",
  },
];

export const STRAVA_FIXTURES: readonly FixtureRoute[] = [
  { url: "https://www.strava.com/api/v3/athlete/activities", json: ACTIVITIES },
];
