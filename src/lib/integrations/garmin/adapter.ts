/**
 * Garmin → Health + Mobility. Your Garmin Connect activities split by kind:
 * fitness activities (running, cycling…) become `schema:ExerciseAction` in
 * Health; travel/commute activities become `schema:TravelAction` in Mobility.
 *
 * Tier B: Garmin's Health/Connect APIs are partner-program gated — Garmin must
 * admit the app before it can read a user's activities. Garmin uses OAuth with
 * a confidential client, so live mode runs code→token through the maintainer's
 * token proxy. Demoable now against recorded fixtures.
 *
 * Hybrid: Garmin also has a self-serve data export, so `file-adapter.ts`
 * complements this OAuth adapter under the same catalog id — the connect page
 * shows the approval-gated OAuth path AND a working real-data file import.
 * The partner-program application draft lives in
 * `docs/garmin-partner-application.md`.
 */
import { DataFactory, Store } from "n3";
import { getJson } from "../core/fixture-fetch.js";
import type { ImportContext, ImportOutcome, IntegrationAdapter } from "../core/types.js";
import { CLASSES, ExerciseAction, TravelAction } from "../core/vocab.js";
import { type GarminActivitiesAnswer, GARMIN_FIXTURES } from "./fixtures.js";

const ID = "garmin";
const API = "https://apis.garmin.com";
const SCOPES = ["activity:read"] as const;

/** typeKeys Garmin uses for navigation/transport rather than exercise. */
const TRAVEL_TYPES = new Set(["commuting", "transition", "driving", "motorcycling"]);

export const garminAdapter: IntegrationAdapter = {
  metadata: {
    id: ID,
    name: "Garmin",
    tier: "B",
    authKind: "oauth-pkce",
    scopes: SCOPES,
    categories: ["health", "mobility"],
    whatYouGet:
      "Your Garmin activities — workouts into Health, commutes and journeys into Mobility.",
    requirements: [
      "Garmin partner-program (Health/Connect API) approval: Garmin must admit the app to its developer program before it can read a user's activities.",
      "Register at developer.garmin.com and add <app-origin>/oauth-callback.html as the redirect URI.",
      "Garmin uses a confidential OAuth client, so set NEXT_PUBLIC_GARMIN_CLIENT_ID and deploy the token proxy at NEXT_PUBLIC_GARMIN_TOKEN_PROXY.",
    ],
  },
  oauth: {
    clientId: process.env.NEXT_PUBLIC_GARMIN_CLIENT_ID,
    authorizationEndpoint: "https://connect.garmin.com/oauth2Confirm",
    tokenEndpoint: "https://diauth.garmin.com/di-oauth2-service/oauth/token",
    scopes: SCOPES,
    tokenExchange: "proxy",
    tokenProxyUrl: process.env.NEXT_PUBLIC_GARMIN_TOKEN_PROXY,
  },
  fixtures: () => GARMIN_FIXTURES,

  async import(ctx: ImportContext): Promise<ImportOutcome> {
    ctx.progress({ label: "Fetching your Garmin activities…", done: 0, total: 2 });
    const list = await getJson<GarminActivitiesAnswer>(
      ID,
      ctx.api,
      `${API}/activity-service/activities?limit=100`,
    );

    const exDoc = ctx.resolve("health/activities.ttl");
    const travelDoc = ctx.resolve("mobility/journeys.ttl");
    const exercises = new Store();
    const journeys = new Store();

    for (const a of list) {
      const start = new Date(`${a.startTimeGMT.replace(" ", "T")}Z`);
      const distance = a.distanceInMeters !== undefined ? metresToKm(a.distanceInMeters) : undefined;
      if (TRAVEL_TYPES.has(a.activityType.typeKey)) {
        const tr = new TravelAction(`${travelDoc}#journey-${a.activityId}`, journeys, DataFactory).mark();
        tr.name = a.activityName;
        tr.identifier = String(a.activityId);
        tr.startTime = start;
        tr.duration = isoDuration(a.durationInSeconds);
        if (distance) tr.distance = distance;
        tr.sourceUrl = `https://connect.garmin.com/modern/activity/${a.activityId}`;
      } else {
        const ex = new ExerciseAction(`${exDoc}#activity-${a.activityId}`, exercises, DataFactory).mark();
        ex.name = a.activityName;
        ex.identifier = String(a.activityId);
        ex.exerciseType = a.activityType.typeKey;
        ex.startTime = start;
        ex.duration = isoDuration(a.durationInSeconds);
        if (distance) ex.distance = distance;
        ex.sourceUrl = `https://connect.garmin.com/modern/activity/${a.activityId}`;
      }
    }

    await ctx.write({
      slug: "health/activities.ttl",
      category: "health",
      forClass: CLASSES.ExerciseAction,
      dataset: exercises,
    });
    ctx.progress({ label: "Saving your journeys…", done: 1, total: 2 });
    await ctx.write({
      slug: "mobility/journeys.ttl",
      category: "mobility",
      forClass: CLASSES.TravelAction,
      dataset: journeys,
    });

    ctx.progress({ label: "Done", done: 2, total: 2 });
    return {};
  },
};

function metresToKm(m: number): string {
  return `${(m / 1000).toFixed(1)} km`;
}

/** Seconds → ISO-8601 duration (`PT33M`). */
function isoDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `PT${h > 0 ? `${h}H` : ""}${m > 0 ? `${m}M` : ""}${s > 0 || (h === 0 && m === 0) ? `${s}S` : ""}`;
}
