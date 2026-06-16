// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * Global, client-side pod search (task #97 / research G9). Given a free-text
 * query, scan the user's OWN pod across types — notes, contacts, bookmarks,
 * tasks, calendar events, issues, scheduling polls, and files — and return the
 * matching items grouped (by the caller) under their human {@link DataCategory},
 * each linking to its item-detail page. "Finding 'where is X' across categories
 * is core PIM UX."
 *
 * DESIGN — sources scanned, in two tiers:
 *
 *   1. The FIRST-PARTY typed productivity stores (Notes / Contacts / Bookmarks /
 *      Tasks / Calendar / Issues / Schedule). These are read through the SAME
 *      typed `ProductivityStore` the apps use — never re-parsing RDF here — so a
 *      match carries a strongly-typed payload (a Note's title/body, a Contact's
 *      name/email, …) and a precise deep-link to that app's editor.
 *   2. The Type-Index-registered containers + the files root. The type index is
 *      the pod owner's own advertisement of WHERE each class lives, so this finds
 *      data written by OTHER apps (Documents, Media, Health, …) that the
 *      first-party stores don't cover. These are listed via the same
 *      `listCategoryItems`/`listFolder` the My-data + Files pages use; we match
 *      against the item's human NAME (the only field a generic container listing
 *      reliably gives) and link to the generic My-data item viewer.
 *
 * SCALE — this is PERSONAL-scale, client-side search. There is no server FTS
 * (that would be a CORE-PSS / QLever feature, out of scope here); a case-
 * insensitive substring match over the loaded items is sufficient at the size a
 * single person's pod reaches. To keep a LARGE pod from hanging the UI the work
 * is BOUNDED on three axes — a source cap, a result cap, and a wall-clock time
 * budget — and the result reports whether any bound clipped it (so the UI can
 * say "showing first N").
 *
 * (Server-side full-text search would scale this far past a single browser's
 * reach — it belongs in prod-solid-server's QLever index, not here.)
 *
 * SECURITY: own-pod only. Every source URL is derived from the user's own active
 * storage / their own type index (whose locations are validated to be in-pod
 * before any fetch), and every typed store already fails closed on an
 * out-of-container URL. No foreign origin is ever fetched — the auth-patched
 * global fetch must never reach a third party (AGENTS.md §Foreign-origin fetch).
 */
import { contactsStore, type Contact } from "./contacts.js";
import { notesStore, type Note } from "./notes.js";
import { bookmarksStore, type Bookmark } from "./bookmarks.js";
import { tasksStore, type Task } from "./tasks.js";
import { calendarStore, type CalendarEvent } from "./calendar.js";
import { issuesStore, type Issue } from "./issues.js";
import { scheduleStore, type Poll } from "./schedule.js";
import type { ProductivityStore } from "./productivity-store.js";
import {
  typeIndexLinks,
  readTypeIndex,
  type RegisteredLocation,
} from "./type-index.js";
import { preferencesFileLink, readPreferences } from "./preferences.js";
import { categoryForClass, UNCATEGORISED, type DataCategory } from "./categories.js";
import { listCategoryItems, summariseCategories, nameFromUrl } from "./pod-data.js";
import { listFolder } from "./files.js";
import { isInOwnPods } from "./pod-scope.js";
import { freshRdf } from "./rdf-read.js";
import { ProfileTypeIndexAnchor, TypeIndexDataset } from "./type-index.js";
import { DataFactory } from "n3";

/** Default bounds — sized for a personal pod, overridable per call (tests). */
export const SEARCH_DEFAULTS = {
  /** Max distinct sources (stores + containers) scanned in one search. */
  maxSources: 24,
  /** Max results returned across every type. */
  maxResults: 50,
  /** Wall-clock budget (ms) after which no further source is scanned. */
  timeBudgetMs: 6000,
  /** Min characters before a search runs at all (an empty/1-char query is inert). */
  minQueryLength: 2,
} as const;

/** A single search hit — type-tagged, category-grouped, and deep-linkable. */
export interface SearchResult {
  /** The result kind, used for the icon + grouping label. */
  type: SearchResultType;
  /** Human label (title/name/file name) — already plain text, safe to render. */
  label: string;
  /** Where the matched item lives in the pod (its resource URL). */
  url: string;
  /** The human {@link DataCategory} this result groups under. */
  category: DataCategory;
  /** A short context snippet showing WHY it matched (the matched field text). */
  snippet?: string;
  /** The in-app route to open this item's detail/editor. */
  href: string;
}

export type SearchResultType =
  | "note"
  | "contact"
  | "bookmark"
  | "task"
  | "event"
  | "issue"
  | "poll"
  | "file"
  | "item";

/** The outcome of a search: the results plus whether a bound clipped them. */
export interface SearchOutcome {
  results: SearchResult[];
  /**
   * True when a cap/budget stopped the scan before everything was searched, so
   * the UI can say "showing the first N matches". `false` ⇒ the whole pod (all
   * discovered sources) was searched within budget.
   */
  capped: boolean;
  /** How many sources were actually scanned (for diagnostics / "searched N"). */
  sourcesScanned: number;
}

/** Options for {@link searchPod} (bounds + a test-only fetch + clock seam). */
export interface SearchOptions {
  maxSources?: number;
  maxResults?: number;
  timeBudgetMs?: number;
  /** Test-only fetch override; **omit in production** so the auth-patched global runs. */
  fetchImpl?: typeof fetch;
  /** Test-only monotonic clock (ms); defaults to `Date.now`. */
  now?: () => number;
}

/**
 * The session inputs a search needs — the active WebID + active storage + every
 * storage (so own-pod containment can be checked against all of them).
 */
export interface SearchContext {
  webId: string;
  activeStorage: string;
  storages: readonly string[];
}

/** True iff `q` is long enough to run a search (≥ minQueryLength, trimmed). */
export function isSearchable(q: string, min: number = SEARCH_DEFAULTS.minQueryLength): boolean {
  return q.trim().length >= min;
}

/** Case-insensitive substring match (the personal-scale matcher). */
function matches(haystack: string | undefined, needle: string): boolean {
  return haystack !== undefined && haystack.toLowerCase().includes(needle);
}

/**
 * Build a one-line snippet showing the matched field's text, trimmed to a sane
 * length around the match so a long note body doesn't dump into the UI.
 */
function snippetAround(text: string | undefined, needle: string, max = 140): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  const at = flat.toLowerCase().indexOf(needle);
  if (at < 0) return flat.length > max ? `${flat.slice(0, max)}…` : flat;
  // Centre a window on the match.
  const start = Math.max(0, at - Math.floor((max - needle.length) / 2));
  const slice = flat.slice(start, start + max);
  return `${start > 0 ? "…" : ""}${slice}${start + max < flat.length ? "…" : ""}`;
}

