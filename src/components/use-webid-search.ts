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
 *
 * `limit` is part of the key (when set) because the fetcher forwards it as the
 * page size — two searches for the same query but different limits return
 * different pages, so they must NOT share a cache slot (roborev finding).
 */
export function searchKey(query: string, enabled: boolean, limit?: number): string {
  const q = query.trim();
  if (!enabled || !q) return "";
  // `encodeURIComponent` the query so a `limit` segment can never be forged by a
  // query that literally contains `:limit:` — e.g. the query `ada:limit:5` with
  // no limit must NOT collide with query `ada` + limit 5 (roborev finding). The
  // encoded form has no bare `:`, so the structure is unambiguous.
  const enc = encodeURIComponent(q);
  return limit !== undefined ? `webid-search:${enc}:limit:${limit}` : `webid-search:${enc}`;
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
  // per the useSwrRead contract). `limit` is part of the key so different page
  // sizes don't share a slot.
  const key = searchKey(q, isWebIdIndexEnabled, limit);

  const fetcher = useCallback(async (): Promise<IndexPage> => {
    if (!webIdIndexClient || !q) return { entries: [], next: null };
    return webIdIndexClient.search(q, limit !== undefined ? { limit } : undefined);
  }, [q, limit]);

  const state = useSwrRead<IndexPage>(key, fetcher);
  // An empty key (feature off OR blank query) is the INERT state: `useSwrRead`
  // reports `loading:true` for an empty key (its "session/key not ready yet"
  // spinner default — see deriveSwrInitialState), but here a blank query is a
  // resolved "nothing to search" state, not a pending load. Normalising to
  // `loading:false` stops the panel showing skeletons before the user has typed
  // anything (roborev finding).
  if (key === "") {
    return {
      data: undefined,
      error: undefined,
      loading: false,
      revalidating: false,
      reload: state.reload,
      enabled: isWebIdIndexEnabled,
    };
  }
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

  const state = useSwrRead<boolean>(key, fetcher);
  // Inert (no WebID / feature off): resolve to a settled `false`, not the
  // empty-key `loading:true` default (see useWebIdSearch).
  if (key === "") {
    return {
      data: false,
      error: undefined,
      loading: false,
      revalidating: false,
      reload: state.reload,
    };
  }
  return state;
}
