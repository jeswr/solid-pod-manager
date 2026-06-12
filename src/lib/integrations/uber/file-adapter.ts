/**
 * Uber → Mobility + Finance (Tier-C file import).
 *
 * Uber's data download includes `trips_data.csv` (alias `Trips Data.csv`) with
 * columns such as `City, Product Type, Trip or Order Status, Request Time,
 * Begin Trip Time, Begin Trip Address, Dropoff Time, Dropoff Address, Distance
 * (miles), Fare Amount, Fare Currency`. We write each trip as **two** linked
 * facets:
 *
 *   - a `schema:TravelAction` (Mobility) — the journey, with start time,
 *     distance and the dropoff address as the end point text;
 *   - a `schema:Invoice` (Finance) — the fare, when the row carries one.
 *
 * Both share one container so re-imports stay idempotent. Parsed natively from
 * the extracted CSV (the download is a ZIP; we accept the inner CSV directly).
 */
import { DataFactory, Store } from "n3";
import { parseCsv } from "../core/csv.js";
import type { FileImportAdapter, FileImportContext, ImportFile } from "../core/file-import.js";
import { recordFragment } from "../core/slug.js";
import type { IntegrationMetadata } from "../core/types.js";
import { CLASSES, Invoice, TravelAction } from "../core/vocab.js";

const ID = "uber";

const metadata: IntegrationMetadata = {
  id: ID,
  name: "Uber",
  tier: "C",
  authKind: "export-file",
  scopes: [],
  categories: ["mobility", "finance"],
  whatYouGet: "Your trips into Mobility and their fares into Finance.",
  requirements: [],
};

const FIELD = {
  status: ["Trip or Order Status", "Trip Status"],
  city: ["City"],
  product: ["Product Type", "Product"],
  begin: ["Begin Trip Time", "Request Time"],
  beginAddr: ["Begin Trip Address", "Pickup Address"],
  dropAddr: ["Dropoff Address", "Drop Off Address"],
  distance: ["Distance (miles)", "Distance"],
  fare: ["Fare Amount", "Fare"],
  currency: ["Fare Currency", "Currency"],
} as const;

function pick(row: Record<string, string>, names: readonly string[]): string | undefined {
  for (const n of names) {
    const v = row[n];
    if (v != null && v.trim() !== "") return v.trim();
  }
  return undefined;
}

export const uberFileAdapter: FileImportAdapter = {
  metadata,
  accept: ".csv,text/csv",
  fileHint:
    "Uber → Privacy → Download your data. Unzip the export and select trips_data.csv (your trip and fare history).",
  exportUrl: "https://myprivacy.uber.com/privacy/exploreyourdata/download",

  async importFile(file: ImportFile, ctx: FileImportContext): Promise<void> {
    ctx.progress({ label: "Reading your trips…", done: 0, total: 1 });
    const { rows } = parseCsv(await file.text());

    const tripsDoc = ctx.resolve("mobility/uber-trips.ttl");
    const faresDoc = ctx.resolve("finance/uber-fares.ttl");
    const trips = new Store();
    const fares = new Store();
    let count = 0;
    for (const row of rows) {
      if (count >= ctx.maxRows) break;
      const begin = pick(row, FIELD.begin);
      const dropAddr = pick(row, FIELD.dropAddr);
      const fareAmount = pick(row, FIELD.fare);
      if (!begin && !dropAddr && !fareAmount) continue;
      const key = `${begin ?? ""}|${dropAddr ?? ""}|${fareAmount ?? ""}`;
      const frag = recordFragment(pick(row, FIELD.city) ?? "trip", key);

      const trip = new TravelAction(`${tripsDoc}#trip-${frag}`, trips, DataFactory).mark();
      const city = pick(row, FIELD.city);
      const product = pick(row, FIELD.product);
      trip.name = [product, city && `in ${city}`].filter(Boolean).join(" ") || "Uber trip";
      const when = parseDate(begin);
      if (when) trip.startTime = when;
      const miles = pick(row, FIELD.distance);
      if (miles) trip.distance = `${miles} miles`;
      if (dropAddr) trip.description = `To ${dropAddr}`;

      if (fareAmount && Number.parseFloat(fareAmount) !== 0) {
        const inv = new Invoice(`${faresDoc}#fare-${frag}`, fares, DataFactory).mark();
        inv.name = trip.name;
        inv.provider = "Uber";
        inv.totalPaymentDue = fareAmount;
        const currency = pick(row, FIELD.currency);
        if (currency) inv.priceCurrency = currency;
        if (when) inv.dateCreated = when;
        const status = pick(row, FIELD.status);
        if (status) inv.paymentStatus = status;
      }
      count++;
    }

    ctx.progress({ label: "Saving to your pod…", done: 1, total: 1 });
    await ctx.write({
      slug: "mobility/uber-trips.ttl",
      category: "mobility",
      forClass: CLASSES.TravelAction,
      dataset: trips,
    });
    if (fares.size > 0) {
      await ctx.write({
        slug: "finance/uber-fares.ttl",
        category: "finance",
        forClass: CLASSES.Invoice,
        dataset: fares,
      });
    }
  },
};

/** Parse Uber's `YYYY-MM-DD HH:MM:SS +0000 UTC` or ISO timestamps. */
export function parseDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const dateOnly = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const d = new Date(`${raw.trim()}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}