/** The first non-empty value among the candidates (a label fallback chain). */
function firstText(...vals: (string | undefined)[]): string | undefined {
  for (const v of vals) if (v && v.trim()) return v.trim();
  return undefined;
}

/**
 * Each first-party productivity source: its store factory, the in-app route its
 * items open in, the result `type`/`category` class, and a matcher that decides
 * whether a typed item matches + produces its label + snippet. Centralised so a
 * new first-party type is a single entry (and so the per-type match logic is
 * unit-testable in isolation).
 */
interface TypedSource {
  type: SearchResultType;
  /** The RDF class — drives the category grouping (categoryForClass). */
  forClass: string;
  /**
   * Scan this source's store for `needle`, pushing each match via `push`. Type
   * safety is kept INSIDE each closure (the store + payload `T` are concrete
   * there); the source is exposed as the existential `TypedSource` so the list
   * is heterogeneous without an unsound `(unknown) => …` cast.
   */
  scan: (
    ctx: SearchContext,
    needle: string,
    fetchImpl: typeof fetch | undefined,
    push: (r: SearchResult) => void,
  ) => Promise<void>;
}

/**
 * Build one typed source from its concrete store + matcher — keeps `T` sound
 * (the matcher sees the real payload type) while erasing to {@link TypedSource}.
 */
function typedSource<T>(spec: {
  type: SearchResultType;
  forClass: string;
  store: (ctx: SearchContext, fetchImpl?: typeof fetch) => ProductivityStore<T>;
  href: (url: string) => string;
  match: (data: T, needle: string) => { label: string; snippet?: string } | null;
}): TypedSource {
  const category = categoryForClass(spec.forClass);
  return {
    type: spec.type,
    forClass: spec.forClass,
    scan: async (ctx, needle, fetchImpl, push) => {
      const store = spec.store(ctx, fetchImpl);
      // `list()` already fails closed (404/403 → []) and skips unparseable items.
      const items = await store.list().catch(() => []);
      for (const item of items) {
        const m = spec.match(item.data, needle);
        if (m) {
          push({
            type: spec.type,
            label: m.label,
            url: item.url,
            category,
            snippet: m.snippet,
            href: spec.href(item.url),
          });
        }
      }
    },
  };
}

