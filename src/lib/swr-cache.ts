// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

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
 * No service worker, no new infra — a plain in-memory module (process-/tab-
 * scoped), intentionally not persisted: a reload starts cold, which is correct
 * for security-sensitive access info (never resurrect a stale ACL view across
 * sessions).
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
 * A per-WebID, per-key SWR cache with change subscriptions. One shared
 * instance backs the app ({@link readCache}); the class is exported so tests
 * can construct isolated instances.
 */
export class SwrCache {
  /** webId → (key → entry). A missing entry means "no cached value". */
  private readonly store = new Map<string, Map<string, Entry>>();
  /** webId → (key → set of listeners) — subscribers re-render / revalidate. */
  private readonly listeners = new Map<string, Map<string, Set<Listener>>>();

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

  /** Write (or overwrite) the cached value and notify subscribers. */
  set<T>(webId: string, key: string, value: T): void {
    let byKey = this.store.get(webId);
    if (!byKey) {
      byKey = new Map<string, Entry>();
      this.store.set(webId, byKey);
    }
    byKey.set(key, { value, storedAt: Date.now() });
    this.notify(webId, key);
  }

  /**
   * Drop the cached value for `(webId, key)` and notify subscribers so any
   * mounted view revalidates. Used by notification-driven invalidation and
   * after a local mutation, so the rendered cache can never go stale.
   */
  invalidate(webId: string, key: string): void {
    const removed = this.store.get(webId)?.delete(key);
    // Always notify: subscribers treat a notification as "go revalidate",
    // which is the right behaviour even if nothing was cached yet.
    this.notify(webId, key);
    return void removed;
  }

  /** Drop every entry for one WebID (logout / account switch). */
  clearWebId(webId: string): void {
    this.store.delete(webId);
    // Notify each key's listeners so a still-mounted view of that account
    // clears its rendered snapshot rather than showing stale data.
    const byKey = this.listeners.get(webId);
    if (byKey) for (const key of byKey.keys()) this.notify(webId, key);
  }

  /** Drop the entire cache (hard reset). */
  clearAll(): void {
    const webIds = [...this.store.keys(), ...this.listeners.keys()];
    this.store.clear();
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
