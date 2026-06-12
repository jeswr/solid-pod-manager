/**
 * Google Takeout → Documents / Media / Calendar (Tier-C file import).
 *
 * Takeout is a giant multi-service archive, not one file. We deliberately **do
 * not bundle a ZIP library** to crawl it in the browser; instead we accept the
 * single most universal, structured inner file Takeout produces across services:
 * **`MyActivity.json`** (under `Takeout/My Activity/<service>/MyActivity.json`).
 * It is an array of activity records `{ header, title, titleUrl?, time,
 * products? }`, where `header` is the Google product ("YouTube", "Search",
 * "Calendar", …).
 *
 * We route each record to the right category by product:
 *   - YouTube watches → `schema:WatchAction` (Media)
 *   - Calendar        → `schema:Event` (Calendar)
 *   - everything else → `schema:TextDigitalDocument` (Documents)
 *
 * The UI hint tells the user exactly which file to pick. Parsed with
 * `JSON.parse` (no dependency); untrusted input → inert RDF literals. We never
 * fetch `titleUrl` (it would be a file-controlled URL); it is stored as a
 * `schema:url` literal-typed IRI only.
 */
import { DataFactory, Store } from "n3";
import type { FileImportAdapter, FileImportContext, ImportFile } from "../core/file-import.js";
import { recordFragment } from "../core/slug.js";
import type { IntegrationMetadata } from "../core/types.js";
import { CalendarEvent, CLASSES, TextDocument, WatchAction } from "../core/vocab.js";

const ID = "google-takeout";

const metadata: IntegrationMetadata = {
  id: ID,
  name: "Google Takeout",
  tier: "C",
  authKind: "export-file",
  scopes: [],
  categories: ["documents", "media", "calendar"],
  whatYouGet: "Your Google activity, filed into Documents, Media and Calendar.",
  requirements: [],
};

export interface Activity {
  readonly header: string;
  readonly title: string;
  readonly url?: string;
  readonly time?: Date;
}

export const googleTakeoutFileAdapter: FileImportAdapter = {
  metadata,
  accept: ".json,application/json",
  fileHint:
    "Request an archive at takeout.google.com (choose 'My Activity', JSON format). Unzip it and select a MyActivity.json (e.g. Takeout/My Activity/YouTube/MyActivity.json).",
  exportUrl: "https://takeout.google.com",

  async importFile(file: ImportFile, ctx: FileImportContext): Promise<void> {
    ctx.progress({ label: "Reading your Google activity…", done: 0, total: 1 });
    const activities = parseMyActivity(await file.text(), ctx.maxRows);

    const docsDoc = ctx.resolve("documents/google-activity.ttl");
    const mediaDoc = ctx.resolve("media/youtube-activity.ttl");
    const calDoc = ctx.resolve("calendar/google-calendar-activity.ttl");
    const docs = new Store();
    const media = new Store();
    const cal = new Store();

    for (const a of activities) {
      const key = `${a.header}|${a.title}|${a.time?.toISOString() ?? ""}`;
      const frag = recordFragment(a.title, key);
      const product = a.header.toLowerCase();
      if (product.includes("youtube")) {
        const w = new WatchAction(`${mediaDoc}#watch-${frag}`, media, DataFactory).mark();
        w.name = a.title;
        if (a.time) w.startTime = a.time;
        if (a.url) w.sourceUrl = a.url;
      } else if (product.includes("calendar")) {
        const ev = new CalendarEvent(`${calDoc}#event-${frag}`, cal, DataFactory).mark();
        ev.name = a.title;
        if (a.time) ev.startDate = a.time;
      } else {
        const td = new TextDocument(`${docsDoc}#activity-${frag}`, docs, DataFactory).mark();
        td.name = a.title;
        td.description = a.header;
        if (a.url) td.sourceUrl = a.url;
        if (a.time) td.dateCreated = a.time;
      }
    }

    ctx.progress({ label: "Saving to your pod…", done: 1, total: 1 });
    if (docs.size > 0) {
      await ctx.write({
        slug: "documents/google-activity.ttl",
        category: "documents",
        forClass: CLASSES.TextDigitalDocument,
        dataset: docs,
      });
    }
    if (media.size > 0) {
      await ctx.write({
        slug: "media/youtube-activity.ttl",
        category: "media",
        forClass: CLASSES.WatchAction,
        dataset: media,
      });
    }
    if (cal.size > 0) {
      await ctx.write({
        slug: "calendar/google-calendar-activity.ttl",
        category: "calendar",
        forClass: CLASSES.Event,
        dataset: cal,
      });
    }
  },
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Parse `MyActivity.json` into activity records (bounded by `limit`). */
export function parseMyActivity(text: string, limit = Number.POSITIVE_INFINITY): Activity[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: Activity[] = [];
  for (const raw of data) {
    if (out.length >= limit) break;
    if (!isObject(raw)) continue;
    const title = asString(raw.title)?.trim();
    if (!title) continue;
    const header = asString(raw.header)?.trim() ?? firstProduct(raw.products) ?? "Google";
    out.push({
      header,
      title,
      url: safeHttpUrl(asString(raw.titleUrl)),
      time: parseIsoTime(asString(raw.time)),
    });
  }
  return out;
}

function firstProduct(products: unknown): string | undefined {
  return Array.isArray(products) && typeof products[0] === "string" ? products[0] : undefined;
}

/** Only keep http(s) URLs as a literal — never anything we'd be tempted to fetch. */
function safeHttpUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function parseIsoTime(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
