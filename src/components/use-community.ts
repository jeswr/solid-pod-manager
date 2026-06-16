// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "@/components/session-provider";
import { useSwrRead } from "@/components/use-swr-read";
import type { RevalidatableState } from "@/components/use-pod-data";
import { fetchCommunityFeed, type FeedResult } from "@/lib/community-feeds";
import {
  clearCommunityCredentialsIfOwnerChanged,
  hasMatrixCredential,
} from "@/lib/community-credentials";
import {
  browserPrefsStorage,
  type CommunityPrefs,
  defaultCommunityPrefs,
  loadCommunityPrefs,
  markThreadRead,
  saveCommunityPrefs,
} from "@/lib/community-prefs";

/**
 * `useCommunityPrefs` — the user's persisted channel subscriptions + read
 * markers. Loaded from (per-WebID) localStorage on mount, persisted on every
 * change. INTERIM storage (see `community-prefs.ts`); the pod is the eventual
 * home. Mutations are immutable updates so React state stays sound.
 */
export function useCommunityPrefs(): {
  prefs: CommunityPrefs;
  /**
   * True once prefs have been loaded from storage for the active WebID. Until
   * then the feed must NOT fetch — the initial `prefs` is the unsaved DEFAULT,
   * and firing the feed off it would make external requests for the default
   * channels even though the user may have removed/disabled them (roborev
   * finding, Medium).
   */
  loaded: boolean;
  /** Persist a new prefs object. */
  setPrefs: (next: CommunityPrefs) => void;
  /** Mark a thread read at `position` (numeric string), persisting it. */
  markRead: (threadId: string, position: string) => void;
} {
  const { webId } = useSession();
  // Lazy SYNCHRONOUS init: when the WebID is already known on first render
  // (the common case — the shell renders /community only inside a session),
  // seed prefs from storage immediately so the feed never fetches off defaults.
  const [state, setState] = useState<{ prefs: CommunityPrefs; loadedFor: string | null }>(() =>
    webId
      ? { prefs: loadCommunityPrefs(webId, browserPrefsStorage()), loadedFor: webId }
      : { prefs: defaultCommunityPrefs(), loadedFor: null },
  );
  const prefs = state.prefs;
  const loaded = state.loadedFor === (webId ?? null) && webId != null;

  // (Re)load this WebID's prefs when the WebID becomes known or changes (account
  // switch). Credential carry-over is guarded by the MODULE-level owner check
  // (NOT a component ref, which re-inits to undefined on every mount and would
  // falsely disconnect Matrix on each remount): a same-WebID remount is a no-op;
  // a real account switch (or logout) drops the previous account's token.
  useEffect(() => {
    clearCommunityCredentialsIfOwnerChanged(webId);
    if (!webId) {
      setState({ prefs: defaultCommunityPrefs(), loadedFor: null });
      return;
    }
    setState({ prefs: loadCommunityPrefs(webId, browserPrefsStorage()), loadedFor: webId });
  }, [webId]);

  const setPrefsState = useCallback(
    (updater: CommunityPrefs | ((prev: CommunityPrefs) => CommunityPrefs)) => {
      setState((s) => ({
        ...s,
        prefs: typeof updater === "function" ? updater(s.prefs) : updater,
      }));
    },
    [],
  );

  const setPrefs = useCallback(
    (next: CommunityPrefs) => {
      setPrefsState(next);
      if (webId) saveCommunityPrefs(webId, next, browserPrefsStorage());
    },
    [webId, setPrefsState],
  );

  const markRead = useCallback(
    (threadId: string, position: string) => {
      setPrefsState((prev) => {
        const next = markThreadRead(prev, threadId, position);
        if (next !== prev && webId) saveCommunityPrefs(webId, next, browserPrefsStorage());
        return next;
      });
    },
    [webId, setPrefsState],
  );

  return { prefs, loaded, setPrefs, markRead };
}

/**
 * A stable cache key for a prefs snapshot — the subscription set + read-marker,
 * plus a Matrix-connected flag. Keying on the marker means marking a thread read
 * revalidates the feed so its unread badge clears without a manual reload;
 * keying on the subscription set means adding/removing a channel refetches; and
 * keying on `matrixConnected` means connecting OR disconnecting Matrix
 * revalidates rather than serving a cached feed from the other credential state
 * (so a disconnect cannot keep showing the previous Matrix room content). The
 * WebID is NOT mixed in here — `useSwrRead` already partitions every key per
 * active WebID, so two accounts never share a slot. Kept compact + deterministic.
 */
function prefsKey(prefs: CommunityPrefs, matrixConnected: boolean): string {
  const rooms = [...prefs.matrixRooms].sort().join(",");
  const topics = [...prefs.discourseTopicIds].sort((a, b) => a - b).join(",");
  const marks = Object.entries(prefs.readMarker)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(";");
  return `community:${matrixConnected ? "m" : "_"}:${prefs.includeDiscourseLatest ? 1 : 0}:${rooms}:${topics}:${marks}`;
}

/**
 * `useCommunityFeed` — load the unified community feed (Solid forum + Matrix
 * rooms) for the given prefs, with stale-while-revalidate so navigating back to
 * the Community page paints the last feed INSTANTLY and refreshes in the
 * background (the instant-nav SWR pattern). Keyed by the prefs snapshot, so a
 * subscription/read-marker change revalidates.
 *
 * Forum read works WITHOUT credentials (out of the box); Matrix rooms only
 * appear once a Matrix token is connected. The fetcher uses the pristine native
 * `fetch` (public hosts, not the pod — see `community-feeds.ts`).
 *
 * @param loaded - pass `useCommunityPrefs().loaded`. While `false` the feed does
 *   NOT fetch (empty key), so it never fires external requests off the UNSAVED
 *   default prefs before the user's saved subscriptions have loaded (roborev
 *   finding, Medium). Once `true`, `prefs` reflects the persisted selection.
 */
export function useCommunityFeed(
  prefs: CommunityPrefs,
  loaded: boolean,
): RevalidatableState<FeedResult> & { reload: () => void } {
  // The connected-Matrix state participates in the key so connect/disconnect
  // revalidates (and never serves the other state's cached feed). Read at render
  // — a connect/disconnect triggers a re-render (toast + reload), so the key
  // follows the live credential state.
  const matrixConnected = hasMatrixCredential();
  // An empty key short-circuits useSwrRead (no fetch, loading state) until the
  // saved prefs are in — so the feed never goes out for the default channels.
  const key = useMemo(
    () => (loaded ? prefsKey(prefs, matrixConnected) : ""),
    [prefs, matrixConnected, loaded],
  );
  // Capture the current prefs for the fetcher without making the closure
  // identity a fetch trigger (the key already encodes prefs changes).
  const fetcher = useCallback((): Promise<FeedResult> => fetchCommunityFeed(prefs), [prefs]);
  const { data, error, loading, revalidating, reload } = useSwrRead<FeedResult>(key, fetcher);
  return { data, error, loading, revalidating, reload };
}
