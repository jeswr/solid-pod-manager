// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

import { useCallback, useMemo } from "react";
import { useSession } from "@/components/session-provider";
import { useSwrRead } from "@/components/use-swr-read";
import { isInOwnPods } from "@/lib/pod-scope";
import { asContainerUrl, listFolder, type PodItem } from "@/lib/files";
import type { RevalidatableState } from "@/components/use-pod-data";

/**
 * The active storage root the files browser is scoped to, plus a guard the UI
 * uses before opening any path-addressed URL.
 *
 * Returns `undefined` storage until the user is logged in with a chosen pod.
 */
export function useFilesScope(): {
  root?: string;
  storages: readonly string[];
  /** SEC-1: only ever open/fetch URLs inside one of the user's own pods. */
  inScope(url: string): boolean;
} {
  const { profile, activeStorage, status } = useSession();
  // Stabilise the storages array identity so the `inScope` callback (and its
  // consumers' effects) don't re-create on every render.
  const storages = useMemo(() => profile?.storages ?? [], [profile?.storages]);
  const root =
    status === "logged-in" && activeStorage ? asContainerUrl(activeStorage) : undefined;
  const inScope = useCallback(
    (url: string) => isInOwnPods(url, storages),
    [storages],
  );
  return { root, storages, inScope };
}

/**
 * List a single container's children, with loading / empty / error state, a
 * manual `reload`, and live invalidation via Solid notifications (best-effort —
 * a server without notifications just keeps fetch-on-mount + reload).
 *
 * Stale-while-revalidate (PM home/files-slowness fix): the listing goes through
 * the shared {@link useSwrRead} cache keyed PER CONTAINER (`files:<container>`),
 * so navigating back into the files browser — or re-opening a folder you have
 * already viewed, or a cold open / app reopen (the durable snapshot) — paints
 * the last-seen listing for THAT container INSTANTLY and revalidates in the
 * background, instead of re-running `listFolder` behind a spinner every time.
 * The container is the cache key AND the notification topic, so opening a
 * different folder reads its own slot (no cross-folder flash) and a change to
 * the container invalidates + refreshes its entry. Production paths pass NO
 * `fetch` to the data layer — the auth-patched global runs (AGENTS.md §Reading
 * data).
 */
export function useFolder(
  container: string | undefined,
): RevalidatableState<PodItem[]> & { reload: () => void } {
  // Per-container key; empty key (no container yet) is a no-op in useSwrRead and
  // reports the loading state, matching the previous "no container → loading"
  // behaviour exactly. The WebID partition is added by useSwrRead.
  const key = container ? `files:${container}` : "";
  const fetcher = useCallback(
    // Only invoked when the key is non-empty (a container is set), so `container`
    // is defined here; assert it for the type without changing behaviour.
    () => listFolder(container as string),
    [container],
  );
  const { data, error, loading, revalidating, reload } = useSwrRead<PodItem[]>(
    key,
    fetcher,
    // Watch the container so an edit/add/delete there invalidates + refreshes.
    { topicUrl: container },
  );
  return useMemo(
    () => ({ data, error, loading, revalidating, reload }),
    [data, error, loading, revalidating, reload],
  );
}
