// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * durable-cache.ts — a durable, WebID-scoped client snapshot of the expensive
 * pod *read* models (category summaries, connected apps, recent activity, …) so
 * that a COLD OPEN (full page reload, app close/reopen) paints INSTANTLY from
 * the last-good snapshot and revalidates in the background, instead of showing a
 * blank loading screen.
 *
 * Why this exists (the symptoms it fixes):
 *
 *   - The in-memory {@link file://./swr-cache.ts SwrCache} only survives within a
 *     single tab lifetime; a reload starts it cold, so Home/Connected-apps spun
 *     up a full uncached discovery chain behind a spinner EVERY cold open. This
 *     layer persists each model's last-good value to `localStorage`, so the very
 *     first render after a reload can seed from it synchronously (no await, no
 *     spinner) while the in-memory SWR layer revalidates.
 *   - It is the interim app-level measure until the suite's `solid-offline`
 *     service-worker read-through cache is wired in here (see jeswr/solid-offline
 *     and the offline-first infra memory). Same shape as solid-issues'
 *     `issue-cache.ts`, generalised to any (WebID, key) model.
 *
 * It is a RENDER-SPEED optimisation ONLY — never authoritative for writes.
 * Mutations (grant/revoke/edit) must read FRESH data via the backend
 * (`freshRdf`/ACL re-read); the cached snapshot is for first-paint, never for
 * deciding what to write. See `use-permissions.ts` `getFreshModel`.
 *
 * Security / correctness (a real cross-user data-bleed HIGH was found before):
 *
 *   - Every snapshot is keyed AND stamped with the WebID that fetched it, and is
 *     only ever read back for that SAME authenticated WebID. A missing or
 *     mismatched WebID is a cache MISS (no hydrate) — never a hydrate of another
 *     user's data. Pod data differs per viewer (private resources, per-agent
 *     ACLs), so a snapshot one user cached must never paint for a different later
 *     user on the same browser before authorization revalidates.
 *   - The envelope is VERSIONED ({@link VERSION}); a shape change bumps it and
 *     all older entries become unreadable (so they cannot leak or mis-parse).
 *   - Bounded by {@link MAX_AGE_MS}: a too-old snapshot is not painted (it still
 *     revalidates; this only caps how stale a first-paint may be).
 *   - Best-effort: any read/parse/quota error degrades to "no cache" (a normal
 *     fetch), never an exception that blocks the app.
 *   - Cleared on BOTH logout AND account switch ({@link clearAllDurableCache} /
 *     {@link clearDurableCacheForWebId}), so a signed-out / switched device
 *     leaves no prior user's snapshots behind.
 *
 * SERIALISATION SAFETY — opt-in per-key codecs (roborev finding, durable-cache:158):
 *
 *   `localStorage` only holds strings, so every snapshot round-trips through
 *   `JSON.stringify`/`JSON.parse`. That boundary silently changes the type of any
 *   non-plain-JSON value: a `Date` becomes an ISO string, a `Set`/`Map` becomes
 *   `{}`/`[]`, a `URL` becomes a string, a class instance loses its prototype.
 *   Returning such a hydrated value as `T` is a lie — a cold-open render could
 *   show wrong dates or sort incorrectly while the types claim to be intact.
 *
 *   So durable persistence is **opt-in per cache key via an explicit codec**
 *   ({@link DurableCodec}, registered in {@link CODECS}). A codec declares how its
 *   model `encode`s to a {@link JsonValue} and `decode`s back to a type-faithful
 *   `T` (e.g. reviving `Date` fields). Rules:
 *
 *     - A key WITH a registered codec is persisted (encoded) and hydrated
 *       (decoded) — the value returned as `T` is type-faithful.
 *     - A key WITHOUT a codec is **memory-only**: {@link writeDurableCache} is a
 *       no-op and {@link readDurableCache} is a MISS. The in-memory SWR layer
 *       still caches it within the tab; it just never persists across a cold
 *       open. This is the safe default — a model can never silently drift its
 *       types by being persisted without a verified round-trip.
 *
 *   The four read models persisted today are all plain-JSON (`connected-apps`,
 *   `category-summaries`, and the ISO-string-timestamped `recent-activity` /
 *   `category-items:*`), so their codecs are the identity codec — but the seam
 *   exists so a future model carrying real `Date`/`Set`/`Map`/`URL` fields must
 *   register a codec (or stay memory-only) rather than corrupt its types.
 */

