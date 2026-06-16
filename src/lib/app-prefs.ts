// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Pod-backed APP PREFERENCES (task #89, G2/P0) — Pod Manager's own UI/UX
 * preferences (Community channels + per-channel read markers, theme, plus a
 * generic small key→value escape hatch) stored in the user's pod so they follow
 * the user across devices/browsers and survive a cache clear — instead of living
 * only in `localStorage` (which #89 replaces as the AUTHORITATIVE store).
 *
 * WHERE IT LIVES — composes with G1 (#87). The owner-private
 * `space:preferencesFile` G1 ({@link file://./preferences.ts}) discovers/creates
 * + WAC-locks is the home: app-prefs are a single dedicated SUBJECT
 * (`<prefsFile>#podmanager`, a `pm:AppPreferences`) inside that document. This
 * needs no second type-index registration and inherits G1's owner-only ACL, so
 * the prefs are private by construction (they hold NO credentials — those stay
 * in memory, `community-credentials.ts`).
 *
 * House rules honoured here:
 *   - TYPED `@rdfjs/wrapper` accessors only — never inline / hand-built triples
 *     (the `solid-rdf` house rule). `@jeswr/fetch-rdf` parses; `n3.Writer` (via
 *     `writeResource`) serialises.
 *   - Reads REVALIDATE (`freshRdf` through G1's `readPreferences`); the write is
 *     CONDITIONAL (`If-Match` on the prefs-file ETag) and PRESERVES every foreign
 *     triple in the document (only the app-prefs subject's quads are rewritten),
 *     so G1's `solid:privateTypeIndex` link + any other preference there survives.
 *   - The prefs file is per-WEBID (discovered off the card), but ENSURING it
 *     exists needs the active storage (to mint a missing one), so the read model
 *     is keyed per active storage by the caller (the SWR active-storage rule).
 */
import {
  LiteralAs,
  LiteralFrom,
  NamedNodeAs,
  NamedNodeFrom,
  OptionalAs,
  OptionalFrom,
  SetFrom,
  TermWrapper,
} from "@rdfjs/wrapper";
import { DataFactory, Store } from "n3";
import type { DatasetCore, Quad } from "@rdfjs/types";
import {
  defaultCommunityPrefs,
  loadCommunityPrefs,
  type CommunityPrefs,
  type PrefsStorage,
} from "./community-prefs.js";
import {
  ensurePreferencesFile,
  preferencesFileLink,
  readPreferences,
} from "./preferences.js";
import { freshRdf } from "./rdf-read.js";
import { writeResource } from "./pod-data.js";
import { profileDocUrl } from "./profile-edit.js";
import { RdfFetchError } from "@jeswr/fetch-rdf";

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
/** Pod Manager's app-vocab home (the suite's `w3id.org/jeswr` vocab namespace). */
const PM = "https://w3id.org/jeswr/pod-manager#";

const TYPE = `${RDF}type`;
const PM_APP_PREFERENCES = `${PM}AppPreferences`;
const PM_THEME = `${PM}theme`;
const PM_MATRIX_ROOM = `${PM}matrixRoom`;
const PM_DISCOURSE_TOPIC = `${PM}discourseTopic`;
const PM_INCLUDE_DISCOURSE_LATEST = `${PM}includeDiscourseLatest`;
const PM_ENTRY = `${PM}entry`;
const PM_KEY = `${PM}key`;
const PM_VALUE = `${PM}value`;
const PM_ENTRY_CLASS = `${PM}Entry`;

/** Turtle prefixes for a readable preferences document. */
const APP_PREFS_PREFIXES = {
  pm: PM,
  space: "http://www.w3.org/ns/pim/space#",
} as const;

/** The fragment the app-prefs subject lives under inside the prefs document. */
const APP_PREFS_FRAGMENT = "#podmanager";

/** The known theme values; anything else is coerced to "system". */
const THEMES = new Set(["light", "dark", "system"]);

/**
 * A KEY→VALUE entry on the app-prefs subject. Used for BOTH the per-thread
 * Community read markers (key `"readMarker:<threadId>"`) and the generic
 * small-pref escape hatch. Modelled as a `pm:Entry` sub-subject with a `pm:key`
 * and `pm:value` string literal so it is order-independent and readable.
 */
class PrefEntry extends TermWrapper {
  get types(): Set<string> {
    return SetFrom.subjectPredicate(this, TYPE, NamedNodeAs.string, NamedNodeFrom.string);
  }
  // NB: NOT named `key`/`value` — `TermWrapper` reserves `value` (the term's IRI
  // value), so these app-prefs accessors carry an `entry` prefix to avoid
  // shadowing the base term API.
  get entryKey(): string | undefined {
    return OptionalFrom.subjectPredicate(this, PM_KEY, LiteralAs.string);
  }
  set entryKey(v: string | undefined) {
    OptionalAs.object(this, PM_KEY, v, LiteralFrom.string);
  }
  get entryValue(): string | undefined {
    return OptionalFrom.subjectPredicate(this, PM_VALUE, LiteralAs.string);
  }
  set entryValue(v: string | undefined) {
    OptionalAs.object(this, PM_VALUE, v, LiteralFrom.string);
  }
}

/**
 * The typed `pm:AppPreferences` subject inside the preferences document — the
 * single home for Pod Manager's own UI/UX preferences. Read through the typed
 * accessors; never touch the raw quads (the `solid-rdf` house rule).
 */
export class AppPreferences extends TermWrapper {
  get types(): Set<string> {
    return SetFrom.subjectPredicate(this, TYPE, NamedNodeAs.string, NamedNodeFrom.string);
  }
  /** Stamp the subject as a `pm:AppPreferences` (self-describing). */
  markAppPreferences(): void {
    this.types.add(PM_APP_PREFERENCES);
  }
  /** Theme override (`light`/`dark`/`system`); undefined ⇒ no stored override. */
  get theme(): string | undefined {
    return OptionalFrom.subjectPredicate(this, PM_THEME, LiteralAs.string);
  }
  set theme(v: string | undefined) {
    OptionalAs.object(this, PM_THEME, v, LiteralFrom.string);
  }
  /** The followed Matrix room aliases/ids (a set of string literals). */
  get matrixRooms(): Set<string> {
    return SetFrom.subjectPredicate(this, PM_MATRIX_ROOM, LiteralAs.string, LiteralFrom.string);
  }
  /** The followed Discourse topic ids (a set of integer literals). */
  get discourseTopics(): Set<number> {
    return SetFrom.subjectPredicate(this, PM_DISCOURSE_TOPIC, LiteralAs.number, LiteralFrom.integer);
  }
  /** Whether the forum's site-wide latest topics are included (default true). */
  get includeDiscourseLatest(): boolean | undefined {
    return OptionalFrom.subjectPredicate(this, PM_INCLUDE_DISCOURSE_LATEST, LiteralAs.boolean);
  }
  set includeDiscourseLatest(v: boolean | undefined) {
    OptionalAs.object(this, PM_INCLUDE_DISCOURSE_LATEST, v, LiteralFrom.boolean);
  }
  /** The key→value entry subjects (named nodes) linked from this subject. */
  get entries(): Set<string> {
    return SetFrom.subjectPredicate(this, PM_ENTRY, NamedNodeAs.string, NamedNodeFrom.string);
  }
}

/** The READ_MARKER entry-key namespace (Community per-thread read markers). */
const READ_MARKER_PREFIX = "readMarker:";

/**
 * The full app-preferences model — a plain, serialisable shape the UI renders
 * directly. The Community prefs are EXACTLY {@link CommunityPrefs} (so the
 * existing Community view consumes it unchanged); `theme` + `extra` are the new
 * surfaces this feature adds.
 */
export interface AppPrefs {
  community: CommunityPrefs;
  /** Theme override (`light`/`dark`/`system`), or undefined for none stored. */
  theme?: "light" | "dark" | "system";
  /** Generic small key→value escape hatch for tiny future prefs. */
  extra: Record<string, string>;
}

/** A fresh default app-prefs (no stored theme; default community prefs). */
export function defaultAppPrefs(): AppPrefs {
  return { community: defaultCommunityPrefs(), extra: {} };
}

/**
 * The bare SWR cache key for the app-prefs model under a given active storage.
 * The prefs FILE is per-WebID, but the key is storage-scoped per the SWR
 * active-storage rule (ensuring/creating it on a write needs the active storage,
 * and the prefs belong to that pod) — so a same-WebID storage switch revalidates
 * rather than painting the other storage's prefs. Lives in the data layer so the
 * prefetch registry (a lib module) can build it without importing the React hook.
 */
export function appPrefsKey(activeStorage: string): string {
  return `app-prefs:${activeStorage}`;
}

/** Coerce a stored theme literal to a known value, or undefined. */
function coerceTheme(raw: string | undefined): AppPrefs["theme"] {
  return raw && THEMES.has(raw) ? (raw as AppPrefs["theme"]) : undefined;
}

/**
 * Parse the app-prefs subject out of an already-fetched prefs-file dataset.
 *
 * Tolerant by construction: a document with no app-prefs subject yields the
 * defaults (a brand-new user, or a prefs file created by G1 with only the
 * type-index link). Corrupt/partial values fall back field-by-field to the
 * default — a bad write can never brick the Community view.
 */
export function readAppPrefs(prefsFileUrl: string, dataset: DatasetCore): AppPrefs {
  const subjectUrl = appPrefsSubjectUrl(prefsFileUrl);
  const subject = new AppPreferences(subjectUrl, dataset, DataFactory);
  const base = defaultAppPrefs();

  const matrixRooms = [...subject.matrixRooms].filter((r) => r.length > 0);
  const discourseTopicIds = [...subject.discourseTopics].filter(
    (n) => Number.isFinite(n) && n > 0,
  );
  const includeDiscourseLatest = subject.includeDiscourseLatest;

  // Read marker + generic escape-hatch entries.
  const readMarker: Record<string, string> = {};
  const extra: Record<string, string> = {};
  for (const entryUrl of subject.entries) {
    const entry = new PrefEntry(entryUrl, dataset, DataFactory);
    const key = entry.entryKey;
    const value = entry.entryValue;
    if (typeof key !== "string" || key.length === 0 || typeof value !== "string") continue;
    if (key.startsWith(READ_MARKER_PREFIX)) {
      const threadId = key.slice(READ_MARKER_PREFIX.length);
      // The ReadMarker contract is a non-negative numeric string; reject others
      // up front so corrupt storage can't flow an invalid marker into the feed.
      const n = Number(value);
      if (threadId.length > 0 && Number.isFinite(n) && n >= 0) readMarker[threadId] = value;
    } else {
      extra[key] = value;
    }
  }

  return {
    community: {
      matrixRooms: matrixRooms.length > 0 || subject.types.has(PM_APP_PREFERENCES)
        ? dedupe(matrixRooms)
        : base.community.matrixRooms,
      discourseTopicIds: dedupeNums(discourseTopicIds),
      includeDiscourseLatest:
        typeof includeDiscourseLatest === "boolean"
          ? includeDiscourseLatest
          : base.community.includeDiscourseLatest,
      readMarker,
    },
    theme: coerceTheme(subject.theme),
    extra,
  };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
function dedupeNums(xs: number[]): number[] {
  return [...new Set(xs)];
}

/** The app-prefs subject URL inside a given preferences document. */
export function appPrefsSubjectUrl(prefsFileUrl: string): string {
  const u = new URL(prefsFileUrl);
  u.hash = APP_PREFS_FRAGMENT.slice(1);
  return u.toString();
}

/** The entry subject URL for a given index inside a preferences document. */
function entryUrl(prefsFileUrl: string, index: number): string {
  const u = new URL(prefsFileUrl);
  u.hash = `podmanager-entry-${index}`;
  return u.toString();
}

/**
 * Build a dataset for a prefs document that carries `prefs` on the app-prefs
 * subject, PRESERVING every foreign quad from `existing` that does NOT belong to
 * the app-prefs subject or its (old) entry sub-subjects. This is what keeps G1's
 * `space:preferencesFile`/`solid:privateTypeIndex` triples and any other
 * preference intact across an app-prefs write.
 *
 * Pure (no I/O) so the read-modify-write is fully unit-testable.
 */
export function buildAppPrefsDataset(
  prefsFileUrl: string,
  prefs: AppPrefs,
  existing: DatasetCore | undefined,
): DatasetCore {
  const subjectUrl = appPrefsSubjectUrl(prefsFileUrl);
  const subjectNode = DataFactory.namedNode(subjectUrl);
  const out = new Store();

  // The OLD entry subjects we must drop (the app-prefs subject's `pm:entry`
  // links in the existing doc) — so a removed marker/extra leaves no orphan.
  const oldEntrySubjects = new Set<string>();
  if (existing) {
    const oldSubject = new AppPreferences(subjectUrl, existing, DataFactory);
    for (const e of oldSubject.entries) oldEntrySubjects.add(e);
  }

  // 1) Copy every foreign quad: anything NOT subject-of the app-prefs subject
  //    and NOT subject-of one of its old entry sub-subjects. (Objects pointing
  //    AT the app-prefs subject from elsewhere are foreign and preserved.)
  if (existing) {
    for (const q of existing) {
      const s = q.subject.value;
      if (q.subject.equals(subjectNode)) continue; // rewritten below
      if (oldEntrySubjects.has(s)) continue; // old entry, re-emitted below
      out.add(q as Quad);
    }
  }

  // 2) Re-emit the app-prefs subject from `prefs` via the typed wrapper.
  const subject = new AppPreferences(subjectUrl, out, DataFactory);
  subject.markAppPreferences();
  if (prefs.theme) subject.theme = prefs.theme;
  for (const room of prefs.community.matrixRooms) subject.matrixRooms.add(room);
  for (const topic of prefs.community.discourseTopicIds) subject.discourseTopics.add(topic);
  subject.includeDiscourseLatest = prefs.community.includeDiscourseLatest;

  // 3) Re-emit the entries (read markers + generic escape hatch), each a fresh
  //    deterministic sub-subject, linked from the app-prefs subject.
  let i = 0;
  const writeEntry = (key: string, value: string) => {
    const url = entryUrl(prefsFileUrl, i);
    i += 1;
    const entry = new PrefEntry(url, out, DataFactory);
    entry.types.add(PM_ENTRY_CLASS); // self-describe
    entry.entryKey = key;
    entry.entryValue = value;
    subject.entries.add(url);
  };
  for (const [threadId, pos] of Object.entries(prefs.community.readMarker)) {
    writeEntry(`${READ_MARKER_PREFIX}${threadId}`, pos);
  }
  for (const [key, value] of Object.entries(prefs.extra)) {
    // The generic escape hatch must never collide with the read-marker namespace.
    if (key.startsWith(READ_MARKER_PREFIX)) continue;
    writeEntry(key, value);
  }

  return out;
}

/**
 * Discover the user's preferences-file URL WITHOUT creating one — read the card
 * and return its `space:preferencesFile` link (or undefined when none is
 * linked). The READ path uses this so a plain read never mints a resource.
 *
 * @param fetchImpl - test-only override; omit in production.
 */
export async function discoverPreferencesFile(
  webId: string,
  fetchImpl?: typeof fetch,
): Promise<string | undefined> {
  const { dataset } = await freshRdf(profileDocUrl(webId), fetchImpl);
  return preferencesFileLink(webId, dataset);
}

/**
 * READ the app-prefs model for a user. The SWR fetcher.
 *
 * Discovery-chain tolerant (mirrors the type-index reader): if no prefs file is
 * linked yet, or it is unreadable (404/403), the user simply has no stored
 * app-prefs → return the DEFAULTS (the migration, on a separate path, writes the
 * legacy localStorage prefs up the first time). Never creates a resource on a
 * read.
 *
 * @param fetchImpl - test-only override; omit in production so the auth-patched
 *   global fetch runs (AGENTS.md §Reading data).
 */
export async function fetchAppPrefs(
  webId: string,
  fetchImpl?: typeof fetch,
): Promise<AppPrefs> {
  const prefsFile = await discoverPreferencesFile(webId, fetchImpl);
  if (!prefsFile) return defaultAppPrefs();
  const read = await readPreferences(prefsFile, fetchImpl);
  if (!read) return defaultAppPrefs();
  return readAppPrefs(prefsFile, read.dataset);
}

/**
 * Read the prefs file for the WRITE path, fail-closed on an unreadable existing
 * document (roborev Medium). Unlike {@link readPreferences} (which maps BOTH
 * 404 and 403 to `undefined`, fine for a READ that then shows defaults), the
 * write path MUST distinguish:
 *   - `404` → genuinely missing ⇒ `undefined` (an unconditional create is safe);
 *   - `403` / parse / other read failure ⇒ THROW, so we never PUT over an
 *     existing-but-forbidden prefs file and silently drop its foreign triples.
 */
async function readPreferencesForWrite(
  preferencesFile: string,
  fetchImpl?: typeof fetch,
): Promise<{ dataset: DatasetCore; etag: string | null } | undefined> {
  try {
    return await freshRdf(preferencesFile, fetchImpl);
  } catch (e) {
    if (e instanceof RdfFetchError && e.status === 404) return undefined;
    throw e; // 403 / parse / network — fail closed, don't clobber foreign data
  }
}

/**
 * PERSIST the app-prefs model to the pod (the optimistic-write backend).
 *
 * Read-modify-write, fail-safe + conditional:
 *   1. Ensure a prefs file exists (G1's `ensurePreferencesFile`: reuse the linked
 *      one, or mint + WAC-lock + link a fresh `settings/preferences.ttl`). This
 *      needs the active storage + a fresh profile read (for the conditional card
 *      write G1 does when it must link a new file).
 *   2. Re-read the prefs file fresh for its current ETag + foreign triples.
 *   3. Rebuild the document preserving every foreign triple, with the app-prefs
 *      subject set from `prefs`, and conditionally PUT it (`If-Match`).
 *
 * Returns the prefs-file URL (the SWR `topicUrl` + the migration's idempotency
 * anchor). MUTATIONS READ FRESH — never act on a cached snapshot (the SwrCache
 * security rule): this re-reads the card + prefs file at write time.
 *
 * @param fetchImpl - test-only override; omit in production.
 */
export async function writeAppPrefs(
  opts: {
    webId: string;
    activeStorage: string;
    prefs: AppPrefs;
    fetchImpl?: typeof fetch;
  },
): Promise<{ preferencesFile: string }> {
  const { webId, activeStorage, prefs, fetchImpl } = opts;

  // Fresh profile read for the conditional card write G1 may do.
  const { dataset: profile, etag: profileEtag } = await freshRdf(
    profileDocUrl(webId),
    fetchImpl,
  );
  const { preferencesFile } = await ensurePreferencesFile({
    webId,
    podRoot: activeStorage,
    profile,
    profileEtag,
    fetchImpl,
  });

  // Re-read the prefs file fresh for its ETag + foreign triples (it may have
  // just been minted by ensurePreferencesFile, or already exist with a
  // type-index link we must preserve). FAIL-CLOSED on an unreadable existing
  // file (roborev Medium): a plain read maps BOTH 404 and 403 to `undefined`,
  // which on the WRITE path would PUT with no preserved foreign triples and
  // could clobber an existing-but-forbidden prefs document. Here a 404 means
  // genuinely-missing (create-ok), but a 403/parse/read failure THROWS rather
  // than risk overwriting foreign data we merely could not read.
  const read = await readPreferencesForWrite(preferencesFile, fetchImpl);
  const next = buildAppPrefsDataset(preferencesFile, prefs, read?.dataset);
  await writeResource(preferencesFile, next, {
    etag: read?.etag ?? null,
    fetchImpl,
    prefixes: APP_PREFS_PREFIXES,
  });
  return { preferencesFile };
}

// ---------------------------------------------------------------------------
// One-time MIGRATION: legacy localStorage Community prefs → the pod (idempotent).
// ---------------------------------------------------------------------------

/**
 * True when a fetched pod model is the EMPTY DEFAULT — the pod has nothing stored
 * yet, so legacy localStorage prefs (if any) should be migrated up. "Empty" = no
 * theme, no extra entries, no read markers, no discourse topics, and the default
 * room set + default latest flag. Used to gate the one-time migration so it only
 * fires when the pod truly has no app-prefs.
 */
export function isUnstoredDefault(prefs: AppPrefs): boolean {
  if (prefs.theme !== undefined) return false;
  if (Object.keys(prefs.extra).length > 0) return false;
  if (Object.keys(prefs.community.readMarker).length > 0) return false;
  if (prefs.community.discourseTopicIds.length > 0) return false;
  const def = defaultAppPrefs().community;
  const sameRooms =
    prefs.community.matrixRooms.length === def.matrixRooms.length &&
    prefs.community.matrixRooms.every((r, i) => r === def.matrixRooms[i]);
  return sameRooms && prefs.community.includeDiscourseLatest === def.includeDiscourseLatest;
}

/** True when the legacy localStorage community prefs differ from the defaults. */
export function legacyHasCustomisation(legacy: CommunityPrefs): boolean {
  const def = defaultAppPrefs().community;
  if (Object.keys(legacy.readMarker).length > 0) return true;
  if (legacy.discourseTopicIds.length > 0) return true;
  if (legacy.includeDiscourseLatest !== def.includeDiscourseLatest) return true;
  if (legacy.matrixRooms.length !== def.matrixRooms.length) return true;
  return !legacy.matrixRooms.every((r, i) => r === def.matrixRooms[i]);
}

/** The outcome of a migration attempt (diagnostics + tests). */
export type MigrationOutcome =
  | { status: "skipped"; reason: "pod-has-prefs" | "no-legacy-customisation" }
  | { status: "migrated"; prefs: AppPrefs }
  | { status: "failed"; error: unknown };

/**
 * Migrate legacy localStorage Community prefs up to the pod ONCE, idempotently.
 *
 * Only migrates when (a) the pod has nothing stored yet AND (b) the legacy
 * localStorage holds a real customisation. In every other case it is a no-op
 * ("skipped"). The caller guards a per-WebID "already migrated" marker on top so
 * it runs at most once per browser; this function is ALSO idempotent against the
 * pod state, so a missing/forgotten marker can never double-write or clobber pod
 * prefs.
 *
 * AUTHORITATIVE FRESHNESS (roborev Medium). `podPrefs` is the SWR-rendered model,
 * which can come from the durable MIRROR after a FAILED revalidation — so it
 * could falsely read "unstored default" while the pod actually holds prefs.
 * Before writing, the migration therefore RE-VERIFIES against the authoritative
 * pod via `verify` (default: a fresh {@link fetchAppPrefs}) and aborts the write
 * if the pod is no longer the empty default (treating that as "pod-has-prefs").
 * A verify FAILURE (offline / unreadable) is treated as `"failed"` — never
 * migrate over a pod we could not confirm is empty.
 *
 * Pure of React; storage, write, and verify are injected, so it is fully testable
 * in the no-DOM `node` env.
 */
export async function migrateLegacyPrefs(opts: {
  webId: string;
  activeStorage: string;
  /** The SWR-rendered pod model (a cheap pre-check; re-verified before writing). */
  podPrefs: AppPrefs;
  /** Where the legacy community prefs live (injected; localStorage in prod). */
  storage: PrefsStorage | null;
  /** The write backend (injected for tests; defaults to {@link writeAppPrefs}). */
  write?: (o: {
    webId: string;
    activeStorage: string;
    prefs: AppPrefs;
  }) => Promise<{ preferencesFile: string }>;
  /**
   * Re-read the AUTHORITATIVE pod model immediately before writing (defaults to a
   * fresh {@link fetchAppPrefs}). A throw → the pod could not be confirmed empty
   * → `"failed"` (never migrate blindly). Injected for tests.
   */
  verify?: (webId: string) => Promise<AppPrefs>;
}): Promise<MigrationOutcome> {
  const { webId, activeStorage, podPrefs, storage } = opts;
  // Cheap pre-check off the rendered model: if it already looks stored, skip.
  if (!isUnstoredDefault(podPrefs)) {
    return { status: "skipped", reason: "pod-has-prefs" };
  }
  const legacy = loadCommunityPrefs(webId, storage);
  if (!legacyHasCustomisation(legacy)) {
    return { status: "skipped", reason: "no-legacy-customisation" };
  }
  const write = opts.write ?? ((o) => writeAppPrefs(o));
  const verify = opts.verify ?? ((id) => fetchAppPrefs(id));
  try {
    // RE-VERIFY against the authoritative pod immediately before writing, so a
    // stale-mirror "default" cannot lead us to overwrite real pod prefs.
    const confirmed = await verify(webId);
    if (!isUnstoredDefault(confirmed)) {
      return { status: "skipped", reason: "pod-has-prefs" };
    }
    const migrated: AppPrefs = { ...defaultAppPrefs(), community: legacy };
    await write({ webId, activeStorage, prefs: migrated });
    return { status: "migrated", prefs: migrated };
  } catch (error) {
    // A verify or write failure → never migrate; retried on a later load.
    return { status: "failed", error };
  }
}

// ---------------------------------------------------------------------------
// OPTIMISTIC write — paint+cache the new value now, persist async, revert on
// failure. Cache + write are injected so it is testable without React.
// ---------------------------------------------------------------------------

/** The minimal cache surface the optimistic write needs (the SwrCache subset). */
export interface OptimisticCache {
  get<T>(webId: string, key: string): T | undefined;
  set<T>(webId: string, key: string, value: T): void;
}

/**
 * Apply an OPTIMISTIC prefs write: immediately set `next` in the cache (so every
 * mount + the durable mirror update at once — instant UI), then persist to the
 * pod async. On success the cache keeps `next`; on failure it REVERTS to the
 * value that was there before and re-throws so the caller can toast.
 *
 * CONCURRENT-WRITE SAFE (roborev High). With several optimistic writes in flight
 * (rapid channel toggles / read-marks), a NAIVE "revert to the value captured at
 * call time" rolls back PAST a newer write that already succeeded: if write A
 * (older) fails AFTER write B (newer) succeeded, reverting to A's `previous`
 * loses B. The revert is therefore IDENTITY-GUARDED: it only restores `previous`
 * when the cache STILL holds THIS write's exact `next` object — i.e. no later
 * write (success or its own optimistic paint) has superseded it. If a newer write
 * is in the slot, the failed older write leaves it untouched (the newer state, or
 * its own failure handling, wins). `previous` is captured for the revert ONLY —
 * MUTATIONS READ FRESH: `write` (default {@link writeAppPrefs}) re-reads the card
 * + prefs file at write time, never acting on the cached snapshot.
 *
 * @throws the underlying write error AFTER (conditionally) reverting the cache.
 */
export async function persistOptimistic(opts: {
  cache: OptimisticCache;
  webId: string;
  activeStorage: string;
  next: AppPrefs;
  write?: (o: {
    webId: string;
    activeStorage: string;
    prefs: AppPrefs;
  }) => Promise<{ preferencesFile: string }>;
}): Promise<void> {
  const { cache, webId, activeStorage, next } = opts;
  const key = appPrefsKey(activeStorage);
  const previous = cache.get<AppPrefs>(webId, key) ?? defaultAppPrefs();
  cache.set(webId, key, next); // optimistic paint
  const write = opts.write ?? ((o) => writeAppPrefs(o));
  try {
    await write({ webId, activeStorage, prefs: next });
  } catch (error) {
    // Only revert if OUR optimistic value is still the one in the slot — a newer
    // write must not be clobbered by an older write's failure (roborev High).
    if (cache.get<AppPrefs>(webId, key) === next) cache.set(webId, key, previous);
    throw error;
  }
}