/** The first-party typed sources, in display priority order. */
const TYPED_SOURCES: TypedSource[] = [
  typedSource<Note>({
    type: "note",
    forClass: "https://schema.org/TextDigitalDocument",
    store: (c, f) => notesStore({ podRoot: c.activeStorage, webId: c.webId, fetchImpl: f }),
    href: (u) => `/notes/edit?id=${encodeURIComponent(u)}`,
    match: (d, n) => {
      if (matches(d.title, n) || matches(d.text, n)) {
        return { label: firstText(d.title) ?? "Untitled note", snippet: snippetAround(d.text, n) };
      }
      return null;
    },
  }),
  typedSource<Contact>({
    type: "contact",
    forClass: "http://www.w3.org/2006/vcard/ns#Individual",
    store: (c, f) => contactsStore({ podRoot: c.activeStorage, webId: c.webId, fetchImpl: f }),
    href: (u) => `/contacts/edit?id=${encodeURIComponent(u)}`,
    match: (d, n) => {
      const label = firstText(d.fn, d.email) ?? "Unnamed contact";
      if (matches(d.fn, n)) return { label, snippet: d.email };
      if (matches(d.email, n)) return { label, snippet: d.email };
      if (matches(d.phone, n)) return { label, snippet: d.phone };
      if (matches(d.note, n)) return { label, snippet: snippetAround(d.note, n) };
      return null;
    },
  }),
  typedSource<Bookmark>({
    type: "bookmark",
    forClass: "http://www.w3.org/2002/01/bookmark#Bookmark",
    store: (c, f) => bookmarksStore({ podRoot: c.activeStorage, webId: c.webId, fetchImpl: f }),
    href: (u) => `/bookmarks/edit?id=${encodeURIComponent(u)}`,
    match: (d, n) => {
      const label = firstText(d.title, d.url) ?? "Untitled bookmark";
      if (matches(d.title, n)) return { label, snippet: d.url };
      if (matches(d.url, n)) return { label, snippet: d.url };
      if (matches(d.description, n)) return { label, snippet: snippetAround(d.description, n) };
      if (d.tags.some((t) => matches(t, n))) return { label, snippet: d.tags.join(", ") };
      return null;
    },
  }),
  typedSource<Task>({
    type: "task",
    forClass: "http://www.w3.org/2002/12/cal/icaltzd#Vtodo",
    store: (c, f) => tasksStore({ podRoot: c.activeStorage, webId: c.webId, fetchImpl: f }),
    href: (u) => `/tasks/edit?id=${encodeURIComponent(u)}`,
    match: (d, n) => {
      const label = firstText(d.title) ?? "Untitled task";
      if (matches(d.title, n) || matches(d.description, n)) {
        return { label, snippet: snippetAround(d.description, n) };
      }
      return null;
    },
  }),
  typedSource<CalendarEvent>({
    type: "event",
    forClass: "https://schema.org/Event",
    store: (c, f) => calendarStore({ podRoot: c.activeStorage, webId: c.webId, fetchImpl: f }),
    href: (u) => `/calendar/edit?id=${encodeURIComponent(u)}`,
    match: (d, n) => {
      const label = firstText(d.name) ?? "Untitled event";
      if (matches(d.name, n)) {
        return { label, snippet: firstText(d.location, snippetAround(d.description, n)) };
      }
      if (matches(d.location, n)) return { label, snippet: d.location };
      if (matches(d.description, n)) return { label, snippet: snippetAround(d.description, n) };
      return null;
    },
  }),
  typedSource<Issue>({
    type: "issue",
    forClass: "http://www.w3.org/2005/01/wf/flow#Task",
    store: (c, f) => issuesStore({ podRoot: c.activeStorage, webId: c.webId, fetchImpl: f }),
    href: (u) => `/issues/edit?id=${encodeURIComponent(u)}`,
    match: (d, n) => {
      const label = firstText(d.title) ?? "Untitled issue";
      if (matches(d.title, n) || matches(d.description, n)) {
        return { label, snippet: snippetAround(d.description, n) };
      }
      return null;
    },
  }),
  typedSource<Poll>({
    type: "poll",
    forClass: "http://www.w3.org/ns/pim/schedule#SchedulableEvent",
    store: (c, f) => scheduleStore({ podRoot: c.activeStorage, webId: c.webId, fetchImpl: f }),
    href: (u) => `/schedule?id=${encodeURIComponent(u)}`,
    match: (d, n) => {
      const label = firstText(d.name) ?? "Untitled poll";
      if (matches(d.name, n) || matches(d.description, n)) {
        return { label, snippet: snippetAround(d.description, n) };
      }
      return null;
    },
  }),
];

/** A clipped-by-bounds sentinel thrown internally to stop the scan early. */
const STOP = Symbol("search-stop");

