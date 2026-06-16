// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

import {
  clearAllDurableCache,
  clearDurableCacheEntry,
  clearDurableCacheForWebId,
  readDurableCache,
  writeDurableCache,
} from "./durable-cache.js";

/**
 * In-app stale-while-revalidate (SWR) cache for the expensive pod *read*
 * models that back Home and most pages (PM perf finding: every re-mount
 * re-ran a full uncached chain — `freshRdf(webId)` → type-index discovery →
 * per-ACL reads → per-app client-id fetches — behind a blank spinner).
 *
 * The cache is a render-speed optimization ONLY:
 *
 *   - It holds the last-known *display* value per `(webId, key)` so a re-mount
 *     paints instantly instead of showing a spinner, while a background
 *     revalidation refreshes it.
 *   - It is NEVER authoritative for writes. Mutations (grant/revoke) must read
 *     and act on FRESH data via the backend's own `freshRdf`/ACL re-read — the
 *     cached snapshot is for rendering, never for deciding what to revoke.
 *     See {@link file://../components/use-permissions.ts} (`getFreshModel`).
 *
 * Scope + correctness:
 *
 *   - Entries are partitioned per WebID, so one account never sees another's
 *     data; {@link SwrCache.clearWebId}/{@link SwrCache.clearAll} drop a
 *     partition on logout / account switch.
 *   - {@link SwrCache.invalidate} drops an entry and notifies subscribers so a
 *     mounted view re-revalidates — wired to the existing Solid notification
 *     subscription (`useResourceNotifications`) so a change made elsewhere
 *     (or by a local mutation) cannot leave the rendered cache stale.
 *
 * DURABILITY (offline-first first-paint): the in-memory map is mirrored to a
 * durable, WebID-scoped, versioned snapshot ({@link file://./durable-cache.ts})
 * so a COLD OPEN (full reload / app reopen) can {@link SwrCache.hydrate} the
 * last-good value SYNCHRONOUSLY into memory and paint at once instead of showing
 * a loading screen — then revalidate in the background. The durable layer is the
 * same render-only snapshot (never authoritative for writes), is dropped on
 * logout/account-switch with the in-memory partition, and is bounded by age +
 * versioned so a stale or foreign snapshot can never paint (durable-cache.ts).
 */

/** A cached value plus the freshness marker we revalidate against. */
interface Entry<T = unknown> {
  value: T;
  /** Wall-clock ms when this value was written (for optional staleness UX). */
  storedAt: number;
}

/** Notified when an entry for a `(webId, key)` changes or is invalidated. */
type Listener = () => void;

/**
 * The durable-snapshot port the cache mirrors to/from. Defaults to the real
 * `localStorage`-backed {@link file://./durable-cache.ts} layer; injectable so
 * tests can run with an in-memory fake (or `null` to disable persistence and
 * exercise the pure in-memory behaviour). Keeping it a port (not a direct
 * `localStorage` call) is what makes the durable wiring unit-testable under the
 * `node` Vitest environment, which has no DOM storage.
 */
export interface DurableStore {
  read<T>(webId: string, key: string): T | null;
  write<T>(webId: string, key: string, value: T): void;
  clearEntry(webId: string, key: string): void;
  clearWebId(webId: string): void;
  clearAll(): void;
}

/** The production durable store — the `localStorage` snapshot layer. */
const localStorageDurableStore: DurableStore = {
  read: (webId, key) => readDurableCache(webId, key),
  write: (webId, key, value) => writeDurableCache(webId, key, value),
  clearEntry: (webId, key) => clearDurableCacheEntry(webId, key),
  clearWebId: (webId) => clearDurableCacheForWebId(webId),
  clearAll: () => clearAllDurableCache(),
};

/**
 * A per-WebID, per-key SWR cache with change subscriptions, mirrored to a
 * durable snapshot for instant cold-open first-paint. One shared instance backs
 * the app ({@link readCache}); the class is exported so tests can construct
 * isolated instances (and inject a fake/no durable store).
 */
export class SwrCache {
  /** webId → (key → entry). A missing entry means "no cached value". */
  private readonly store = new Map<string, Map<string, Entry>>();
  /** webId → (key → set of listeners) — subscribers re-render / revalidate. */
  private readonly listeners = new Map<string, Map<string, Set<Listener>>>();
  /** The durable snapshot layer (or `null` to disable persistence in tests). */
  private readonly durable: DurableStore | null;

