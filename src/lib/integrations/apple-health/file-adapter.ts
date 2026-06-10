/**
 * Apple Health → Health (Tier-C file import).
 *
 * Apple Health exports a `export.zip` whose payload is a large `export.xml`.
 * We deliberately **do not bundle a ZIP library**: that would mean shipping and
 * vetting an unzip dependency to stream a possibly-huge archive in the browser.
 * Instead we accept the already-extracted **`export.xml`** with clear UI
 * guidance ("unzip the export and choose apple_health_export/export.xml"). This
 * is the honest, genuinely-working path — the user does one unzip step the OS
 * already makes trivial.
 *
 * The file is flat attribute-only XML, parsed with the dependency-free
 * `mini-xml` reader. We import `<Workout …>` elements as `schema:ExerciseAction`
 * (the same class Strava's live adapter writes), mapping Apple's
 * `HKWorkoutActivityType…` to a readable exercise type. Per-sample `<Record>`
 * vitals are intentionally *not* imported row-by-row (a year of heart-rate
 * samples is hundreds of thousands of rows); workouts are the high-value,
 * bounded signal.
 */
import { DataFactory, Store } from "n3";
import type { FileImportAdapter, FileImportContext, ImportFile } from "../core/file-import.js";
import { extractElements } from "../core/mini-xml.js";
import { recordFragment } from "../core/slug.js";
import type { IntegrationMetadata } from "../core/types.js";
import { CLASSES, ExerciseAction } from "../core/vocab.js";

const ID = "apple-health";

const metadata: IntegrationMetadata = {
  id: ID,
  name: "Apple Health",
  tier: "C",
  authKind: "export-file",
  scopes: [],
  categories: ["health"],
  whatYouGet: "Your workouts, saved as exercise records in Health.",
  requirements: [],
};

export const appleHealthFileAdapter: FileImportAdapter = {
  metadata,
  accept: ".xml,text/xml,application/xml",
  fileHint:
    "Apple Health → profile → Export All Health Data. Unzip the export.zip and select apple_health_export/export.xml (we read your workouts).",

  async importFile(file: ImportFile, ctx: FileImportContext): Promise<void> {
    ctx.progress({ label: "Reading your workouts…", done: 0, total: 1 });
    const xml = await file.text();

    const doc = ctx.resolve("health/workouts.ttl");
    const store = new Store();
    let count = 0;
    for (const w of extractElements(xml, "Workout", ctx.maxRows)) {
      const type = humanWorkoutType(w.workoutActivityType ?? "");
      const start = parseAppleDate(w.startDate);
      const key = `${w.startDate ?? ""}|${w.workoutActivityType ?? ""}|${w.duration ?? ""}`;
      const frag = recordFragment(type, key);
      const ex = new ExerciseAction(`${doc}#workout-${frag}`, store, DataFactory).mark();
      ex.name = type;
      ex.exerciseType = type;
      if (start) ex.startTime = start;
      if (w.duration) {
        const minutes = Number.parseFloat(w.duration);
        if (Number.isFinite(minutes)) ex.duration = isoMinutes(minutes, w.durationUnit);
      }
      if (w.totalDistance && w.totalDistanceUnit) {
        ex.distance = `${w.totalDistance} ${w.totalDistanceUnit}`;
      }
      count++;
    }

    ctx.progress({ label: "Saving to your pod…", done: 1, total: 1 });
    if (count === 0) return; // runner reports "nothing importable"
    await ctx.write({
      slug: "health/workouts.ttl",
      category: "health",
      forClass: CLASSES.ExerciseAction,
      dataset: store,
    });
  },
};

/** `HKWorkoutActivityTypeRunning` → `Running`; unknown → trimmed input. */
export function humanWorkoutType(hk: string): string {
  const stripped = hk.replace(/^HKWorkoutActivityType/, "").trim();
  if (!stripped) return "Workout";
  // CamelCase → spaced words.
  return stripped.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** Apple's `YYYY-MM-DD HH:MM:SS ±HHMM` workout timestamps → Date. */
export function parseAppleDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const m = raw
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*([+-]\d{2})(\d{2})?/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, tzh, tzm] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${tzh}:${tzm ?? "00"}`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Apple workout duration is usually in minutes; honour `durationUnit`. */
function isoMinutes(value: number, unit: string | undefined): string {
  const seconds = unit === "s" || unit === "sec" ? value : value * 60;
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return `PT${h > 0 ? `${h}H` : ""}${m > 0 ? `${m}M` : ""}${sec > 0 || (h === 0 && m === 0) ? `${sec}S` : ""}`;
}