/**
 * Scan the user's own pod for `query` and return the grouped, bounded results.
 *
 * The scan is ordered (first-party typed stores first, then the Type-Index /
 * files tail) and STOPS the moment a bound is hit — `maxResults`, `maxSources`,
 * or the `timeBudgetMs` wall-clock budget — so a large pod can never hang the
 * UI. When a bound clips it, {@link SearchOutcome.capped} is `true`.
 *
 * @param fetchImpl - test-only override; **omit in production** so the
 *   auth-patched global runs (AGENTS.md §Reading data).
 */
export async function searchPod(
  ctx: SearchContext,
  query: string,
  options: SearchOptions = {},
): Promise<SearchOutcome> {
  const needle = query.trim().toLowerCase();
  const maxSources = options.maxSources ?? SEARCH_DEFAULTS.maxSources;
  const maxResults = options.maxResults ?? SEARCH_DEFAULTS.maxResults;
  const timeBudgetMs = options.timeBudgetMs ?? SEARCH_DEFAULTS.timeBudgetMs;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl;

  // Gate on the SAME minimum the hook keying + UI imply (a 1-char query is
  // inert everywhere; a direct caller must not be able to trigger a broad pod
  // scan the UI would never fire) — roborev finding (Medium).
  if (!isSearchable(needle) || !ctx.webId || !ctx.activeStorage) {
    return { results: [], capped: false, sourcesScanned: 0 };
  }

  const deadline = now() + timeBudgetMs;
  const results: SearchResult[] = [];
  // De-dup by URL — a resource that surfaces both as a typed item AND a
  // type-index listing must appear once (the typed entry, scanned first, wins).
  const seenUrls = new Set<string>();
  let sourcesScanned = 0;
  let capped = false;

  /** Add a result; signal STOP when the result cap is reached. */
  const push = (r: SearchResult): void => {
    if (seenUrls.has(r.url)) return;
    seenUrls.add(r.url);
    results.push(r);
    if (results.length >= maxResults) {
      capped = true;
      throw STOP;
    }
  };

  /** True (and flags `capped`) if a source/time bound has been hit. */
  const boundHit = (): boolean => {
    if (sourcesScanned >= maxSources || now() >= deadline) {
      capped = true;
      return true;
    }
    return false;
  };

  try {
    // ── Tier 1: first-party typed stores ────────────────────────────────────
    for (const source of TYPED_SOURCES) {
      if (boundHit()) break;
      sourcesScanned++;
      await source.scan(ctx, needle, fetchImpl, push);
    }

    // ── Tier 2: Type-Index-registered containers + files (other apps' data) ──
    // A bound already hit ⇒ do NOT start the discovery network work at all
    // (the discovery itself issues fetches) — roborev finding (Medium): the cap
    // must stop ALL later network work, not just the listing loop.
    if (boundHit()) throw STOP;
    // OWN-POD-GUARDED discovery: every profile-linked index / preferences-file
    // URL is validated against the user's own storages BEFORE it is fetched, so
    // an off-pod `solid:publicTypeIndex` / `privateTypeIndex` / `preferencesFile`
    // in the profile can NEVER make the auth-patched fetch reach a foreign origin
    // (roborev finding, High). `discoverRegistrations` would fetch them first.
    const locations = await discoverOwnPodRegistrations(ctx, fetchImpl);
    // The REGISTERED LOCATIONS are likewise attacker-influenceable (a type-index
    // entry can point anywhere), so validate containment again before listing.
    const summaries = summariseCategories(
      locations.filter((l) => inOwnPods(l.container ?? l.instance, ctx.storages)),
    );
    for (const summary of summaries) {
      if (!summary.hasData) continue;
      if (boundHit()) break;
      sourcesScanned++;
      const items = await listCategoryItems(summary, fetchImpl).catch(() => []);
      for (const item of items) {
        if (seenUrls.has(item.url)) continue; // already found via a typed store
        if (matches(item.name, needle)) {
          push({
            type: "item",
            label: firstText(item.name) ?? nameFromUrl(item.url),
            url: item.url,
            category: summary.category,
            href: `/my-data/${summary.category.id}/item?url=${encodeURIComponent(item.url)}`,
          });
        }
      }
    }

    // ── Tier 2b: the files root (raw files not necessarily type-indexed) ─────
    if (!boundHit()) {
      sourcesScanned++;
      const root = ctx.activeStorage.endsWith("/") ? ctx.activeStorage : `${ctx.activeStorage}/`;
      const files = await listFolder(root, fetchImpl).catch(() => []);
      for (const f of files) {
        if (seenUrls.has(f.url)) continue;
        if (matches(f.name, needle)) {
          push({
            type: "file",
            label: firstText(f.name) ?? nameFromUrl(f.url),
            url: f.url,
            // Raw files have no registered RDF class → the "Other data" bucket.
            category: UNCATEGORISED,
            // Open via the generic item viewer (handles any pod resource); the
            // /files page has no per-resource deep-link route under static export.
            href: `/my-data/${UNCATEGORISED.id}/item?url=${encodeURIComponent(f.url)}`,
          });
        }
      }
    }
  } catch (e) {
    if (e !== STOP) throw e;
  }

  return { results, capped, sourcesScanned };
}