  /**
   * @param durable - the durable snapshot port. Defaults to the production
   *   `localStorage` layer; pass `null` to disable persistence, or a fake to
   *   assert the durable wiring in tests.
   */
  constructor(durable: DurableStore | null = localStorageDurableStore) {
    this.durable = durable;
  }

  /** The cached value for `(webId, key)`, or `undefined` if none. */
  get<T>(webId: string, key: string): T | undefined {
    return this.store.get(webId)?.get(key)?.value as T | undefined;
  }

  /** Whether a value is currently cached for `(webId, key)`. */
  has(webId: string, key: string): boolean {
    return this.store.get(webId)?.has(key) ?? false;
  }

  /** When `(webId, key)` was last written (ms epoch), or `undefined`. */
  storedAt(webId: string, key: string): number | undefined {
    return this.store.get(webId)?.get(key)?.storedAt;
  }

  /**
   * COLD-OPEN first-paint: if `(webId, key)` is not already in memory, pull the
   * last-good value from the durable snapshot into memory and return it
   * SYNCHRONOUSLY, so the very first render after a reload can seed from it (no
   * await, no spinner). A miss (no/expired/foreign snapshot) returns
   * `undefined`. Does NOT notify — it is a read-time fill, not a change.
   *
   * Idempotent and safe to call on every mount: an existing in-memory entry
   * (e.g. one just revalidated) wins over the durable snapshot.
   */
  hydrate<T>(webId: string, key: string): T | undefined {
    const existing = this.get<T>(webId, key);
    if (existing !== undefined) return existing;
    const persisted = this.durable?.read<T>(webId, key) ?? null;
    if (persisted === null) return undefined;
    // Seed memory from durable WITHOUT notifying — this is filling the cache to
    // serve a first paint, not a value change. storedAt reflects when we read
    // it into memory; freshness for painting is gated by the durable layer's
    // own age bound at read time.
    let byKey = this.store.get(webId);
    if (!byKey) {
      byKey = new Map<string, Entry>();
      this.store.set(webId, byKey);
    }
    byKey.set(key, { value: persisted, storedAt: Date.now() });
    return persisted;
  }

  /** Write (or overwrite) the cached value, persist it, and notify subscribers. */
  set<T>(webId: string, key: string, value: T): void {
    let byKey = this.store.get(webId);
    if (!byKey) {
      byKey = new Map<string, Entry>();
      this.store.set(webId, byKey);
    }
    byKey.set(key, { value, storedAt: Date.now() });
    // Mirror the fresh value to the durable snapshot so the next cold open
    // paints it instantly. Best-effort; never blocks or throws (durable-cache).
    this.durable?.write(webId, key, value);
    this.notify(webId, key);
  }

  /**
   * Drop the cached value for `(webId, key)` and notify subscribers so any
   * mounted view revalidates. Used by notification-driven invalidation and
   * after a local mutation, so the rendered cache can never go stale. Also drops
   * the durable snapshot so a stale value can't be resurrected on the next cold
   * open.
   */
  invalidate(webId: string, key: string): void {
    const removed = this.store.get(webId)?.delete(key);
    this.durable?.clearEntry(webId, key);
    // Always notify: subscribers treat a notification as "go revalidate",
    // which is the right behaviour even if nothing was cached yet.
    this.notify(webId, key);
    return void removed;
  }

  /** Drop every entry for one WebID, in memory AND durable (account switch). */
  clearWebId(webId: string): void {
    this.store.delete(webId);
    this.durable?.clearWebId(webId);
    // Notify each key's listeners so a still-mounted view of that account
    // clears its rendered snapshot rather than showing stale data.
    const byKey = this.listeners.get(webId);
    if (byKey) for (const key of byKey.keys()) this.notify(webId, key);
  }

  /** Drop the entire cache, in memory AND durable (logout / hard reset). */
  clearAll(): void {
    const webIds = [...this.store.keys(), ...this.listeners.keys()];
    this.store.clear();
    this.durable?.clearAll();
    for (const webId of new Set(webIds)) {
      const byKey = this.listeners.get(webId);
      if (byKey) for (const key of byKey.keys()) this.notify(webId, key);
    }
  }

