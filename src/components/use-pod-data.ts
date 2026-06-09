"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchRdf } from "@jeswr/fetch-rdf";
import { useSession } from "@/components/session-provider";
import { discoverRegistrations } from "@/lib/type-index";
import {
  listCategoryItems,
  summariseCategories,
  type CategorySummary,
  type PodItem,
} from "@/lib/pod-data";

/** Generic async state for any pod-read surface (loading / empty / error). */
export interface AsyncState<T> {
  data?: T;
  error?: Error;
  loading: boolean;
}

/**
 * Discover the user's data categories from their Type Index.
 *
 * Production paths pass NO `fetch` to the data layer — the auth-patched global
 * runs (AGENTS.md §Reading data). Re-runs when the active WebID changes.
 */
export function useCategorySummaries(): AsyncState<CategorySummary[]> {
  const { webId, status } = useSession();
  const [state, setState] = useState<AsyncState<CategorySummary[]>>({ loading: true });

  useEffect(() => {
    if (status !== "logged-in" || !webId) return;
    let cancelled = false;
    setState({ loading: true });

    (async () => {
      // The profile carries the type-index links — fetch it (public read).
      const { dataset } = await fetchRdf(webId);
      const { locations } = await discoverRegistrations(webId, dataset);
      if (cancelled) return;
      setState({ loading: false, data: summariseCategories(locations) });
    })().catch((e: unknown) => {
      if (!cancelled) {
        setState({ loading: false, error: e instanceof Error ? e : new Error(String(e)) });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [webId, status]);

  return state;
}

/** A single category summary, looked up by its route id. */
export function useCategorySummary(
  categoryId: string,
): AsyncState<CategorySummary | undefined> {
  const { data, loading, error } = useCategorySummaries();
  if (loading) return { loading: true };
  if (error) return { loading: false, error };
  return {
    loading: false,
    data: data?.find((s) => s.category.id === categoryId),
  };
}

/**
 * List the items inside a category. Re-fetches when the summary or session
 * changes. Production paths pass no `fetch` (auth-patched global runs).
 */
export function useCategoryItems(
  summary: CategorySummary | undefined,
): AsyncState<PodItem[]> & { reload: () => void } {
  const { status } = useSession();
  const [state, setState] = useState<AsyncState<PodItem[]>>({ loading: true });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (status !== "logged-in") return;
    if (!summary) {
      setState({ loading: false, data: [] });
      return;
    }
    if (!summary.hasData) {
      setState({ loading: false, data: [] });
      return;
    }
    let cancelled = false;
    setState({ loading: true });
    listCategoryItems(summary)
      .then((items) => {
        if (!cancelled) setState({ loading: false, data: items });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState({
            loading: false,
            error: e instanceof Error ? e : new Error(String(e)),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [summary, status, nonce]);

  return { ...state, reload };
}
