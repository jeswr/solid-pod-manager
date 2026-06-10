/**
 * LinkedIn → Work & education. Your work history (`/v2/positions`) as
 * `schema:Organization` nodes (the employer) carrying the role you held
 * (`schema:jobTitle`) and the dates worked.
 *
 * Tier B: LinkedIn gates member work-history behind its Member-data program —
 * approval is required before the app may read a real member's positions.
 * LinkedIn's OAuth uses a confidential client for code→token, so live mode
 * runs through the maintainer's token proxy. Demoable now against fixtures.
 */
import { DataFactory, Store } from "n3";
import { getJson } from "../core/fixture-fetch.js";
import type { ImportContext, ImportOutcome, IntegrationAdapter } from "../core/types.js";
import { CLASSES, WorkPosition } from "../core/vocab.js";
import { type LiPositionsAnswer, type LiYearMonth, LINKEDIN_FIXTURES } from "./fixtures.js";

const ID = "linkedin";
const API = "https://api.linkedin.com/v2";
const SCOPES = ["r_basicprofile", "r_member_social"] as const;

export const linkedinAdapter: IntegrationAdapter = {
  metadata: {
    id: ID,
    name: "LinkedIn",
    tier: "B",
    authKind: "oauth-pkce",
    scopes: SCOPES,
    categories: ["work-education"],
    whatYouGet: "Your roles and the organisations you worked for, saved into Work & education.",
    requirements: [
      "LinkedIn Member-data program approval: LinkedIn must admit the app to the program before it can read a member's work history.",
      "Create an app at linkedin.com/developers and add <app-origin>/oauth-callback.html as an authorised redirect URL.",
      "LinkedIn uses a confidential OAuth client, so set NEXT_PUBLIC_LINKEDIN_CLIENT_ID and deploy the token proxy at NEXT_PUBLIC_LINKEDIN_TOKEN_PROXY.",
    ],
  },
  oauth: {
    clientId: process.env.NEXT_PUBLIC_LINKEDIN_CLIENT_ID,
    authorizationEndpoint: "https://www.linkedin.com/oauth/v2/authorization",
    tokenEndpoint: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: SCOPES,
    tokenExchange: "proxy",
    tokenProxyUrl: process.env.NEXT_PUBLIC_LINKEDIN_TOKEN_PROXY,
  },
  fixtures: () => LINKEDIN_FIXTURES,

  async import(ctx: ImportContext): Promise<ImportOutcome> {
    ctx.progress({ label: "Fetching your work history…", done: 0, total: 1 });
    const answer = await getJson<LiPositionsAnswer>(ID, ctx.api, `${API}/positions`);

    const doc = ctx.resolve("work/positions.ttl");
    const positions = new Store();
    for (const p of answer.elements) {
      const pos = new WorkPosition(`${doc}#position-${p.id}`, positions, DataFactory).mark();
      pos.name = p.companyName;
      pos.identifier = p.id;
      pos.jobTitle = p.title;
      pos.description = p.description || undefined;
      pos.startDate = toDate(p.timePeriod.startDate);
      if (p.timePeriod.endDate) pos.endDate = toDate(p.timePeriod.endDate);
    }
    await ctx.write({
      slug: "work/positions.ttl",
      category: "work-education",
      forClass: CLASSES.Organization,
      dataset: positions,
    });

    ctx.progress({ label: "Done", done: 1, total: 1 });
    return {};
  },
};

/** LinkedIn dates are year+month; default to the 1st (UTC midnight). */
function toDate(ym: LiYearMonth): Date {
  const month = (ym.month ?? 1) - 1;
  return new Date(Date.UTC(ym.year, month, 1));
}
