// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import { demoImport, TEST_POD_ROOT } from "../integrations/core/testing.js";
import { googleCalendarAdapter } from "../integrations/google-calendar/adapter.js";
import { eventViewer, type EventModel } from "./event-view.js";
import { buildContact } from "../contacts.js";
import { buildViewerContext, selectTypedViewer } from "./select.js";
import type { ViewerContext } from "./types.js";

const EVENTS_DOC = `${TEST_POD_ROOT}integrations/google-calendar/calendar/events.ttl`;
const URL = "https://alice.example/calendar/c.ttl";

async function ctxFromTurtle(turtle: string, url = URL): Promise<ViewerContext> {
  const ds = await parseRdf(turtle, "text/turtle", { baseIRI: url });
  return buildViewerContext(url, ds);
}

/** Real Google Calendar adapter output — drive the adapter over its recorded fixtures. */
async function realEventsCtx(): Promise<ViewerContext> {
  const { pod } = await demoImport(googleCalendarAdapter);
  return ctxFromTurtle(pod.get(EVENTS_DOC) ?? "", EVENTS_DOC);
}

describe("eventViewer.matches", () => {
  it("matches a schema:Event document (the class the calendar adapter writes)", async () => {
    expect(eventViewer.matches(await realEventsCtx())).toBe(true);
  });

  it("matches the legacy http://schema.org/ scheme", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <http://schema.org/>. <${URL}#e> a schema:Event ; schema:name "Launch" .`,
    );
    expect(eventViewer.matches(c)).toBe(true);
  });

  it("matches an untyped subject by the schema:startDate signature predicate (shape rescue)", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <https://schema.org/>. <${URL}#e> schema:startDate "2026-06-20T10:00:00Z" .`,
    );
    expect(eventViewer.matches(c)).toBe(true);
  });

  it("does not match an unrelated (contacts) document", () => {
    const ds = buildContact(URL, { fn: "Ada Lovelace" });
    expect(eventViewer.matches(buildViewerContext(URL, ds))).toBe(false);
  });
});

describe("eventViewer.extract — real Google Calendar output", () => {
  it("extracts title/location/description and the raw ISO start/end", async () => {
    const { items } = eventViewer.extract(await realEventsCtx());
    // Three confirmed events in the fixture (none cancelled).
    expect(items).toHaveLength(3);
    const standup = items.find((e) => e.title === "Team standup");
    expect(standup).toBeDefined();
    expect(standup?.location).toBe("Meet: meet.google.com/abc-defg-hij");
    expect(standup?.description).toBe("Daily sync — what shipped, what's blocked.");
    // Adapter writes xsd:dateTime; the value normalises to a parseable ISO instant.
    expect(standup?.startDate).toBeDefined();
    expect(Number.isNaN(Date.parse(standup?.startDate ?? ""))).toBe(false);
    expect(standup?.endDate).toBeDefined();
  });

  it("derives the Open-in-Google-Calendar action from htmlLink and suppresses the raw URL", async () => {
    const { items } = eventViewer.extract(await realEventsCtx());
    const standup = items.find((e) => e.title === "Team standup");
    // htmlLink is www.google.com/calendar/event?… → the calendar action.
    expect(standup?.source?.id).toBe("google-calendar");
    expect(standup?.source?.label).toBe("Open in Google Calendar");
    expect(standup?.source?.href).toBe(
      "https://www.google.com/calendar/event?eid=7p4f2k9q1m3n8s0a",
    );
    expect(standup).not.toHaveProperty("url");
    expect(standup).not.toHaveProperty("sourceUrl");
  });

  it("orders events chronologically (soonest first)", async () => {
    const { items } = eventViewer.extract(await realEventsCtx());
    // standup (Jun 11) < dentist (Jun 12) < public holiday (Jun 15).
    expect(items.map((e) => e.title)).toEqual(["Team standup", "Dentist", "Public holiday"]);
  });

  it("keeps an all-day event (date-only start)", async () => {
    const { items } = eventViewer.extract(await realEventsCtx());
    const holiday = items.find((e) => e.title === "Public holiday");
    expect(holiday).toBeDefined();
    expect(holiday?.startDate).toBeDefined();
  });
});

describe("eventViewer.extract — edge cases", () => {
  it("falls back to 'Untitled event' when schema:name is absent", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <https://schema.org/>. <${URL}#e> a schema:Event ; schema:startDate "2026-06-20T10:00:00Z" .`,
    );
    expect(eventViewer.extract(c).items[0].title).toBe("Untitled event");
  });

  it("leaves source undefined for an unrecognised host (no raw-URL row)", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <https://schema.org/>.
       <${URL}#e> a schema:Event ; schema:name "Local" ; schema:url <https://example.com/x> .`,
    );
    expect(eventViewer.extract(c).items[0].source).toBeUndefined();
  });

  it("sinks dateless events to the end of the chronological order", async () => {
    const c = await ctxFromTurtle(
      `@prefix schema: <https://schema.org/>.
       <${URL}#late> a schema:Event ; schema:name "No date" .
       <${URL}#early> a schema:Event ; schema:name "Soon" ; schema:startDate "2026-06-20T10:00:00Z" .`,
    );
    expect(eventViewer.extract(c).items.map((e) => e.title)).toEqual(["Soon", "No date"]);
  });
});

describe("selection precedence (Event vs others)", () => {
  it("an events document selects the event viewer", async () => {
    expect(selectTypedViewer(await realEventsCtx())?.id).toBe("event");
  });

  it("event viewer sits at priority 60", () => {
    expect(eventViewer.priority).toBe(60);
  });

  it("a contacts document does not select the event viewer", () => {
    const ds = buildContact(URL, { fn: "Grace Hopper" });
    const _m: EventModel = eventViewer.extract(buildViewerContext(URL, ds));
    expect(_m.items).toEqual([]);
  });
});
