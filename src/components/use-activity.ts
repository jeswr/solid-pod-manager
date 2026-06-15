"use client";

import { freshRdf } from "@/lib/rdf-read";
import { useSession } from "@/components/session-provider";
import { useSwrRead } from "@/components/use-swr-read";
import type { RevalidatableState } from "@/components/use-pod-data";
import { discoverRegistrations } from "@/lib/type-index";
import { listCategoryItems, summariseCategories } from "@/lib/pod-data";
import { buildRecentChanges, type ActivityEntry, type CategoryItems } from "@/lib/activity";

/**
 * The most entries the cached feed ever holds. Callers (Home shows a few, the
 * Activity page shows more) slice this down at render, so they SHARE one cache
 * entry and one fetch — navigating Home→Activity→Home serves the cached feed
 * instead of refetching. Keep at/above the largest caller limit (Activity: 50).
 */
const MAX_FEED = 50;

/** The full uncached chain: profile → registrations → list each category → feed. */
async function loadRecentActivity(webId: string): Promise<ActivityEntry[]> {
  const { dataset } = await freshRdf(webId);
  const { locations } = await discoverRegistrations(webId, dataset);
  const withData = summariseCategories(locations).filter((s) => s.hasData);
  if (withData.length === 0) return [];
  // List each category that has data. A single failing container must not sink
  // the whole feed — settle and keep what we could read.
  const settled = await Promise.allSettled(
    withData.map(
      async (s): Promise<CategoryItems> => ({
        category: s.category,
        items: await listCategoryItems(s),
      }),
    ),
  );
  const perCategory = settled
    .filter((r): r is PromiseFulfilledResult<CategoryItems> => r.status === "fulfilled")
    .map((r) => r.value);
  return buildRecentChanges(perCategory, MAX_FEED);
}

/**
 * The "recently changed in your pod" feed: discover categories, list each one
 * that has data, then flatten to the newest-first entries.
 *
 * Stale-while-revalidate (PM finding #3): the feed now goes through the shared
 * {@link useSwrRead} cache (keyed `recent-activity`), so navigating away from
 * Home and back — or a cold open / app reopen (the durable snapshot) — paints
 * the last-known feed INSTANTLY and revalidates in the background, instead of
 * refetching the full discovery+listing chain behind a spinner every time. Home
 * and the Activity page share ONE cache entry (the feed is cached at
 * {@link MAX_FEED}; each caller slices to its own `limit`). The pod root is
 * watched so a change anywhere invalidates + refreshes. Production paths pass NO
 * `fetch` — the auth-patched global runs (AGENTS.md §Reading data).
 *
 * @param limit - max entries to return (Home shows a few, Activity shows more).
 */
export function useRecentActivity(limit = 8): RevalidatableState<ActivityEntry[]> & {
  reload: () => void;
} {
  const { activeStorage } = useSession();
  const { data, error, loading, revalidating, reload } = useSwrRead<ActivityEntry[]>(
    "recent-activity",
    loadRecentActivity,
    // Watch the pod root so an edit/add/delete anywhere invalidates + refreshes.
    { topicUrl: activeStorage },
  );
  return {
    data: data?.slice(0, Math.max(0, limit)),
    error,
    loading,
    revalidating,
    reload,
  };
}