const PREFIX = "solid-pod-manager:read-cache:";

/**
 * A JSON-plain value — exactly what survives `JSON.stringify`→`JSON.parse`
 * unchanged. A {@link DurableCodec}'s `encode` MUST return this shape, so what
 * is persisted is guaranteed round-trippable; `decode` turns it back into the
 * type-faithful model `T` (e.g. reviving ISO strings into `Date`s).
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * How one cached model durably round-trips. `encode` lowers the model `T` to a
 * JSON-plain shape for storage; `decode` raises a parsed JSON-plain shape back
 * to a TYPE-FAITHFUL `T` (so `Date` fields hydrate as `Date`s, not strings).
 * For a model that is already JSON-plain both are the identity ({@link jsonCodec}).
 */
export interface DurableCodec<T = unknown> {
  encode(value: T): JsonValue;
  decode(raw: JsonValue): T;
}

/**
 * The identity codec for a model that is ALREADY JSON-plain (only string /
 * number / boolean / null / arrays / plain objects, no `Date`/`Set`/`Map`/`URL`/
 * class instances). It round-trips unchanged, so `encode`/`decode` are no-ops.
 * Use this only for a model you have verified carries no non-plain field.
 */
export function jsonCodec<T>(): DurableCodec<T> {
  return {
    encode: (value) => value as unknown as JsonValue,
    decode: (raw) => raw as unknown as T,
  };
}

/** ISO-8601 datetime (what `JSON.stringify` emits for a `Date`) — for revival. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/**
 * Deeply revive any string that looks like an ISO-8601 datetime into a `Date`,
 * recursing through arrays and plain objects. Mirrors solid-issues'
 * `issue-cache.ts` reviver. Use this to BUILD the `decode` of a codec for a
 * model whose only non-plain fields are `Date`s; pair it with a plain `encode`
 * (`JSON.stringify` already lowers a `Date` to its ISO string).
 */
export function reviveDatesDeep<T>(raw: JsonValue): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string" && ISO_DATE.test(v)) {
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? v : d;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(raw) as T;
}

/**
 * A codec for a model whose ONLY non-plain fields are `Date`s AND none of whose
 * STRING fields can ever legitimately hold an ISO-date-looking value. `encode` is
 * the identity (`JSON.stringify` lowers a `Date` to its ISO string automatically);
 * `decode` deep-revives EVERY ISO-datetime string back into a `Date`.
 *
 * DANGER (roborev finding, durable-cache:187): this revives indiscriminately, so
 * it MUST NOT be used for any model carrying USER-CONTROLLED string fields — a
 * user could legitimately title something "2026-01-01T00:00:00Z", and this codec
 * would hydrate that title as a `Date`, corrupting the model and crashing any
 * `.trim()` on it after a cold open. For such a model, write a FIELD-AWARE codec
 * (see {@link assignedTasksCodec}) that revives only the known real date fields.
 * Only use this when every string field is system-generated and non-date.
 */
export function dateRevivingCodec<T>(): DurableCodec<T> {
  return {
    encode: (value) => value as unknown as JsonValue,
    decode: (raw) => reviveDatesDeep<T>(raw),
  };
}

/**
 * Revive a single ISO-8601-datetime string into a `Date`, leaving anything else
 * (incl. a non-date string, `undefined`, or a malformed datetime) untouched.
 * The narrow, FIELD-TARGETED counterpart to {@link reviveDatesDeep} — used by a
 * field-aware codec to revive ONLY the fields it KNOWS are dates.
 */
function reviveDateField(v: unknown): unknown {
  if (typeof v !== "string" || !ISO_DATE.test(v)) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d;
}

