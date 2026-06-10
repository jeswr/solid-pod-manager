/**
 * Recorded Fitbit Web API shapes (api.fitbit.com) — trimmed to the fields the
 * adapter reads.
 *
 * Daily activity summary: GET /1/user/-/activities/date/{date}.json returns an
 * `activities[]` array of logged exercises (each with `activityName`,
 * `startTime`, `duration` ms, `distance` km, `steps`). The adapter maps each
 * logged activity to a `schema:ExerciseAction`.
 */
import type { FixtureRoute } from "../core/types.js";

export interface FitbitActivity {
  logId: number;
  activityName: string;
  startTime: string;
  startDate: string;
  duration: number;
  distance?: number;
  steps?: number;
  calories?: number;
}

export interface FitbitActivitiesAnswer {
  activities: FitbitActivity[];
}

export const ACTIVITIES: FitbitActivitiesAnswer = {
  activities: [
    {
      logId: 51817963271,
      activityName: "Run",
      startDate: "2026-06-08",
      startTime: "07:12",
      duration: 1_860_000,
      distance: 5.2,
      steps: 6120,
      calories: 432,
    },
    {
      logId: 51817991042,
      activityName: "Walk",
      startDate: "2026-06-09",
      startTime: "12:35",
      duration: 1_500_000,
      distance: 2.1,
      steps: 2890,
      calories: 118,
    },
    {
      logId: 51818004412,
      activityName: "Bike",
      startDate: "2026-06-10",
      startTime: "18:02",
      duration: 2_700_000,
      distance: 14.8,
      calories: 540,
    },
  ],
};

export const FITBIT_FIXTURES: readonly FixtureRoute[] = [
  { url: "https://api.fitbit.com/1/user/-/activities/list.json", json: ACTIVITIES },
];
