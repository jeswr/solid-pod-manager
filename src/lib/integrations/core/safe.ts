/**
 * Defensive helpers for normalising live API responses. The recorded fixtures
 * are tidy, but the real platforms return sparser, messier shapes than their
 * docs imply: missing arrays, null entries, absent counts, malformed dates.
 *
 * The house rule (docs/integrations-catalog.md §"Live robustness"): a single
 * malformed item is skipped, never fatal; a missing optional field omits its
 * triple (the typed vocab setters already drop `undefined`), and we never let
 * an Invalid Date reach `toISOString()` (which throws).
 */

/** An array, or `[]` when the API omitted it / sent a non-array. */
export function arr<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

/**
 * `new Date(value)` only when `value` is a present, parseable date string;
 * otherwise `undefined` (so the vocab setter omits the triple instead of
 * letting `Invalid Date.toISOString()` throw).
 */
export function optionalDate(value: string | null | undefined): Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** A finite number, or `undefined` (so the count triple is omitted, never `NaN`). */
export function optionalNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Trimmed non-empty string, or `undefined` (omit rather than write `""`). */
export function optionalText(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * A tiny counter for items the adapter had to skip (a null array entry, or an
 * item missing the one field it cannot exist without — e.g. a Spotify track
 * with no `id`, so it has no stable fragment IRI). Surfaced honestly on the
 * {@link import("./types.js").ImportOutcome} as `skipped`.
 */
export class SkipCounter {
  private n = 0;
  /** Record one skipped item; returns `true` (handy as `if (skip()) continue`). */
  skip(): true {
    this.n += 1;
    return true;
  }
  /** Skip count, or `undefined` when nothing was skipped (keeps the outcome clean). */
  get value(): number | undefined {
    return this.n > 0 ? this.n : undefined;
  }
}
