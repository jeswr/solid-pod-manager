"use client";

import { freshRdf } from "@/lib/rdf-read";
import { useSession } from "@/components/session-provider";
import { useSwrRead } from "@/components/use-swr-read";
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

/** AsyncState plus the SWR background-revalidation flag. */
export interface RevalidatableState<T> extends AsyncState<T> {
  /** True while a background revalidation refreshes a shown (cached) value. */
  revalidating: boolean;
}

/**
 * The uncached type-index discovery chain (profile → registrations).
 *
 * Exported so the PROACTIVE PREFETCH orchestrator ({@link file://../lib/prefetch.ts})
 * can warm the `category-summaries` cache from the EXACT SAME fetcher this hook
 * uses — single source of truth, no duplicated fetch logic.
 */
export async function loadCategorySummaries(webId: string): Promise<CategorySummary[]> {
  // The profile carries the type-index links — fetch it (public read,
  // revalidated: a just-bootstrapped index link must not be cache-hidden).
  const { dataset } = await freshRdf(webId);
  const { locations } = await discoverRegistrations(webId, dataset);
  return summariseCategories(locations);
}

/**
 * Discover the user's data categories from their Type Index.
 *
 * Stale-while-revalidate (SWR): on re-mount the last-known categories render
 * INSTANTLY (Home/My-data no longer spin) while a background revalidation
 * refreshes them; the profile is watched so a type-index change invalidates the
 * cache. Production paths pass NO `fetch` to the data layer — the auth-patched
 * global runs (AGENTS.md §Reading data).
 */
export function useCategorySummaries(): RevalidatableState<CategorySummary[]> {
  const { webId } = useSession();
  const { data, error, loading, revalidating } = useSwrRead<CategorySummary[]>(
    "category-summaries",
    loadCategorySummaries,
    // Watch the profile doc: a type-index link change there invalidates this.
    { topicUrl: webId },
  );
  return { data, error, loading, revalidating };
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
 * List the items inside a category, with SWR caching keyed by the category id.
 * On re-mount the last-known items render INSTANTLY while a background
 * revalidation refreshes them; the category's container is watched so an
 * edit/add/delete elsewhere invalidates the cache. Production paths pass no
 * `fetch` (auth-patched global runs).
 *
 * A `summary` with no data (or none at all) has nothing to list — those resolve
 * to `[]` synchronously without a fetch (and without a cache entry).
 */
export function useCategoryItems(
  summary: CategorySummary | undefined,
): RevalidatableState<PodItem[]> & { reload: () => void } {
  const hasData = Boolean(summary?.hasData);
  // A single-`instance` category has no container to watch (point resource).
  const topicUrl = summary?.locations.find((l) => l.container)?.container;

  // Cache key per category id so two mounts of the same category share a value;
  // the no-data/no-summary cases never touch the cache (key stays empty).
  const key = hasData && summary ? `category-items:${summary.category.id}` : "";

  const { data, error, loading, revalidating, reload } = useSwrRead<PodItem[]>(
    key,
    // Only invoked when hasData (key non-empty) — list the live items.
    () => (summary ? listCategoryItems(summary) : Promise.resolve([])),
    { topicUrl },
  );

  // No data to list: resolve to an empty list with no spinner, matching the
  // previous behaviour exactly (no fetch, no cache entry).
  if (!hasData) {
    return { loading: false, revalidating: false, data: [], reload };
  }
  return { data, error, loading, revalidating, reload };
}
