/**
 * Recorded Garmin Connect / Health API shapes (apis.garmin.com) — trimmed to
 * the fields the adapter reads.
 *
 * Garmin's Activity API returns an array of activity summaries. Fitness
 * activities (running, cycling) map to `schema:ExerciseAction` (Health);
 * navigation-style activities map to `schema:TravelAction` (Mobility). Each
 * summary carries an `activityType.typeKey`, a `startTimeGMT`, a
 * `durationInSeconds`, and a `distanceInMeters`.
 */
import type { FixtureRoute } from "../core/types.js";

export interface GarminActivity {
  activityId: number;
  activityName: string;
  activityType: { typeKey: string };
  startTimeGMT: string;
  durationInSeconds: number;
  distanceInMeters?: number;
}

export type GarminActivitiesAnswer = GarminActivity[];

export const ACTIVITIES: GarminActivitiesAnswer = [
  {
    activityId: 11_223_344_551,
    activityName: "Morning Run",
    activityType: { typeKey: "running" },
    startTimeGMT: "2026-06-08 06:30:00",
    durationInSeconds: 1980,
    distanceInMeters: 5430,
  },
  {
    activityId: 11_223_344_552,
    activityName: "Lunch Cycling",
    activityType: { typeKey: "cycling" },
    startTimeGMT: "2026-06-09 11:45:00",
    durationInSeconds: 3600,
    distanceInMeters: 22_100,
  },
  {
    activityId: 11_223_344_553,
    activityName: "Commute",
    activityType: { typeKey: "commuting" },
    startTimeGMT: "2026-06-10 08:05:00",
    durationInSeconds: 1500,
    distanceInMeters: 8200,
  },
];

export const GARMIN_FIXTURES: readonly FixtureRoute[] = [
  { url: "https://apis.garmin.com/activity-service/activities", json: ACTIVITIES },
];
