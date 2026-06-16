// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

import { useCallback, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { useSession } from "@/components/session-provider";
import { useSwrRead } from "@/components/use-swr-read";
import { useAppPrefs } from "@/components/use-app-prefs";
import { memoryReadCache } from "@/lib/swr-cache";
import type { RevalidatableState } from "@/components/use-pod-data";
import { fetchCommunityFeed, type FeedResult } from "@/lib/community-feeds";
import {
  clearCommunityCredentialsIfOwnerChanged,
  hasMatrixCredential,
} from "@/lib/community-credentials";
import {
  type CommunityPrefs,
  markThreadRead,
} from "@/lib/community-prefs";

/**
 * `useCommunityPrefs` — the user's channel subscriptions + read markers, now
 * POD-BACKED (task #89, G2/P0). This is a thin Community-view-shaped facade over
 * {@link useAppPrefs}: the pod is AUTHORITATIVE; localStorage is only the
 * SWR-durable instant-paint MIRROR. The Community page's contract is unchanged
 * (`prefs` / `loaded` / `setPrefs` / `markRead`), so it consumes this with no
 * edits. Mutations are OPTIMISTIC + non-blocking (paint now, persist async,
 * revert + toast on failure) with a "Saving…" indicator surfaced via `sonner`.
 */
export function useCommunityPrefs(): {
  prefs: CommunityPrefs;
  /**
   * True once prefs have been loaded for the active WebID (cached or fresh).
   * Until then the feed must NOT fetch — the initial `prefs` is the unsaved
   * DEFAULT, and firing the feed off it would make external requests for the
   * default channels even though the user may have removed/disabled them
   * (roborev finding, Medium). With the SWR mirror, a warm cache makes this true
   * on the FIRST paint; a cold first-ever load resolves it once the pod read
   * settles (returning the stored prefs, or the defaults when none are stored).
   */
  loaded: boolean;
  /** Persist a new prefs object (optimistic + non-blocking). */
  setPrefs: (next: CommunityPrefs) => void;
  /** Mark a thread read at `position` (numeric string), persisting it. */
  markRead: (threadId: string, position: string) => void;
} {
  const { webId } = useSession();

  // A successful write toasts "Saved"; a failure reverts + toasts the error.
  const app = useAppPrefs({
    onError: (e) => toast.error(`Couldn't save your community settings: ${e.message}`),
  });

  const prefs = app.prefs.community;
  // Loaded once a value (cached or fresh) is in hand for this account.
  const loaded = !app.loading && webId != null;

  // Drop the previous account's in-memory Matrix token on a real account switch
  // (module-level owner check; a same-WebID remount is a no-op). Preserved from
  // the pre-pod implementation so a logout/switch still disconnects Matrix.
  useEffect(() => {
    clearCommunityCredentialsIfOwnerChanged(webId);
  }, [webId]);

  const setCommunity = app.setCommunity;

  const setPrefs = useCallback(
    (next: CommunityPrefs) => {
      setCommunity(next);
    },
    [setCommunity],
  );

  const markRead = useCallback(
    (threadId: string, position: string) => {
      // FUNCTIONAL updater computed from the LIVE prefs (the cache value inside
      // setCommunity), NOT stale React state — so two read-marks fired before a
      // re-render compose instead of overwriting each other (roborev Medium).
      // `markThreadRead` returns the SAME object for a non-advancing mark, so a
      // stale re-mark is a no-op and never churns the pod.
      setCommunity((prev) => markThreadRead(prev, threadId, position));
    },
    [setCommunity],
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
 * Evict EVERY cached community-feed slot for `webId` from the memory-only cache.
 *
 * Call this whenever the Matrix connection changes for the SAME WebID (connect,
 * disconnect, or replacing the token) — NOT just on account switch/logout. The
 * feed key folds `matrixConnected` (`community:m:…` vs `community:_:…`), so a
 * disconnect already stops the connected slot from being SERVED; but the entry
 * with the private Matrix content would otherwise LINGER in memory and be reused
 * on a later reconnect with the same rooms (roborev finding, Medium). Dropping
 * the whole partition guarantees private chat content does not survive a
 * disconnect in memory and that a reconnect always re-fetches fresh, never
 * serving pre-disconnect content.
 *
 * `invalidate` (not `clearWebId`) drops the keyed entries AND notifies any
 * mounted `useCommunityFeed`, so the page revalidates rather than showing stale
 * content; without a `webId` (logged out) there is nothing to clear.
 */
export function clearCommunityFeedCache(webId: string | undefined): void {
  if (!webId) return;
  // Drop both credential-state slots ("m" connected / "_" disconnected) plus
  // any in-flight ones; clearWebId removes the whole WebID partition in memory
  // and notifies subscribers, which is exactly the "forget this account's feed"
  // semantics we want on a credential change.
  memoryReadCache.clearWebId(webId);
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
 * PRIVACY — MEMORY-ONLY CACHE: the feed `FeedResult` interleaves PRIVATE Matrix
 * room messages with the public forum, so it is cached through the MEMORY-ONLY
 * {@link memoryReadCache} (a `SwrCache` constructed with no durable store), NOT
 * the default durable {@link readCache}. This keeps the instant-nav SWR UX
 * (cross-mount in-memory sharing + background revalidate) while guaranteeing
 * private Matrix message bodies are NEVER written to `localStorage` — so they
 * cannot persist to disk past the session or be read off disk later (roborev
 * finding, HIGH). The memory cache is wiped on logout / account switch by the
 * session bridge, like every other per-WebID slot.
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
  // MEMORY-ONLY cache (no durable/localStorage snapshot) so PRIVATE Matrix
  // message bodies in the FeedResult are never persisted to disk (roborev HIGH).
  const { data, error, loading, revalidating, reload } = useSwrRead<FeedResult>(key, fetcher, {
    cache: memoryReadCache,
  });
  return { data, error, loading, revalidating, reload };
}
