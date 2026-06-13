// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "@/components/session-provider";
import { freshRdf } from "@/lib/rdf-read";
import { profileDocUrl } from "@/lib/profile-edit";
import { readKnows, addFriend, removeFriend } from "@/lib/social";
import type { AsyncState } from "@/components/use-pod-data";

/**
 * Manage the signed-in user's `foaf:knows` friend list. Reads the card,
 * exposes `add`/`remove` (read-modify-write on the card), and keeps local
 * state in step with the server's authoritative result. Production paths pass
 * NO `fetch` (auth-patched global runs).
 */
export function useFriends(): AsyncState<string[]> & {
  reload: () => void;
  add: (webId: string) => Promise<void>;
  remove: (webId: string) => Promise<void>;
} {
  const { webId, status } = useSession();
  const [state, setState] = useState<AsyncState<string[]>>({ loading: true });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (status !== "logged-in" || !webId) {
      setState({ loading: true });
      return;
    }
    let cancelled = false;
    setState({ loading: true });
    (async () => {
      const { dataset } = await freshRdf(profileDocUrl(webId));
      if (!cancelled) setState({ loading: false, data: readKnows(webId, dataset) });
    })().catch((e: unknown) => {
      if (!cancelled) {
        setState({ loading: false, error: e instanceof Error ? e : new Error(String(e)) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [webId, status, nonce]);

  const add = useCallback(
    async (friend: string) => {
      if (!webId) return;
      const next = await addFriend({ webId, friend });
      setState({ loading: false, data: next });
    },
    [webId],
  );

  const remove = useCallback(
    async (friend: string) => {
      if (!webId) return;
      const next = await removeFriend({ webId, friend });
      setState({ loading: false, data: next });
    },
    [webId],
  );

  return { ...state, reload, add, remove };
}
