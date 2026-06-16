// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * React hooks over the WebID-index consumer client (`@/lib/webid-index`):
 *
 *   - {@link useWebIdSearch} — search the index for people by name/WebID, with
 *     stale-while-revalidate caching via the shared {@link useSwrRead} cache
 *     (keyed `webid-search:<q>`), so re-typing a recent query paints instantly.
 *   - {@link useIsIndexed} — whether a given WebID is already in the index
 *     (keyed `webid-indexed:<webid>`), to label a result/contact.
 *
 * Both are GATED on `NEXT_PUBLIC_WEBID_INDEX`: when no index origin is
 * configured the shared client is `null`, so the hooks short-circuit to an inert
 * empty state (`enabled:false`, no fetch) — the consuming UI hides the feature.
 *
 * SECURITY/PRIVACY: the client only talks to the configured index origin, with
 * credentials omitted (`@/lib/webid-index`), so the user's DPoP auth is never
 * attached to the index. These hooks pass the SEARCH QUERY (a name or a WebID
 * the user typed) only — never any pod PII — to that one origin. We do NOT route
 * index reads through the session/auth fetch.
 */
import { useCallback } from "react";
import { useSwrRead, type SwrReadState } from "@/components/use-swr-read";
import {
  isWebIdIndexEnabled,
  webIdIndexClient,
} from "@/lib/webid-index";
import type { IndexPage } from "@/lib/webid-index-client";

/** The state returned by {@link useWebIdSearch}. */
export interface WebIdSearchState extends SwrReadState<IndexPage> {
  /** False when no index is configured (`NEXT_PUBLIC_WEBID_INDEX` unset). */
  enabled: boolean;
}

/**
 * The SWR cache key for a search. Pure + exported so the "empty key = no fetch"
 * gating (feature off OR blank query) is unit-testable without a React render.
 * An empty string means "do nothing" per the `useSwrRead` contract.
 */
export function searchKey(query: string, enabled: boolean): string {
  const q = query.trim();
  return enabled && q ? `webid-search:${q}` : "";
}

/** The SWR cache key for an isIndexed check. Pure + exported (see {@link searchKey}). */
export function indexedKey(webid: string | undefined, enabled: boolean): string {
  const id = webid?.trim() ?? "";
  return enabled && id ? `webid-indexed:${id}` : "";
}

/**
 * Search the WebID index for `query`. An empty/whitespace query (or a disabled
 * feature) does no work and returns `data: undefined` with `loading:false`.
 *
 * Stale-while-revalidate: keyed `webid-search:<q>` so re-running a recent query
 * paints the last result instantly and revalidates. The cache is partitioned per
 * WebID by `useSwrRead`; the index results are public, so this only means a
 * given account reuses its own recent searches (no cross-account leak).
 *
 * @param query - the free-text search (a name, or a WebID URL).
 * @param limit - optional page-size hint forwarded to the index.
 */
export function useWebIdSearch(query: string, limit?: number): WebIdSearchState {
  const q = query.trim();
  // No fetch when the feature is off or the query is empty (empty key = inert,
  // per the useSwrRead contract).
  const key = searchKey(q, isWebIdIndexEnabled);

  const fetcher = useCallback(async (): Promise<IndexPage> => {
    if (!webIdIndexClient || !q) return { entries: [], next: null };
    return webIdIndexClient.search(q, limit !== undefined ? { limit } : undefined);
  }, [q, limit]);

  const state = useSwrRead<IndexPage>(key, fetcher);
  return { ...state, enabled: isWebIdIndexEnabled };
}

/**
 * Whether `webid` is already present in the index. Fails closed: any inability
 * to confirm resolves to `false` (the client's own contract). Inert (returns
 * `false`, no fetch) when the feature is off or no WebID is given.
 *
 * Keyed `webid-indexed:<webid>` for SWR caching.
 */
export function useIsIndexed(webid: string | undefined): SwrReadState<boolean> {
  const id = webid?.trim() ?? "";
  const key = indexedKey(id, isWebIdIndexEnabled);

  const fetcher = useCallback(async (): Promise<boolean> => {
    if (!webIdIndexClient || !id) return false;
    return webIdIndexClient.isIndexed(id);
  }, [id]);

  return useSwrRead<boolean>(key, fetcher);
}
