// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Read the tracker-document metadata for a tracker container (READ ONLY).
 *
 * Surfaces the `wf:Tracker` config doc (`<container>index.ttl#this`) — title,
 * issue class, state store, categories, assignee group, and the workflow states
 * + transitions — for a container that carries one (the Issues container). When
 * the container has NO tracker config, `data` is `null` (a known "no tracker"
 * answer, distinct from the loading state).
 *
 * Production paths pass NO `fetch` — the auth-patched global runs (this is a
 * SAME-POD authenticated read, NOT the foreign-origin boundary; see lib/tracker).
 *
 * Stale-while-revalidate (instant-nav): goes through the shared {@link useSwrRead}
 * cache keyed PER CONTAINER (`tracker:<containerUrl>`). The container is derived
 * from the active storage, so the key is implicitly storage-scoped — a same-WebID
 * storage switch changes the container and therefore the key, so the view
 * revalidates against the new pod rather than painting the previous pod's tracker
 * (the active-storage SWR rule). The tracker doc URL is watched so a change to the
 * config invalidates + refreshes. SECURITY: render-only cache; a tracker WRITE
 * (a later builder) must read FRESH, never this cached snapshot.
 */
import { useCallback } from "react";
import { useSwrRead } from "@/components/use-swr-read";
import {
  readTrackerMeta,
  trackerDocUrl,
  TRACKER_KEY_PREFIX,
  trackerKey,
  type TrackerMeta,
} from "@/lib/tracker";
import type { RevalidatableState } from "@/components/use-pod-data";

// The cache-key helpers live in the non-React lib (so the non-React prefetch
// layer can build the same key without importing this `"use client"` module);
// re-export them here as the tracker model's public key surface.
export { TRACKER_KEY_PREFIX, trackerKey };

/**
 * Read the tracker metadata for `containerUrl` (e.g. the Issues container), with
 * stale-while-revalidate caching. `data` is:
 *   - `undefined` while the FIRST (uncached) load is in flight (`loading`);
 *   - `null` when the container has no tracker config doc (a known "none");
 *   - a {@link TrackerMeta} when a `wf:Tracker` config doc is present.
 *
 * @param containerUrl - the tracker container URL (MUST end in `/`), or
 *   `undefined` when not yet known (logged-out / no storage) — then nothing is
 *   read (an empty key is a no-op in `useSwrRead`).
 */
export function useTrackerMeta(
  containerUrl: string | undefined,
): RevalidatableState<TrackerMeta | null> & { reload: () => void } {
  // Production passes NO fetch — the auth-patched global runs. `null` ⇒ "no
  // tracker configured", so the cache distinguishes it from the loading state.
  const fetcher = useCallback(
    async (): Promise<TrackerMeta | null> => {
      if (!containerUrl) return null;
      return (await readTrackerMeta(containerUrl)) ?? null;
    },
    [containerUrl],
  );

  // Per-container key (implicitly storage-scoped via the container). No container
  // yet → empty key (no fetch). Watch the tracker DOC so a config change refreshes.
  const key = containerUrl ? trackerKey(containerUrl) : "";
  const { data, error, loading, revalidating, reload } = useSwrRead<TrackerMeta | null>(
    key,
    fetcher,
    { topicUrl: containerUrl ? trackerDocUrl(containerUrl) : undefined },
  );

  return { data, error, loading, revalidating, reload };
}
