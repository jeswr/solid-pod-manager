// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Inbox hook — binds the user's OWN LDN inbox to the active session, lists the
 * notifications, and exposes mark-read / dismiss. Production paths pass NO
 * `fetch` (the auth-patched global runs). Re-lists on login / storage switch and
 * on live notifications (wired by the page via `useResourceNotifications`).
 */
import { useCallback, useEffect, useState } from "react";
import { useSession } from "@/components/session-provider";
import { Inbox, inboxFor, type InboxNotification } from "@/lib/inbox";
import type { AsyncState } from "@/components/use-pod-data";

export interface UseInbox extends AsyncState<InboxNotification[]> {
  /** The discovered inbox container URL (for live-update subscription). */
  inboxUrl?: string;
  reload: () => void;
  markRead: (url: string) => Promise<void>;
  dismiss: (url: string) => Promise<void>;
}

export function useInbox(): UseInbox {
  const { webId, activeStorage, status } = useSession();
  const [state, setState] = useState<AsyncState<InboxNotification[]>>({ loading: true });
  const [inbox, setInbox] = useState<Inbox | undefined>(undefined);
  const [inboxUrl, setInboxUrl] = useState<string | undefined>(undefined);
  /** Has discovery settled? Distinguishes "still discovering" from "no inbox". */
  const [discovered, setDiscovered] = useState(false);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // Discovery: derive the inbox only when the session changes — NOT on reload,
  // so a mark-read / dismiss / live-notification does not re-fetch the profile.
  useEffect(() => {
    if (status !== "logged-in" || !webId || !activeStorage) {
      setInbox(undefined);
      setInboxUrl(undefined);
      setDiscovered(false);
      setState({ loading: true });
      return;
    }
    let cancelled = false;
    setDiscovered(false);
    setState({ loading: true }); // avoid showing the previous pod's inbox during a switch
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

  // Listing: re-list whenever the discovered inbox changes or `reload` fires.
  useEffect(() => {
    if (status !== "logged-in" || !webId || !activeStorage) return;
    if (!discovered) return; // wait for discovery to settle before deciding
    if (!inbox) {
      // Discovery settled with no inbox advertised → genuinely empty.
      setState({ loading: false, data: [] });
      return;
    }
    let cancelled = false;
    setState({ loading: true });
    inbox
      .list()
      .then((items) => {
        if (!cancelled) setState({ loading: false, data: items });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState({ loading: false, error: e instanceof Error ? e : new Error(String(e)) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [inbox, discovered, status, webId, activeStorage, nonce]);

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

  return { ...state, inboxUrl, reload, markRead, dismiss };
}
