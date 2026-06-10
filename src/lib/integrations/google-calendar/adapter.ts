/**
 * Google Calendar → Calendar. Upcoming events from the user's primary
 * calendar (`/calendar/v3/calendars/primary/events`) as `schema:Event`.
 *
 * Tier B: Google requires OAuth-app verification, and the calendar read scope
 * is a "sensitive" scope that triggers a Google security review before the
 * client may serve non-test users. Google's web OAuth clients are confidential
 * (no secretless PKCE for the code→token exchange), so live mode goes through
 * the maintainer's token proxy. Demoable now against recorded fixtures.
 */
import { DataFactory, Store } from "n3";
import { getJson } from "../core/fixture-fetch.js";
import type { ImportContext, ImportOutcome, IntegrationAdapter } from "../core/types.js";
import { CalendarEvent, CLASSES } from "../core/vocab.js";
import { type GCalEventsList, GOOGLE_CALENDAR_FIXTURES } from "./fixtures.js";

const ID = "google-calendar";
const API = "https://www.googleapis.com/calendar/v3";
const SCOPES = ["https://www.googleapis.com/auth/calendar.events.readonly"] as const;

export const googleCalendarAdapter: IntegrationAdapter = {
  metadata: {
    id: ID,
    name: "Google Calendar",
    tier: "B",
    authKind: "oauth-pkce",
    scopes: SCOPES,
    categories: ["calendar"],
    whatYouGet: "Your events and appointments, saved into Calendar.",
    requirements: [
      "Google OAuth verification + restricted-scope review: the calendar read scope is sensitive, so Google must verify the app before it can serve real users.",
      "Create a Web OAuth client at console.cloud.google.com and add <app-origin>/oauth-callback.html as an authorised redirect URI.",
      "Google web clients are confidential, so set NEXT_PUBLIC_GOOGLE_CALENDAR_CLIENT_ID and deploy the token proxy at NEXT_PUBLIC_GOOGLE_CALENDAR_TOKEN_PROXY.",
    ],
  },
  oauth: {
    clientId: process.env.NEXT_PUBLIC_GOOGLE_CALENDAR_CLIENT_ID,
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    scopes: SCOPES,
    tokenExchange: "proxy",
    tokenProxyUrl: process.env.NEXT_PUBLIC_GOOGLE_CALENDAR_TOKEN_PROXY,
    // Google needs these to return a refresh token on first consent.
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
  fixtures: () => GOOGLE_CALENDAR_FIXTURES,

  async import(ctx: ImportContext): Promise<ImportOutcome> {
    ctx.progress({ label: "Fetching your upcoming events…", done: 0, total: 1 });
    const list = await getJson<GCalEventsList>(
      ID,
      ctx.api,
      `${API}/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=250`,
    );

    const doc = ctx.resolve("calendar/events.ttl");
    const events = new Store();
    for (const e of list.items) {
      if (e.status === "cancelled") continue;
      const ev = new CalendarEvent(`${doc}#event-${e.id}`, events, DataFactory).mark();
      ev.name = e.summary ?? "(no title)";
      ev.identifier = e.id;
      ev.description = e.description || undefined;
      ev.location = e.location || undefined;
      ev.sourceUrl = e.htmlLink;
      const start = toDate(e.start);
      const end = toDate(e.end);
      if (start) ev.startDate = start;
      if (end) ev.endDate = end;
      if (e.created) ev.dateCreated = new Date(e.created);
      if (e.updated) ev.dateModified = new Date(e.updated);
    }
    await ctx.write({
      slug: "calendar/events.ttl",
      category: "calendar",
      forClass: CLASSES.Event,
      dataset: events,
    });

    ctx.progress({ label: "Done", done: 1, total: 1 });
    return {};
  },
};

/** Timed events use `dateTime`; all-day events use a bare `date` (midnight). */
function toDate(dt: { dateTime?: string; date?: string }): Date | undefined {
  if (dt.dateTime) return new Date(dt.dateTime);
  if (dt.date) return new Date(`${dt.date}T00:00:00Z`);
  return undefined;
}
