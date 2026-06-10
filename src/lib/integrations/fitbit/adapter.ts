/**
 * Fitbit → Health. Your logged activities (`/1/user/-/activities/list.json`)
 * as `schema:ExerciseAction` (type, start time, duration, distance).
 *
 * Tier B: Fitbit requires developer app review (and a personal/server app
 * type) before intraday and historical activity scopes can serve real users.
 * Fitbit's OAuth requires a confidential client for the code→token exchange,
 * so live mode goes through the maintainer's token proxy. Demoable now against
 * recorded fixtures.
 */
import { DataFactory, Store } from "n3";
import { getJson } from "../core/fixture-fetch.js";
import type { ImportContext, ImportOutcome, IntegrationAdapter } from "../core/types.js";
import { CLASSES, ExerciseAction } from "../core/vocab.js";
import { type FitbitActivitiesAnswer, FITBIT_FIXTURES } from "./fixtures.js";

const ID = "fitbit";
const API = "https://api.fitbit.com";
const SCOPES = ["activity", "heartrate", "sleep"] as const;

export const fitbitAdapter: IntegrationAdapter = {
  metadata: {
    id: ID,
    name: "Fitbit",
    tier: "B",
    authKind: "oauth-pkce",
    scopes: SCOPES,
    categories: ["health"],
    whatYouGet: "Your logged activities — runs, walks and rides — saved into Health.",
    requirements: [
      "Fitbit developer app review for intraday data: Fitbit must approve the app before activity/heart-rate scopes can serve real users.",
      "Register an app at dev.fitbit.com and add <app-origin>/oauth-callback.html as the redirect URI.",
      "Fitbit needs a confidential client for token exchange, so set NEXT_PUBLIC_FITBIT_CLIENT_ID and deploy the token proxy at NEXT_PUBLIC_FITBIT_TOKEN_PROXY.",
    ],
  },
  oauth: {
    clientId: process.env.NEXT_PUBLIC_FITBIT_CLIENT_ID,
    authorizationEndpoint: "https://www.fitbit.com/oauth2/authorize",
    tokenEndpoint: "https://api.fitbit.com/oauth2/token",
    scopes: SCOPES,
    tokenExchange: "proxy",
    tokenProxyUrl: process.env.NEXT_PUBLIC_FITBIT_TOKEN_PROXY,
  },
  fixtures: () => FITBIT_FIXTURES,

  async import(ctx: ImportContext): Promise<ImportOutcome> {
    ctx.progress({ label: "Fetching your activity log…", done: 0, total: 1 });
    const answer = await getJson<FitbitActivitiesAnswer>(
      ID,
      ctx.api,
      `${API}/1/user/-/activities/list.json?sort=desc&offset=0&limit=100`,
    );

    const doc = ctx.resolve("health/activities.ttl");
    const activities = new Store();
    for (const a of answer.activities) {
      const ex = new ExerciseAction(`${doc}#activity-${a.logId}`, activities, DataFactory).mark();
      ex.name = a.activityName;
      ex.identifier = String(a.logId);
      ex.exerciseType = a.activityName;
      ex.startTime = startDateTime(a.startDate, a.startTime);
      ex.duration = isoDuration(a.duration);
      if (a.distance !== undefined) ex.distance = `${a.distance} km`;
      ex.sourceUrl = `https://www.fitbit.com/activities/exercise/${a.logId}`;
    }
    await ctx.write({
      slug: "health/activities.ttl",
      category: "health",
      forClass: CLASSES.ExerciseAction,
      dataset: activities,
    });

    ctx.progress({ label: "Done", done: 1, total: 1 });
    return {};
  },
};

/** Fitbit splits date + local time; compose an ISO timestamp (no offset known). */
function startDateTime(date: string, time: string): Date {
  return new Date(`${date}T${time.length === 5 ? `${time}:00` : time}Z`);
}

/** Milliseconds → ISO-8601 duration (`PT31M`). */
function isoDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `PT${h > 0 ? `${h}H` : ""}${m > 0 ? `${m}M` : ""}${s > 0 || (h === 0 && m === 0) ? `${s}S` : ""}`;
}