/**
 * The FIELD-AWARE codec for the `assigned-tasks` model — an `AssignedTask[]`
 * (see {@link file://./federation-tasks.ts}). It revives ONLY the two known real
 * `Date` fields on each item's nested `task` (`task.created` and `task.endedAt`,
 * from `dct:created` / `prov:endedAtTime`) and leaves EVERY other field as the
 * type `JSON.parse` produced — crucially the USER-CONTROLLED strings `task.title`
 * and `task.description`, which can legitimately look like an ISO date.
 *
 * Why this exists (roborev finding, durable-cache:187): the generic
 * {@link dateRevivingCodec} revives every date-shaped string anywhere in the
 * object, so a task titled "2026-01-01T00:00:00Z" would hydrate its `title` as a
 * `Date` on a cold open, and the assigned page's `it.title.trim()` would then
 * throw. Reviving by KNOWN FIELD instead of by SHAPE makes user strings stay
 * strings, so the hydrated model is type-faithful and never crashes the render.
 *
 * `encode` is the identity (`JSON.stringify` lowers each `Date` to its ISO
 * string); `decode` walks the array and rebuilds each item with its two date
 * fields revived. Non-array / malformed input degrades to an empty list (the
 * caller treats a miss the same as no cache).
 */
export function assignedTasksCodec<T>(): DurableCodec<T> {
  return {
    encode: (value) => value as unknown as JsonValue,
    decode: (raw) => {
      if (!Array.isArray(raw)) return [] as unknown as T;
      const out = raw.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return item;
        const rec = item as Record<string, unknown>;
        const task = rec.task;
        if (!task || typeof task !== "object" || Array.isArray(task)) return item;
        const taskRec = task as Record<string, unknown>;
        // Revive ONLY the two real date fields, and only when actually present —
        // never materialise an absent optional. Every OTHER field, including the
        // user-controlled `title`/`description` strings, is left exactly as parsed
        // (so a title that looks like an ISO date stays a string, not a Date).
        const revivedTask: Record<string, unknown> = { ...taskRec };
        if ("created" in taskRec) revivedTask.created = reviveDateField(taskRec.created);
        if ("endedAt" in taskRec) revivedTask.endedAt = reviveDateField(taskRec.endedAt);
        return { ...rec, task: revivedTask };
      });
      return out as unknown as T;
    },
  };
}

/**
 * The SWR / durable cache key PREFIX for the "Assigned to me" federation view.
 * The full key is storage-scoped (see {@link assignedTasksKey}) so a WebID with
 * MORE THAN ONE storage gets a SEPARATE cache slot per storage. Lives here (the
 * durable layer) so it can be unit-tested without the `"use client"` React hook
 * that consumes it; re-exported from `use-federation-tasks.ts`.
 */
export const ASSIGNED_TASKS_KEY_PREFIX = "assigned-tasks";

/**
 * The full, storage-scoped durable/SWR cache key for the assigned-tasks model:
 * `assigned-tasks:<activeStorage>`. Different storage ⇒ different key ⇒ a
 * different cache slot (and `useSwrRead` re-runs because the key changed), so
 * switching pods can never serve another storage's stale assigned list (roborev
 * finding, use-federation-tasks:78). Matched by the `prefix` codec rule below.
 */
export const assignedTasksKey = (activeStorage: string): string =>
  `${ASSIGNED_TASKS_KEY_PREFIX}:${activeStorage}`;

/**
 * The codec registry — the SINGLE place that declares which durable keys may
 * persist and how each round-trips. A key absent here is memory-only (no
 * persist, no hydrate). Two match forms:
 *
 *   - `exact` — the key string must equal it (e.g. `"connected-apps"`).
 *   - `prefix` — the key must start with it (e.g. `"category-items:"` covers
 *     `category-items:<categoryId>` for any id).
 *
 * Order matters only in that {@link codecFor} returns the FIRST match; keep
 * exact entries above any prefix that could also match them.
 *
 * NOTE: the four JSON-plain models below (their timestamps are ISO strings, not
 * `Date`s) use {@link jsonCodec}. The `assigned-tasks` model is the FIRST that
 * genuinely carries `Date` fields (`AssignedTask.task.created`/`.endedAt`, real
 * `Date`s revived from `xsd:dateTime`) ALONGSIDE user-controlled strings
 * (`task.title`/`description`), so it uses the FIELD-AWARE
 * {@link assignedTasksCodec} (NOT the generic {@link dateRevivingCodec}, which
 * would revive a date-looking title into a `Date` and crash the render). Its key
 * is `assigned-tasks:<activeStorage>` (storage-scoped — built by
 * {@link assignedTasksKey}), so it matches by `prefix`. If a JSON-plain model later gains a
 * `Date`/`Set`/`Map`/`URL` field, switch its codec here (a field-aware codec when
 * it also has user strings, else {@link dateRevivingCodec}) or drop it to
 * memory-only — never let it ride the identity codec with a non-plain field.
 */
