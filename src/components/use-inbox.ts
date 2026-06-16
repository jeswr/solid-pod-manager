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
 * SECURITY: the cache is render-only. `markRead`/`dismiss` act on the live
 * `inbox` handle (a fresh server write), then `reload()` to revalidate — they
 * never mutate the cached snapshot directly.
 */
import { useCallback, useEffect, useState } from "react";
import { useSession } from "@/components/session-provider";
import { useSwrRead } from "@/components/use-swr-read";
import { Inbox, inboxFor, type InboxNotification } from "@/lib/inbox";
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
  const [inbox, setInbox] = useState<Inbox | undefined>(undefined);
  const [inboxUrl, setInboxUrl] = useState<string | undefined>(undefined);
  /** Has discovery settled? Distinguishes "still discovering" from "no inbox". */
  const [discovered, setDiscovered] = useState(false);

  // Discovery: derive the inbox only when the session changes — NOT on reload,
  // so a mark-read / dismiss / live-notification does not re-fetch the profile.
  useEffect(() => {
    if (status !== "logged-in" || !webId || !activeStorage) {
      setInbox(undefined);
      setInboxUrl(undefined);
      setDiscovered(false);
      return;
    }
    let cancelled = false;
    setDiscovered(false);
    (async () => {
      const box = await inboxFor({ webId, activeStorage });
      if (cancelled) return;
      setInbox(box);
      setInboxUrl(box?.inboxUrl);
      setDiscovered(true);
    })().catch(() => {
      if (!cancelled) {
        setInbox(undefined);
        setInboxUrl(undefined);
        setDiscovered(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [webId, activeStorage, status]);

  // Listing: read through the SWR cache, keyed per WebID under `inbox`. The
  // fetcher waits until discovery has settled — before that, an empty key keeps
  // the loading state and touches no cache (so a switch never lists a stale
  // pod's inbox). Once discovered with no inbox, resolve to an empty list.
  const ready = status === "logged-in" && Boolean(webId) && Boolean(activeStorage) && discovered;
  // Key per discovered inbox URL once discovery settles. The inbox is
  // active-storage-dependent, so the key carries the discovered URL → a storage
  // switch (different discovered inbox) changes the key and revalidates against
  // the new storage rather than painting the previous one. When discovery
  // settles with NO inbox, fall back to a storage-scoped sentinel so the
  // empty-list result still caches/paints without colliding across storages.
  const key = ready ? (inboxUrl ? `inbox:${inboxUrl}` : `inbox:none:${activeStorage}`) : "";
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
