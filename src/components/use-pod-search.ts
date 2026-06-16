// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * `usePodSearch` — the global pod-search hook (task #97 / research G9), a
 * QUERY-DRIVEN read over the shared {@link useSwrRead} cache.
 *
 * It mirrors {@link file://./use-webid-search.ts useWebIdSearch}: the search is
 * keyed `pod-search:<storage>:<q>` so re-running a recent query paints its last
 * result INSTANTLY (stale-while-revalidate) instead of re-scanning the whole pod
 * behind a spinner — exactly the instant-nav guarantee the structural test
 * enforces. The key is SCOPED PER ACTIVE STORAGE: the scan reads the active
 * storage's stores + type index, so a SAME-WebID storage switch MUST change the
 * key and re-scan rather than paint the previous pod's matches (the active-
 * storage SWR rule). A blank / too-short query is INERT (empty key ⇒ no fetch).
 *
 * The fetcher delegates to {@link searchPod}, which is OWN-POD-ONLY and BOUNDED
 * (source cap, result cap, time budget) so a large pod can never hang the UI;
 * the bounded {@link SearchOutcome} (incl. the `capped` flag) is the cached model.
 */
import { useCallback } from "react";
import { useSession } from "@/components/session-provider";
import { useSwrRead, type SwrReadState } from "@/components/use-swr-read";
import {
  isSearchable,
  searchPod,
  type SearchContext,
  type SearchOutcome,
} from "@/lib/pod-search";

/** The empty (no-query / not-ready) outcome — a settled, inert state. */
const EMPTY_OUTCOME: SearchOutcome = { results: [], capped: false, sourcesScanned: 0 };

/**
 * The SWR cache key for a pod search. Pure + exported so the "empty key = no
 * fetch" gating (blank/short query, or no active storage yet) is unit-testable
 * without a React render. An empty string means "do nothing" per the
 * {@link useSwrRead} contract.
 *
 * `encodeURIComponent` the query so it can never forge the `<storage>:<q>`
 * structure (a query literally containing `:` cannot collide across storages).
 */
export function podSearchKey(query: string, activeStorage: string | undefined): string {
  const q = query.trim();
  if (!activeStorage || !isSearchable(q)) return "";
  return `pod-search:${activeStorage}:${encodeURIComponent(q)}`;
}

/** The state {@link usePodSearch} returns. */
export interface PodSearchState extends SwrReadState<SearchOutcome> {
  /** True once the query is long enough to have triggered a search. */
  active: boolean;
}

/**
 * Search the user's own pod for `query`. A blank / too-short query (or a session
 * without an active storage yet) does no work and returns the settled empty
 * outcome with `loading:false`.
 *
 * Stale-while-revalidate, keyed `pod-search:<storage>:<q>`, so re-running a
 * recent search paints instantly + revalidates. NO live `topicUrl` watch: a
 * search spans MANY pod resources (no single container to subscribe to), and a
 * stale match self-heals on the next keystroke / revalidation — wiring one
 * topic would be misleading. Production passes NO `fetch` (auth-patched global).
 */
export function usePodSearch(query: string): PodSearchState {
  const { activeStorage, profile } = useSession();
  const storages = profile?.storages;
  const q = query.trim();
  const key = podSearchKey(q, activeStorage);

  // Snapshot the storages as a stable primitive so the fetcher's deps don't
  // change identity every render (the array is a fresh reference each time).
  const storagesKey = (storages ?? []).join("|");

  const fetcher = useCallback(
    async (webId: string): Promise<SearchOutcome> => {
      if (!activeStorage || !isSearchable(q)) return EMPTY_OUTCOME;
      const own = storagesKey ? storagesKey.split("|") : [];
      const ctx: SearchContext = {
        webId,
        activeStorage,
        // The scan validates own-pod containment against every storage; fall
        // back to just the active storage if the session hasn't enumerated them.
        storages: own.length > 0 ? own : [activeStorage],
      };
      return searchPod(ctx, q);
    },
    [q, activeStorage, storagesKey],
  );

  const state = useSwrRead<SearchOutcome>(key, fetcher);

  // An empty key (blank/short query, or no storage) is the INERT state:
  // `useSwrRead` reports `loading:true` for an empty key (its "not ready yet"
  // default), but a blank query is a resolved "nothing to search" state, not a
  // pending load — normalise so the page shows the prompt, not a skeleton, until
  // the user types (mirrors useWebIdSearch).
  if (key === "") {
    return {
      data: EMPTY_OUTCOME,
      error: undefined,
      loading: false,
      revalidating: false,
      reload: state.reload,
      active: false,
    };
  }
  return { ...state, active: true };
}