interface CodecRule {
  match: { exact: string } | { prefix: string };
  codec: DurableCodec;
}

const CODECS: readonly CodecRule[] = [
  { match: { exact: "connected-apps" }, codec: jsonCodec() },
  { match: { exact: "category-summaries" }, codec: jsonCodec() },
  { match: { exact: "recent-activity" }, codec: jsonCodec() },
  // The "Assigned to me" federation view. The key is storage-scoped
  // (`assigned-tasks:<activeStorage>`) so two storages of one WebID never share a
  // slot, hence a PREFIX match. It carries real `Date` fields (`task.created` /
  // `task.endedAt`) NEXT TO user-controlled strings (`task.title`/`description`)
  // that can look like ISO dates, so it uses the FIELD-AWARE assignedTasksCodec —
  // never the generic date reviver (which would corrupt a date-looking title into
  // a Date and crash the render). The prefix MUST equal ASSIGNED_TASKS_KEY_PREFIX
  // (both defined above) — the codec and the key are two ends of one snapshot.
  { match: { prefix: ASSIGNED_TASKS_KEY_PREFIX }, codec: assignedTasksCodec() },
  { match: { prefix: "category-items:" }, codec: jsonCodec() },
];

/**
 * The codec for a model key, or `null` when none is registered (⇒ memory-only:
 * no durable persist, no hydrate). Exposed for tests so the registered set can
 * be asserted directly.
 */
export function codecFor(modelKey: string): DurableCodec | null {
  for (const rule of CODECS) {
    if ("exact" in rule.match) {
      if (rule.match.exact === modelKey) return rule.codec;
    } else if (modelKey.startsWith(rule.match.prefix)) {
      return rule.codec;
    }
  }
  return null;
}

/**
 * Cache schema version — bump to invalidate ALL entries on a shape change. Any
 * envelope with a different `v` is unreadable, so stale shapes cannot leak or
 * mis-parse into a view.
 */
export const VERSION = 1;

/**
 * Don't paint from a snapshot older than this (ms) — a week. Stale data still
 * revalidates in the background; this only bounds how old a FIRST-paint may be,
 * so a long-dormant account never flashes week-stale access info before the
 * revalidation lands.
 */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The persisted envelope around one cached model. `value` is ALWAYS the
 * codec-`encode`d, JSON-plain form — never the live model — so what is written
 * is guaranteed round-trippable; the codec's `decode` raises it back to a
 * type-faithful `T` on read.
 */
interface CacheEnvelope {
  v: number;
  /** When the snapshot was written (epoch ms). */
  at: number;
  /** The WebID that fetched this model — only this identity may paint it. */
  webId: string;
  /** The model key (defence-in-depth against key collisions). */
  key: string;
  /** The codec-encoded, JSON-plain snapshot. */
  value: JsonValue;
}

/**
 * Minimal synchronous KV contract — `localStorage` matches it; injectable so
 * the cache is unit-testable under the `node` Vitest environment (no DOM).
 */
export interface SyncStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

function defaultStorage(): SyncStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // SSR / privacy mode without localStorage
  }
}

/**
 * The storage key for a (WebID, model-key) snapshot. The WebID is part of the
 * key so two users on the same browser never share a slot — defence in depth on
 * top of the in-envelope WebID check. The separator is {@link SEP} (NUL), which
 * cannot appear in a WebID URL or a model key, so a crafted value can't forge
 * another pair's key.
 */
/**
 * The (WebID, key) separator: a NUL, written as an escape so the source
 * stays plain text. NUL cannot appear in a WebID URL or a model key, so a
 * crafted value cannot forge another pair's storage key.
 */
const SEP = "\u0000";

const storageKeyFor = (webId: string, modelKey: string) =>
  `${PREFIX}${webId}${SEP}${modelKey}`;