/**
 * Own-pod-GUARDED type-index discovery (roborev finding, High). Mirrors
 * `discoverRegistrations` but validates EVERY profile-linked document URL — the
 * public/private type-index links AND the preferences file — against the user's
 * own storages BEFORE fetching it. A WebID profile's `solid:publicTypeIndex` /
 * `solid:privateTypeIndex` / `space:preferencesFile` are attacker-influenceable;
 * the unguarded discovery would fetch them with the auth-patched global, leaking
 * the user's DPoP token/proof to a foreign origin. Here, an off-pod link is
 * simply SKIPPED — the foreign URL is never fetched at all.
 *
 * The WebID profile document itself IS fetched (it is the user's own
 * authenticated identity — the same read every My-data/prefetch path makes); the
 * guard applies to the documents the profile LINKS TO.
 */
async function discoverOwnPodRegistrations(
  ctx: SearchContext,
  fetchImpl?: typeof fetch,
): Promise<RegisteredLocation[]> {
  let profile: import("@rdfjs/types").DatasetCore;
  try {
    ({ dataset: profile } = await freshRdf(ctx.webId, fetchImpl));
  } catch {
    return [];
  }

  const { publicIndex, privateIndex: legacyCardIndex } = typeIndexLinks(ctx.webId, profile);

  // Resolve the private index with the SAME semantics as `resolvePrivateIndex`
  // (roborev finding, Medium): a LINKED preferences file is authoritative — the
  // private index is whatever IT links, and a prefs file with no usable
  // private-index link (incl. one that is unreadable / 404 / 403 / malformed)
  // means "none". The legacy WebID-card value is used ONLY when NO prefs file is
  // linked at all (a pre-fix pod). So we never silently fall back to a stale card
  // value when a prefs file is present.
  const prefsFile = preferencesFileLink(ctx.webId, profile);
  let privateIndex: string | undefined;
  if (prefsFile) {
    // A prefs file is linked → the card legacy value is OUT. Read it only if it
    // is in-pod (else "none" — never reach off-pod, and never fall back to card).
    if (inOwnPods(prefsFile, ctx.storages)) {
      const prefs = await readPreferences(prefsFile, fetchImpl).catch(() => undefined);
      privateIndex = prefs
        ? new ProfileTypeIndexAnchor(prefsFile, prefs.dataset, DataFactory).privateIndex
        : undefined;
    } else {
      privateIndex = undefined;
    }
  } else {
    // No prefs file linked — a legacy pod: the private index (if any) is the card.
    privateIndex = legacyCardIndex;
  }

  // Fetch ONLY the index documents that live inside the user's own pods.
  const indexUrls = [publicIndex, privateIndex].filter(
    (u): u is string => Boolean(u) && inOwnPods(u, ctx.storages),
  );
  const docs = await Promise.all(
    indexUrls.map((u) =>
      readTypeIndex(u, fetchImpl).catch((): TypeIndexDataset | undefined => undefined),
    ),
  );
  return docs
    .filter((d): d is TypeIndexDataset => Boolean(d))
    .flatMap((d) => d.all());
}

/** Own-pod containment helper that tolerates an undefined target. */
function inOwnPods(target: string | undefined, storages: readonly string[]): boolean {
  return target !== undefined && isInOwnPods(target, storages);
}

/** Group a flat result list by category id, preserving category display order. */
export interface SearchGroup {
  category: DataCategory;
  results: SearchResult[];
}

/**
 * Group results under their category, ordered by first appearance (which follows
 * the typed-source priority then the type-index order) so the most relevant
 * categories surface first. Pure — UI-friendly.
 */
export function groupResults(results: readonly SearchResult[]): SearchGroup[] {
  const order: string[] = [];
  const byId = new Map<string, SearchGroup>();
  for (const r of results) {
    let group = byId.get(r.category.id);
    if (!group) {
      group = { category: r.category, results: [] };
      byId.set(r.category.id, group);
      order.push(r.category.id);
    }
    group.results.push(r);
  }
  return order.map((id) => byId.get(id)!);
}
