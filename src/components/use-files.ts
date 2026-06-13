// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "@/components/session-provider";
import { useResourceNotifications } from "@/components/use-resource-notifications";
import { isInOwnPods } from "@/lib/pod-scope";
import { asContainerUrl, listFolder, type PodItem } from "@/lib/files";
import type { AsyncState } from "@/components/use-pod-data";

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
 * Production paths pass NO `fetch` to the data layer — the auth-patched global
 * runs (AGENTS.md §Reading data). Re-lists whenever the container or session
 * changes.
 */
export function useFolder(
  container: string | undefined,
): AsyncState<PodItem[]> & { reload: () => void } {
  const { status } = useSession();
  const [state, setState] = useState<AsyncState<PodItem[]>>({ loading: true });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (status !== "logged-in" || !container) {
      setState({ loading: true });
      return;
    }
    let cancelled = false;
    setState({ loading: true });
    listFolder(container)
      .then((items) => {
        if (!cancelled) setState({ loading: false, data: items });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState({
            loading: false,
            error: e instanceof Error ? e : new Error(String(e)),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [container, status, nonce]);

  // Live-refresh the listing when the container changes on the server.
  useResourceNotifications(
    status === "logged-in" ? container : undefined,
    reload,
  );

  return useMemo(() => ({ ...state, reload }), [state, reload]);
}
