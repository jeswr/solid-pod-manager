"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSession } from "@/components/session-provider";
import {
  type ProductivityStore,
  type StoredItem,
} from "@/lib/productivity-store";
import type { AdvisoryHandler } from "@/lib/shacl/advisory";
import type { AsyncState } from "@/components/use-pod-data";

/**
 * The default advisory-validation surface (ADR-0014 Phase 1): a non-blocking
 * sonner warning toast. A write that fails SHACL validation still succeeds —
 * this only informs the user the saved data may not be fully interoperable.
 */
const advisoryToast: AdvisoryHandler = (notice) => {
  const n = notice.results.length;
  toast.warning(
    `Saved, but this data may not be fully interoperable (${n} shape ${n === 1 ? "issue" : "issues"}).`,
    {
      description:
        notice.results
          .map((r) => r.message || r.path)
          .filter(Boolean)
          .slice(0, 3)
          .join("; ") || undefined,
    },
  );
};

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
  factory: (opts: {
    podRoot: string;
    webId: string;
    onAdvisory?: AdvisoryHandler;
  }) => ProductivityStore<T>,
): ProductivityStore<T> | undefined {
  const { webId, activeStorage, status } = useSession();
  return useMemo(() => {
    if (status !== "logged-in" || !webId || !activeStorage) return undefined;
    // Supply the advisory-toast surface to every store. Stores that haven't
    // opted into validation (`cfg.validate` unset) simply never call it
    // (ADR-0014 Phase 1) — it is the no-op default for them.
    return factory({ podRoot: activeStorage, webId, onAdvisory: advisoryToast });
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
