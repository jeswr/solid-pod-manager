// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * `useSwrRead` — the React bridge over {@link SwrCache} that gives the
 * expensive pod read models stale-while-revalidate behaviour:
 *
 *   - On (re-)mount, if a value is cached for this `(webId, key)` — in memory OR
 *     in the durable snapshot ({@link SwrCache.hydrate}, so a COLD OPEN / app
 *     reopen counts) — it renders INSTANTLY (`loading:false`), no blank spinner,
 *     and a background revalidation runs (`revalidating:true`). Only a
 *     first-EVER load with no snapshot at all shows the spinner (`loading:true`).
 *   - The cache is shared across mounts and views, so two pages reading the
 *     same model share one fetch and one cached value.
 *   - It subscribes to the cache, so a `set`/`invalidate`/clear from anywhere
 *     (another mount, a notification, a logout) updates this view.
 *   - It wires the existing {@link useResourceNotifications} subscription to
 *     {@link SwrCache.invalidate}, so a change to the underlying resource
 *     (made here or elsewhere) drops the cached entry and revalidates — the
 *     rendered snapshot can never silently go stale.
 *
 * SECURITY: this is a READ render-speed cache only. Mutations must NOT act on
 * the cached snapshot — callers that mutate (grant/revoke) re-read fresh via
 * the backend's `freshRdf`/ACL read. See `use-permissions.ts` `getFreshModel`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/components/session-provider";
import { useResourceNotifications } from "@/components/use-resource-notifications";
import { readCache, type SwrCache } from "@/lib/swr-cache";

export interface SwrReadState<T> {
  /** Last-known value (cached or freshly fetched), or `undefined`. */
  data?: T;
  /** Set when the *initial* (uncached) load or a revalidation failed. */
  error?: Error;
  /** True only when there is NOTHING to show yet (first uncached load). */
  loading: boolean;
  /** True while a background revalidation is in flight (cached value shown). */
  revalidating: boolean;
  /** Force a fresh revalidation now (e.g. an explicit retry). */
  reload: () => void;
}

export interface UseSwrReadOptions {
  /**
   * A resource/container to watch for live changes; a notification invalidates
   * the cached entry and revalidates. Omit when there is nothing to watch.
   */
  topicUrl?: string;
  /** Test-only cache override; production uses the shared {@link readCache}. */
  cache?: SwrCache;
}

/**
 * Read a model under `key`, scoped to the active WebID, with SWR semantics.
 *
 * @param key - stable cache key for this model (e.g. `"connected-apps"`). It is
 *   partitioned per WebID internally; do not pre-mix the WebID into it.
 * @param fetcher - performs the (uncached, authoritative) read. Called on first
 *   load and on every revalidation. Receives the active WebID.
 */
export function useSwrRead<T>(
  key: string,
  fetcher: (webId: string) => Promise<T>,
  options: UseSwrReadOptions = {},
): SwrReadState<T> {
  const { webId, status } = useSession();
  const cache = options.cache ?? readCache;

  // Keep the freshest fetcher without making it a revalidation dependency — a
  // new closure each render must not retrigger fetches.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Seed from the cache SYNCHRONOUSLY on first render: prefer the in-memory
  // value, else pull the durable snapshot into memory (cold open / app reopen).
  // This is what lets the first paint after a reload show data, not a spinner.
  const initial = webId && key !== "" ? cache.hydrate<T>(webId, key) : undefined;
  const [data, setData] = useState<T | undefined>(initial);
  const [error, setError] = useState<Error | undefined>(undefined);
  // loading = nothing to show yet; revalidating = refreshing a shown value.
  const [loading, setLoading] = useState(initial === undefined);
  const [revalidating, setRevalidating] = useState(false);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // Revalidate on a notification. We keep the cached value VISIBLE (stale)
  // while the background refetch runs — dropping it would flash a spinner — and
  // overwrite it on success. Dropping an entry outright is reserved for logout/
  // account-switch (SwrCache.clearAll/clearWebId in the session bridge).
  const revalidate = useCallback(() => reload(), [reload]);

  useEffect(() => {
    // An empty key means "nothing to read here" (e.g. a category with no data);
    // do no work and never touch the cache.
    if (status !== "logged-in" || !webId || key === "") return;
    let cancelled = false;

    // Hydrate (in-memory hit, else durable snapshot → memory) so a cold open
    // takes the stale-while-revalidate path, not the cold spinner path.
    const cached = cache.hydrate<T>(webId, key);
    if (cached !== undefined) {
      // Stale-while-revalidate: paint the cached value immediately.
      setData(cached);
      setLoading(false);
      setRevalidating(true);
    } else {
      // Cold: first load for this account/key — the spinner is correct.
      setData(undefined);
      setLoading(true);
      setRevalidating(false);
    }

    fetcherRef
      .current(webId)
      .then((fresh) => {
        if (cancelled) return;
        cache.set(webId, key, fresh); // updates this + every other mount
        setError(undefined);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // A revalidation failure must not blow away a good cached value; only
        // surface the error when we have nothing to show.
        const err = e instanceof Error ? e : new Error(String(e));
        if (cache.get<T>(webId, key) === undefined) setError(err);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setRevalidating(false);
      });

    return () => {
      cancelled = true;
    };
  }, [cache, webId, key, status, nonce]);

  // Cross-mount + invalidation sync: reflect cache writes/clears from anywhere
  // (another view, a notification, a logout) into this view's state.
  useEffect(() => {
    if (!webId || key === "") return;
    return cache.subscribe(webId, key, () => {
      const next = cache.get<T>(webId, key);
      setData(next);
      if (next !== undefined) {
        setLoading(false);
        setError(undefined);
      }
    });
  }, [cache, webId, key]);

  // Live invalidation: a change to the watched resource triggers a background
  // revalidation (cached value stays visible, then is overwritten), so the
  // rendered snapshot can never silently go stale. Degrades silently when the
  // server has no notifications (existing useResourceNotifications contract).
  useResourceNotifications(options.topicUrl, revalidate);

  return { data, error, loading, revalidating, reload };
}
