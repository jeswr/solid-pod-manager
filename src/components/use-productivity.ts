"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "@/components/session-provider";
import {
  type ProductivityStore,
  type StoredItem,
} from "@/lib/productivity-store";
import type { AsyncState } from "@/components/use-pod-data";

/**
 * Bind a productivity store (Notes / Calendar / Contacts) to the active Solid
 * session. Returns `undefined` until the user is logged in with a chosen
 * storage. Production paths pass NO `fetch` to the store — the auth-patched
 * global runs (AGENTS.md §Reading data).
 *
 * @param factory - the app's store constructor (`notesStore` / …). Memoised on
 *   identity; pass a module-level function reference.
 */
export function useStore<T>(
  factory: (opts: { podRoot: string; webId: string }) => ProductivityStore<T>,
): ProductivityStore<T> | undefined {
  const { webId, activeStorage, status } = useSession();
  return useMemo(() => {
    if (status !== "logged-in" || !webId || !activeStorage) return undefined;
    return factory({ podRoot: activeStorage, webId });
  }, [factory, webId, activeStorage, status]);
}

/**
 * List items from a store, with loading / empty / error state and a `reload`.
 * Re-lists whenever the bound store changes (login / storage switch).
 */
export function useItems<T>(
  store: ProductivityStore<T> | undefined,
): AsyncState<StoredItem<T>[]> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<StoredItem<T>[]>>({ loading: true });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!store) {
      setState({ loading: true });
      return;
    }
    let cancelled = false;
    setState({ loading: true });
    store
      .list()
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
  }, [store, nonce]);

  return { ...state, reload };
}

/**
 * Read a single item by URL from a store. Used by the detail/edit views.
 */
export function useItem<T>(
  store: ProductivityStore<T> | undefined,
  url: string | undefined,
): AsyncState<StoredItem<T> | undefined> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<StoredItem<T> | undefined>>({
    loading: true,
  });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!store || !url) {
      setState({ loading: true });
      return;
    }
    let cancelled = false;
    setState({ loading: true });
    store
      .read(url)
      .then((item) => {
        if (!cancelled) setState({ loading: false, data: item });
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
  }, [store, url, nonce]);

  return { ...state, reload };
}
