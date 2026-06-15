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
 */

const PREFIX = "solid-pod-manager:read-cache:";

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

/** The persisted envelope around one cached model. */
interface CacheEnvelope<T = unknown> {
  v: number;
  /** When the snapshot was written (epoch ms). */
  at: number;
  /** The WebID that fetched this model — only this identity may paint it. */
  webId: string;
  /** The model key (defence-in-depth against key collisions). */
  key: string;
  value: T;
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
 * usable snapshot (absent, wrong version, WebID/key mismatch, too old, or
 * unparseable). A missing or mismatched WebID is a MISS — a snapshot is only
 * ever painted back for the SAME authenticated WebID that fetched it, so one
 * user's pod data can never paint for a different later user on the same
 * browser.
 */
export function readDurableCache<T>(
  webId: string | null | undefined,
  modelKey: string,
  storage: SyncStorage | null = defaultStorage(),
  now: number = Date.now(),
): T | null {
  // No authenticated identity ⇒ nothing to match against ⇒ cache miss (no hydrate).
  if (!storage || !modelKey || !webId) return null;
  try {
    const raw = storage.getItem(storageKeyFor(webId, modelKey));
    if (!raw) return null;
    const env = JSON.parse(raw) as CacheEnvelope<T>;
    // Version, WebID, AND key must all match the current identity/model.
    if (env.v !== VERSION || env.webId !== webId || env.key !== modelKey) return null;
    if (typeof env.at !== "number" || now - env.at > MAX_AGE_MS) return null;
    return env.value;
  } catch {
    return null; // corrupt entry is not a blocker — just fetch fresh
  }
}

/**
 * Persist the latest model for a (WebID, key) pair (best-effort; quota errors
 * swallowed). Without a WebID there is nothing to scope the snapshot to, so the
 * write is skipped (the data would be unreadable anyway). `undefined` values
 * are not persisted (there is nothing to paint).
 */
export function writeDurableCache<T>(
  webId: string | null | undefined,
  modelKey: string,
  value: T,
  storage: SyncStorage | null = defaultStorage(),
  now: number = Date.now(),
): void {
  if (!storage || !modelKey || !webId || value === undefined) return;
  const env: CacheEnvelope<T> = { v: VERSION, at: now, webId, key: modelKey, value };
  try {
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
