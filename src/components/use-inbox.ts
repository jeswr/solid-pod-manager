// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Inbox hook — binds the user's OWN LDN inbox to the active session, lists the
 * notifications, and exposes mark-read / dismiss. Production paths pass NO
 * `fetch` (the auth-patched global runs).
 *
 * Stale-while-revalidate: the LISTING goes through the shared {@link useSwrRead}
 * cache, keyed PER DISCOVERED INBOX URL (`inbox:<inboxUrl>`), so navigating back
 * to the inbox paints the last-known notifications INSTANTLY and revalidates in
 * the background; the discovered inbox container is watched so a new
 * notification invalidates + refreshes it. The inbox container is
 * active-storage-dependent (a different storage discovers a different inbox), so
 * the key MUST carry the discovered URL — keying it the static `inbox` would
 * keep the same `(webId, key)` across a SAME-WebID storage switch and paint the
 * previous storage's inbox (roborev finding). The key stays EMPTY until
 * discovery settles, so it never hydrates the wrong storage's slot.
 * Inbox DISCOVERY (which container) stays a cheap effect off the session — it
 * runs once per login/storage switch, NOT on every reload, so a mark-read /
 * dismiss / live-notification never re-fetches the profile.
 *
 * Discovery runs in an effect AFTER paint, so on a storage switch the discovery
 * state (`inbox`/`inboxUrl`/`discovered`) still describes the PREVIOUS storage
 * for the render before the effect re-runs. To stop that previous storage's
 * inbox flashing for one render, discovery is a SINGLE object TAGGED with the
 * storage it ran for ({@link InboxDiscovery}); the listing treats it as ready
 * (and derives the `inbox:<inboxUrl>` key) only when `discovery.storage` equals
 * the CURRENT `activeStorage` — otherwise the key is empty (cold) until
 * discovery for the new storage settles (roborev finding).
 *
 * SECURITY: the cache is render-only. `markRead`/`dismiss` act on the live
 * `inbox` handle (a fresh server write), then `reload()` to revalidate — they
 * never mutate the cached snapshot directly.
 */
import { useCallback, useEffect, useState } from "react";
import { useSession } from "@/components/session-provider";
import { useSwrRead } from "@/components/use-swr-read";
import { inboxFor, type InboxNotification } from "@/lib/inbox";
import {
  type InboxDiscovery,
  NO_DISCOVERY,
  inboxCacheKey,
  inboxDiscoveryReady,
} from "@/lib/inbox-discovery";
import type { RevalidatableState } from "@/components/use-pod-data";

export interface UseInbox extends RevalidatableState<InboxNotification[]> {
  /** The discovered inbox container URL (for live-update subscription). */
  inboxUrl?: string;
  reload: () => void;
  markRead: (url: string) => Promise<void>;
  dismiss: (url: string) => Promise<void>;
}

export function useInbox(): UseInbox {
  const { webId, activeStorage, status } = useSession();
  // Discovery state as a SINGLE object tagged with the storage it ran for, so a
  // storage switch cannot leave a stale `inboxUrl` that the render trusts before
  // the discovery effect re-runs (the one-render flash roborev flagged).
  const [discovery, setDiscovery] = useState<InboxDiscovery>(NO_DISCOVERY);

  // Discovery: derive the inbox only when the session changes — NOT on reload,
  // so a mark-read / dismiss / live-notification does not re-fetch the profile.
  useEffect(() => {
    if (status !== "logged-in" || !webId || !activeStorage) {
      setDiscovery(NO_DISCOVERY);
      return;
    }
    let cancelled = false;
    // Mark "discovering for THIS storage" immediately: until it settles, the
    // render derives an empty key (cold), so the previous storage's inbox is
    // not painted while discovery for the new storage is in flight.
    setDiscovery({ storage: activeStorage, discovered: false });
    (async () => {
      const box = await inboxFor({ webId, activeStorage });
      if (cancelled) return;
      setDiscovery({ storage: activeStorage, inbox: box, inboxUrl: box?.inboxUrl, discovered: true });
    })().catch(() => {
      if (!cancelled) {
        setDiscovery({ storage: activeStorage, discovered: true });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [webId, activeStorage, status]);

  // Listing: read through the SWR cache. The key is EMPTY (cold, no cache touch)
  // until discovery has settled FOR THE CURRENT STORAGE — so a storage switch
  // never lists (or paints) the previous pod's inbox, even for one render.
  const inbox = inboxDiscoveryReady(discovery, status, webId, activeStorage)
    ? discovery.inbox
    : undefined;
  // The discovered URL to WATCH for live updates — only once it belongs to the
  // current storage, so we never subscribe to the previous storage's container.
  const inboxUrl = inboxDiscoveryReady(discovery, status, webId, activeStorage)
    ? discovery.inboxUrl
    : undefined;
  const key = inboxCacheKey(discovery, status, webId, activeStorage);
  const fetcher = useCallback(async (): Promise<InboxNotification[]> => {
    return inbox ? inbox.list() : [];
  }, [inbox]);

  const { data, error, loading, revalidating, reload } = useSwrRead<InboxNotification[]>(
    key,
    fetcher,
    // Watch the discovered inbox container so a new notification refreshes it.
    { topicUrl: inboxUrl },
  );

  const markRead = useCallback(
    async (url: string) => {
      if (inbox) {
        await inbox.markRead(url);
        reload();
      }
    },
    [inbox, reload],
  );

  const dismiss = useCallback(
    async (url: string) => {
      if (inbox) {
        await inbox.dismiss(url);
        reload();
      }
    },
    [inbox, reload],
  );

  return { data, error, loading, revalidating, inboxUrl, reload, markRead, dismiss };
}
