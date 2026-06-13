// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Public-data autocomplete seam (Wave 5 §3, stretch). A small, dependency-free
 * abstraction for filling a field from a public source. A `FieldSpec` opts in
 * via its `autocomplete` id; the renderer looks the source up here and offers
 * suggestions as the user types.
 *
 * Kept behind a clean interface so a heavier source (a Wikidata/places/orgs
 * lookup over `fetch`) can be added later WITHOUT a new dependency and without
 * touching the renderer — implement {@link AutocompleteSource} and register it.
 * The only source shipped today is a static, offline schema.org enum provider
 * (no network, no dep), proving the seam end-to-end.
 */

/** One suggestion: the value to store + a human label. */
export interface Suggestion {
  value: string;
  label: string;
}

/** A pluggable lookup. `suggest` may be sync or async; it must never throw. */
export interface AutocompleteSource {
  id: string;
  /** Return up to `limit` suggestions for the (possibly empty) query. */
  suggest(query: string, limit: number): Suggestion[] | Promise<Suggestion[]>;
}

/** Build a static enum source from a fixed option list (offline, no dep). */
export function staticSource(id: string, options: readonly Suggestion[]): AutocompleteSource {
  return {
    id,
    suggest(query, limit) {
      const q = query.trim().toLowerCase();
      const matches = q
        ? options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
        : options;
      return matches.slice(0, limit);
    },
  };
}

/**
 * schema.org `EventStatusType` enum — a small, real schema.org closed set, used
 * to demonstrate enum autocomplete on an event status field offline.
 */
const EVENT_STATUS: readonly Suggestion[] = [
  { value: "https://schema.org/EventScheduled", label: "Scheduled" },
  { value: "https://schema.org/EventCancelled", label: "Cancelled" },
  { value: "https://schema.org/EventPostponed", label: "Postponed" },
  { value: "https://schema.org/EventRescheduled", label: "Rescheduled" },
  { value: "https://schema.org/EventMovedOnline", label: "Moved online" },
];

/** The built-in source registry. Add new sources here (or via {@link register}). */
const REGISTRY = new Map<string, AutocompleteSource>([
  ["schema:eventStatus", staticSource("schema:eventStatus", EVENT_STATUS)],
]);

/** Register (or replace) an autocomplete source at runtime. */
export function register(source: AutocompleteSource): void {
  REGISTRY.set(source.id, source);
}

/** Look up a registered source by id, or `undefined`. */
export function sourceFor(id: string | undefined): AutocompleteSource | undefined {
  return id ? REGISTRY.get(id) : undefined;
}
