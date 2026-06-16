// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

import { useCallback } from "react";
import { useSession } from "@/components/session-provider";
import { useSwrRead } from "@/components/use-swr-read";
import { freshRdf } from "@/lib/rdf-read";
import { profileDocUrl } from "@/lib/profile-edit";
import { readKnows, addFriend, removeFriend } from "@/lib/social";
import { readCache } from "@/lib/swr-cache";
import type { RevalidatableState } from "@/components/use-pod-data";

/** The WebID-partitioned SWR cache key for the friend list. */
const FRIENDS_KEY = "friends";

/**
 * Manage the signed-in user's `foaf:knows` friend list. Reads the card,
 * exposes `add`/`remove` (read-modify-write on the card), and keeps local
 * state in step with the server's authoritative result. Production paths pass
 * NO `fetch` (auth-patched global runs).
 *
 * Stale-while-revalidate: the read goes through the shared {@link useSwrRead}
 * cache (keyed {@link FRIENDS_KEY}), so navigating back to the page paints the
 * last-known friend list INSTANTLY and revalidates in the background; the
 * profile doc is watched so an edit elsewhere invalidates + refreshes it.
 *
 * SECURITY: the cache is render-only. `add`/`remove` do NOT act on the cached
 * snapshot — they call `addFriend`/`removeFriend`, which read-modify-write the
 * card FRESH on the server and return the AUTHORITATIVE next list; we then push
 * that authoritative result into the cache so the view reflects it at once.
 */
export function useFriends(): RevalidatableState<string[]> & {
  reload: () => void;
  add: (webId: string) => Promise<void>;
  remove: (webId: string) => Promise<void>;
} {
  const { webId } = useSession();

  const { data, error, loading, revalidating, reload } = useSwrRead<string[]>(
    FRIENDS_KEY,
    async (id) => {
      const { dataset } = await freshRdf(profileDocUrl(id));
      return readKnows(id, dataset);
    },
    // Watch the profile doc so a friend change elsewhere invalidates + refreshes.
    { topicUrl: webId ? profileDocUrl(webId) : undefined },
  );

  const add = useCallback(
    async (friend: string) => {
      if (!webId) return;
      // Authoritative read-modify-write on the server; the returned list is the
      // fresh source of truth. Push it into the cache so the view updates now.
      const next = await addFriend({ webId, friend });
      readCache.set(webId, FRIENDS_KEY, next);
    },
    [webId],
  );

  const remove = useCallback(
    async (friend: string) => {
      if (!webId) return;
      const next = await removeFriend({ webId, friend });
      readCache.set(webId, FRIENDS_KEY, next);
    },
    [webId],
  );

  return { data, error, loading, revalidating, reload, add, remove };
}
