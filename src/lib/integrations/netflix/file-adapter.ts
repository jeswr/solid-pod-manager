/**
 * Netflix → Media (Tier-C file import).
 *
 * Netflix's "Download all" gives a `NetflixViewingHistory.csv` with two
 * columns: `Title,Date` (e.g. `"The Crown: Season 1: Smoke and Mirrors",
 * 01/02/2021`). We parse it natively (no dependency) and write each row as a
 * `schema:WatchAction` — the same class Twitch's live adapter uses, so the data
 * lands beside it under Media.
 *
 * The date format is the locale-dependent `M/D/YYYY` (or `D/M/YYYY`) Netflix
 * emits; we parse it leniently and only set `startTime` when we get a valid
 * date, never guessing.
 */
import { DataFactory, Store } from "n3";
import { parseCsv } from "../core/csv.js";
import type { FileImportAdapter, FileImportContext, ImportFile } from "../core/file-import.js";
import { recordFragment } from "../core/slug.js";
import type { IntegrationMetadata } from "../core/types.js";
import { CLASSES, WatchAction } from "../core/vocab.js";

const ID = "netflix";

const metadata: IntegrationMetadata = {
  id: ID,
  name: "Netflix",
  tier: "C",
  authKind: "export-file",
  scopes: [],
  categories: ["media"],
  whatYouGet: "Your viewing history, saved as watch records in Media.",
  requirements: [],
};

export const netflixFileAdapter: FileImportAdapter = {
  metadata,
  accept: ".csv,text/csv",
  fileHint:
    "Netflix → Account → Download your personal information. From the export, select NetflixViewingHistory.csv (Title, Date).",

  async importFile(file: ImportFile, ctx: FileImportContext): Promise<void> {
    ctx.progress({ label: "Reading your viewing history…", done: 0, total: 1 });
    const { rows } = parseCsv(await file.text());

    const doc = ctx.resolve("media/viewing-history.ttl");
    const store = new Store();
    let count = 0;
    for (const row of rows) {
      if (count >= ctx.maxRows) break;
      const title = row.Title ?? row.title;
      if (!title) continue;
      const when = parseNetflixDate(row.Date ?? row.date ?? "");
      const frag = recordFragment(title, `${title}|${row.Date ?? ""}`);
      const watch = new WatchAction(`${doc}#watch-${frag}`, store, DataFactory).mark();
      watch.name = title;
      if (when) watch.startTime = when;
      count++;
    }

    ctx.progress({ label: "Saving to your pod…", done: 1, total: 1 });
    await ctx.write({
      slug: "media/viewing-history.ttl",
      category: "media",
      forClass: CLASSES.WatchAction,
      dataset: store,
    });
  },
};

/**
 * Parse Netflix's `M/D/YYYY` or `D/M/YYYY` date. Netflix uses the account
 * locale; we accept slash- or dash-separated and only return a Date when the
 * parts are unambiguous and valid (else undefined — we never invent a time).
 */
export function parseNetflixDate(raw: string): Date | undefined {
  const m = raw.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!m) return undefined;
  const [, a, b, y] = m;
  let year = Number(y);
  if (year < 100) year += 2000;
  // Netflix US default is M/D/Y. If the first part can't be a month, swap.
  let month = Number(a);
  let day = Number(b);
  if (month > 12 && day <= 12) [month, day] = [day, month];
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const d = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(d.getTime()) ? undefined : d;
}
