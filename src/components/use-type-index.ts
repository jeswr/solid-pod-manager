// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "@/components/session-provider";
import { freshRdf } from "@/lib/rdf-read";
import { profileDocUrl } from "@/lib/profile-edit";
import {
  listAllRegistrations,
  type ManagedTypeIndex,
} from "@/lib/type-index-manage";
import type { AsyncState } from "@/components/use-pod-data";

/**
 * Load the signed-in user's full type-index management view (public + private
 * registrations). Production paths pass NO `fetch` (auth-patched global runs).
 * Re-loads on login + on demand (`reload`).
 */
export function useTypeIndex(): AsyncState<ManagedTypeIndex> & { reload: () => void } {
  const { webId, status } = useSession();
  const [state, setState] = useState<AsyncState<ManagedTypeIndex>>({ loading: true });
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
      const view = await listAllRegistrations(webId, dataset);
      if (!cancelled) setState({ loading: false, data: view });
    })().catch((e: unknown) => {
      if (!cancelled) {
        setState({ loading: false, error: e instanceof Error ? e : new Error(String(e)) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [webId, status, nonce]);

  return { ...state, reload };
}
