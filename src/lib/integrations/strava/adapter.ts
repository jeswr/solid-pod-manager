/**
 * Strava → Health + Mobility. `/athlete/activities`: runs/swims/workouts as
 * `schema:ExerciseAction` (Health), rides/commutes as `schema:TravelAction`
 * (Mobility).
 *
 * Incremental: the API supports `after=<epoch>` — the returned cursor is the
 * newest activity's start time; the next import fetches only newer activities
 * and **merges** them into the existing collection documents.
 *
 * Live-mode honesty: Strava's token endpoint requires the client secret (no
 * public PKCE) — live mode needs the maintainer's token proxy.
 */
import { DataFactory } from "n3";
import { asStore } from "../core/dataset.js";
import { getJson } from "../core/fixture-fetch.js";
import type { ImportContext, ImportOutcome, IntegrationAdapter } from "../core/types.js";
import { CLASSES, ExerciseAction, TravelAction } from "../core/vocab.js";
import { STRAVA_FIXTURES, type StravaActivity } from "./fixtures.js";

const ID = "strava";
const API = "https://www.strava.com/api/v3";
const SCOPES = ["read", "activity:read"] as const;

const RIDE_TYPES = new Set(["Ride", "EBikeRide", "GravelRide", "MountainBikeRide", "Commute"]);

export const stravaAdapter: IntegrationAdapter = {
  metadata: {
    id: ID,
    name: "Strava",
    tier: "A",
    authKind: "oauth-pkce",
    scopes: SCOPES,
    categories: ["health", "mobility"],
    whatYouGet: "Workouts and swims into Health; rides and commutes into Mobility.",
    requirements: [
      "Create an API application at strava.com/settings/api.",
      "Set the Authorization Callback Domain to the app's host.",
      "Set NEXT_PUBLIC_STRAVA_CLIENT_ID.",
      "Strava's token endpoint requires the client secret (no public PKCE): deploy the token-exchange proxy and set NEXT_PUBLIC_STRAVA_TOKEN_PROXY.",
    ],
  },
  oauth: {
    clientId: process.env.NEXT_PUBLIC_STRAVA_CLIENT_ID,
    authorizationEndpoint: "https://www.strava.com/oauth/authorize",
    tokenEndpoint: "https://www.strava.com/oauth/token",
    scopes: SCOPES,
    tokenExchange: "proxy",
    tokenProxyUrl: process.env.NEXT_PUBLIC_STRAVA_TOKEN_PROXY,
    extraAuthParams: { approval_prompt: "auto" },
  },
  fixtures: () => STRAVA_FIXTURES,

  async import(ctx: ImportContext): Promise<ImportOutcome> {
    ctx.progress({ label: "Fetching your activities…", done: 0, total: 2 });
    const after = ctx.cursor ? `&after=${encodeURIComponent(ctx.cursor)}` : "";
    const activities = await getJson<StravaActivity[]>(
      ID,
      ctx.api,
      `${API}/athlete/activities?per_page=100${after}`,
    );

    const workoutsDoc = ctx.resolve("fitness/activities.ttl");
    const ridesDoc = ctx.resolve("travel/rides.ttl");
    // Merge into what's already there (incremental imports append).
    const workouts = asStore(await ctx.read("fitness/activities.ttl"));
    const rides = asStore(await ctx.read("travel/rides.ttl"));

    for (const a of activities) {
      if (RIDE_TYPES.has(a.sport_type)) {
        const ride = new TravelAction(`${ridesDoc}#activity-${a.id}`, rides, DataFactory).mark();
        fill(ride, a);
      } else {
        const workout = new ExerciseAction(
          `${workoutsDoc}#activity-${a.id}`,
          workouts,
          DataFactory,
        ).mark();
        fill(workout, a);
        workout.exerciseType = a.sport_type;
      }
    }

    ctx.progress({ label: "Saving workouts and rides…", done: 1, total: 2 });
    await ctx.write({
      slug: "fitness/activities.ttl",
      category: "health",
      forClass: CLASSES.ExerciseAction,
      dataset: workouts,
    });
    await ctx.write({
      slug: "travel/rides.ttl",
      category: "mobility",
      forClass: CLASSES.TravelAction,
      dataset: rides,
    });

    ctx.progress({ label: "Done", done: 2, total: 2 });
    return { cursor: nextCursor(ctx.cursor, activities) };
  },
};

function fill(action: ExerciseAction | TravelAction, a: StravaActivity): void {
  action.name = a.name;
  action.identifier = String(a.id);
  action.startTime = new Date(a.start_date);
  action.duration = `PT${Math.floor(a.moving_time / 60)}M${a.moving_time % 60}S`;
  action.distance = `${(a.distance / 1000).toFixed(1)} km`;
  action.sourceUrl = `https://www.strava.com/activities/${a.id}`;
}


/** Newest start time (epoch seconds) across old cursor + new activities. */
function nextCursor(previous: string | undefined, activities: StravaActivity[]): string | undefined {
  const epochs = activities.map((a) => Math.floor(Date.parse(a.start_date) / 1000));
  if (previous) epochs.push(Number.parseInt(previous, 10) || 0);
  return epochs.length > 0 ? String(Math.max(...epochs)) : previous;
}