/**
 * Read the cached model for a (WebID, key) pair, or `null` when there is no
 * usable snapshot (absent, NO REGISTERED CODEC ⇒ memory-only, wrong version,
 * WebID/key mismatch, too old, or unparseable). A missing or mismatched WebID is
 * a MISS — a snapshot is only ever painted back for the SAME authenticated WebID
 * that fetched it, so one user's pod data can never paint for a different later
 * user on the same browser. The value is `decode`d via the key's codec, so what
 * is returned as `T` is TYPE-FAITHFUL (e.g. `Date` fields are `Date`s, not the
 * ISO strings JSON parsed them as).
 */
export function readDurableCache<T>(
  webId: string | null | undefined,
  modelKey: string,
  storage: SyncStorage | null = defaultStorage(),
  now: number = Date.now(),
): T | null {
  // No authenticated identity ⇒ nothing to match against ⇒ cache miss (no hydrate).
  if (!storage || !modelKey || !webId) return null;
  // No registered codec ⇒ this key is memory-only ⇒ nothing was persisted.
  const codec = codecFor(modelKey);
  if (!codec) return null;
  try {
    const raw = storage.getItem(storageKeyFor(webId, modelKey));
    if (!raw) return null;
    const env = JSON.parse(raw) as CacheEnvelope;
    // Version, WebID, AND key must all match the current identity/model.
    if (env.v !== VERSION || env.webId !== webId || env.key !== modelKey) return null;
    if (typeof env.at !== "number" || now - env.at > MAX_AGE_MS) return null;
    // Raise the JSON-plain snapshot back to a type-faithful T.
    return (codec as DurableCodec<T>).decode(env.value);
  } catch {
    return null; // corrupt entry is not a blocker — just fetch fresh
  }
}

/**
 * Persist the latest model for a (WebID, key) pair (best-effort; quota errors
 * swallowed). The value is `encode`d to a JSON-plain shape via the key's codec
 * first, so what lands in storage is guaranteed round-trippable. Skipped when:
 * there is NO REGISTERED CODEC for the key (it is memory-only — never persisted,
 * so it cannot drift its types), there is no WebID (nothing to scope to), or the
 * value is `undefined` (nothing to paint).
 */
export function writeDurableCache<T>(
  webId: string | null | undefined,
  modelKey: string,
  value: T,
  storage: SyncStorage | null = defaultStorage(),
  now: number = Date.now(),
): void {
  if (!storage || !modelKey || !webId || value === undefined) return;
  // No registered codec ⇒ memory-only ⇒ do not persist (no unverified round-trip).
  const codec = codecFor(modelKey);
  if (!codec) return;
  try {
    const env: CacheEnvelope = {
      v: VERSION,
      at: now,
      webId,
      key: modelKey,
      value: (codec as DurableCodec<T>).encode(value),
    };
    storage.setItem(storageKeyFor(webId, modelKey), JSON.stringify(env));
  } catch {
    // Quota/serialisation failure — the cache is an optimisation, never required.
  }
}

/** Remove one (WebID, key) snapshot. */
export function clearDurableCacheEntry(
  webId: string | null | undefined,
  modelKey: string,
  storage: SyncStorage | null = defaultStorage(),
): void {
  if (!storage || !modelKey || !webId) return;
  try {
    storage.removeItem(storageKeyFor(webId, modelKey));
  } catch {
    /* best-effort */
  }
}

/** Collect every key under our prefix (read once; deletes happen after). */
function ourKeys(storage: SyncStorage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.startsWith(PREFIX)) keys.push(k);
  }
  return keys;
}

/**
 * Remove every snapshot belonging to ONE WebID (account switch). The other
 * account's snapshots are left intact. Matches on the in-envelope WebID rather
 * than only the key prefix, so a key-collision can't leave a foreign entry.
 */
export function clearDurableCacheForWebId(
  webId: string | null | undefined,
  storage: SyncStorage | null = defaultStorage(),
): void {
  if (!storage || !webId) return;
  try {
    const prefix = `${PREFIX}${webId}${SEP}`;
    for (const k of ourKeys(storage)) {
      if (k.startsWith(prefix)) storage.removeItem(k);
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Remove EVERY snapshot (all WebIDs, all keys). Called on logout, so a
 * signed-out device leaves no prior user's snapshots behind, regardless of
 * which models were cached.
 */
export function clearAllDurableCache(
  storage: SyncStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    for (const k of ourKeys(storage)) storage.removeItem(k);
  } catch {
    /* best-effort */
  }
}