  /**
   * Subscribe to changes for `(webId, key)`. The listener fires on every
   * {@link set}/{@link invalidate}/clear touching that entry. Returns an
   * unsubscribe function (idempotent).
   */
  subscribe(webId: string, key: string, listener: Listener): () => void {
    let byKey = this.listeners.get(webId);
    if (!byKey) {
      byKey = new Map<string, Set<Listener>>();
      this.listeners.set(webId, byKey);
    }
    let set = byKey.get(key);
    if (!set) {
      set = new Set<Listener>();
      byKey.set(key, set);
    }
    set.add(listener);
    return () => {
      const s = this.listeners.get(webId)?.get(key);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) {
        this.listeners.get(webId)?.delete(key);
        if (this.listeners.get(webId)?.size === 0) this.listeners.delete(webId);
      }
    };
  }

  private notify(webId: string, key: string): void {
    const set = this.listeners.get(webId)?.get(key);
    if (!set) return;
    // Copy first: a listener may (un)subscribe during iteration.
    for (const listener of [...set]) listener();
  }
}

/**
 * The one shared read cache for the app. Module-scoped (one per tab); cleared
 * on logout/account switch by the session bridge.
 */
export const readCache = new SwrCache();

/**
 * A SECOND, MEMORY-ONLY SWR cache, reserved for read models whose value can
 * contain PRIVATE third-party content that must NEVER be written to disk — the
 * unified Community feed is the first consumer (its `FeedResult` interleaves
 * PRIVATE Matrix room messages with the public Solid forum). Constructing it
 * with `durable: null` disables the localStorage snapshot layer entirely, so:
 *
 *   - Private Matrix message bodies are kept in memory for the tab's lifetime
 *     ONLY — they never touch `localStorage`, so they cannot outlive the session
 *     or be read off disk later (the privacy leak roborev flagged: the default
 *     {@link readCache} mirrors every value to a durable, persisted snapshot).
 *   - The instant-nav UX is still preserved WITHIN the session: in-memory
 *     cross-mount sharing, subscriptions, and stale-while-revalidate all work
 *     exactly as with {@link readCache}; only the cold-open durable hydration is
 *     dropped (a fresh fetch on a cold reload is correct here — and a fresh
 *     reload should not paint last session's private chat from disk anyway).
 *
 * Like {@link readCache} it is module-scoped (one per tab) and MUST be cleared
 * on logout / account switch by the session bridge — it holds per-WebID private
 * content and is wiped alongside `readCache` there.
 */
export const memoryReadCache = new SwrCache(null);

/**
 * The synchronously-derivable part of {@link useSwrRead}'s state for a given
 * `(webId, key)` — what the very FIRST paint under that key must show. Kept a
 * pure function (no React) so it is unit-testable and so the hook can use it
 * BOTH on mount AND when the cache key changes mid-life: a key change
 * (e.g. a storage switch, `assigned-tasks:<A>` → `:<B>`) must immediately
 * reflect the NEW key's cache, never linger on the previous key's `data` for
 * even one paint (roborev finding, use-federation-tasks via useSwrRead).
 */
export interface SwrInitialState<T> {
  /** The cached value for the new key, hydrated cold from durable if needed. */
  data: T | undefined;
  /** True only when there is NOTHING cached for the new key (cold spinner). */
  loading: boolean;
  /** True when a cached value will be shown and a background refetch will run. */
  revalidating: boolean;
}

/**
 * Derive the initial SWR state for `(webId, key)` from the cache, hydrating the
 * durable snapshot into memory if needed (so a cold open / a key change to an
 * already-cached key both paint instantly).
 *
 * No WebID, or an empty key, means the read is not ready yet (session still
 * resolving, or a storage not yet chosen) — there is NOTHING to show and no
 * cache to touch, so it reports `loading: true` (matching the pre-existing hook
 * behaviour: the empty-key/no-session phase showed a spinner, not an empty
 * state). A consumer that resolves the empty-key case itself (e.g.
 * `useCategoryItems` short-circuiting a no-data category) ignores this and never
 * reaches it.
 *
 * @param cache - the SWR cache to read from.
 * @param webId - the active WebID, or `undefined`/empty for "no session yet".
 * @param key - the cache key, or `""` for "nothing to read here yet".
 */
export function deriveSwrInitialState<T>(
  cache: SwrCache,
  webId: string | undefined,
  key: string,
): SwrInitialState<T> {
  if (!webId || key === "") {
    // Not ready (no session / no key yet): show the spinner, touch no cache.
    return { data: undefined, loading: true, revalidating: false };
  }
  const cached = cache.hydrate<T>(webId, key);
  if (cached !== undefined) {
    // Cached (in-memory or hydrated cold from durable): paint it, revalidate.
    return { data: cached, loading: false, revalidating: true };
  }
  // Cold: first-ever load for this account/key — the spinner is correct.
  return { data: undefined, loading: true, revalidating: false };
}
