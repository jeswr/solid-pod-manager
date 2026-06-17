"use client";

import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { useSession } from "@/components/session-provider";
import { useSwrRead } from "@/components/use-swr-read";
import {
  type ItemStore,
  type StoredItem,
} from "@/lib/productivity-store";
import type { AdvisoryHandler } from "@/lib/shacl/advisory";
import type { RevalidatableState } from "@/components/use-pod-data";

/**
 * The default advisory-validation surface (ADR-0014 Phase 1): a non-blocking
 * sonner warning toast. A write that fails SHACL validation still succeeds —
 * this only informs the user the saved data may not be fully interoperable.
 */
const advisoryToast: AdvisoryHandler = (notice) => {
  const n = notice.results.length;
  toast.warning(
    `Saved, but this data may not be fully interoperable (${n} shape ${n === 1 ? "issue" : "issues"}).`,
    {
      description:
        notice.results
          .map((r) => r.message || r.path)
          .filter(Boolean)
          .slice(0, 3)
          .join("; ") || undefined,
    },
  );
};

/**
 * Bind a productivity store (Notes / Calendar / Contacts) to the active Solid
 * session. Returns `undefined` until the user is logged in with a chosen
 * storage. Production paths pass NO `fetch` to the store — the auth-patched
 * global runs (AGENTS.md §Reading data).
 *
 * @param factory - the app's store constructor (`notesStore` / …). Memoised on
 *   identity; pass a module-level function reference.
 */
export function useStore<T>(
  factory: (opts: {
    podRoot: string;
    webId: string;
    onAdvisory?: AdvisoryHandler;
  }) => ItemStore<T>,
): ItemStore<T> | undefined {
  const { webId, activeStorage, status } = useSession();
  return useMemo(() => {
    if (status !== "logged-in" || !webId || !activeStorage) return undefined;
    // Supply the advisory-toast surface to every store. Stores that haven't
    // opted into validation (`cfg.validate` unset) simply never call it
    // (ADR-0014 Phase 1) — it is the no-op default for them.
    return factory({ podRoot: activeStorage, webId, onAdvisory: advisoryToast });
  }, [factory, webId, activeStorage, status]);
}

/**
 * List items from a store, with loading / empty / error state and a `reload`.
 *
 * Stale-while-revalidate: the listing goes through the shared {@link useSwrRead}
 * cache, keyed PER STORE CONTAINER (`productivity:<container>`), so navigating
 * back to a Notes / Calendar / Contacts list paints the last-seen items
 * INSTANTLY and revalidates in the background; the store's container is watched
 * so an add/edit/delete there invalidates + refreshes it. The store carries the
 * WebID it is bound to via the session, and `useSwrRead` partitions by WebID, so
 * two accounts never share a slot. SECURITY: the cache is render-only; the page
 * mutates through the `store` (a fresh server write), not the cached snapshot.
 */
export function useItems<T>(
  store: ItemStore<T> | undefined,
): RevalidatableState<StoredItem<T>[]> & { reload: () => void } {
  // Per-container key; no store yet → empty key (no fetch, loading state),
  // matching the previous "no store → loading" behaviour exactly.
  const key = store ? `productivity:${store.container}` : "";
  const fetcher = useCallback(
    () => (store ? store.list() : Promise.resolve<StoredItem<T>[]>([])),
    [store],
  );
  const { data, error, loading, revalidating, reload } = useSwrRead<StoredItem<T>[]>(
    key,
    fetcher,
    { topicUrl: store?.container },
  );
  return { data, error, loading, revalidating, reload };
}

/**
 * Read a single item by URL from a store. Used by the detail/edit views.
 *
 * Stale-while-revalidate: keyed PER ITEM URL (`productivity-item:<url>`), so
 * re-opening an item you have viewed paints it INSTANTLY and revalidates; the
 * item resource is watched for live changes. SECURITY: render-only cache; edits
 * go through the `store`, not the cached snapshot.
 */
export function useItem<T>(
  store: ItemStore<T> | undefined,
  url: string | undefined,
): RevalidatableState<StoredItem<T> | undefined> & { reload: () => void } {
  const key = store && url ? `productivity-item:${url}` : "";
  const fetcher = useCallback(
    () =>
      store && url
        ? store.read(url)
        : Promise.resolve<StoredItem<T> | undefined>(undefined),
    [store, url],
  );
  const { data, error, loading, revalidating, reload } = useSwrRead<
    StoredItem<T> | undefined
  >(key, fetcher, { topicUrl: url });
  return { data, error, loading, revalidating, reload };
}
