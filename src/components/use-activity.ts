"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "@/components/session-provider";
import { useCategorySummaries } from "@/components/use-pod-data";
import { listCategoryItems } from "@/lib/pod-data";
import { buildRecentChanges, type ActivityEntry, type CategoryItems } from "@/lib/activity";
import type { AsyncState } from "@/components/use-pod-data";

/**
 * The "recently changed in your pod" feed: discover categories, list each one
 * that has data, then flatten to the newest-first entries. Production paths pass
 * NO `fetch` (auth-patched global runs). Re-runs when the active WebID changes.
 *
 * @param limit - max entries to return (Home shows a few, Activity shows more).
 */
export function useRecentActivity(limit = 8): AsyncState<ActivityEntry[]> & {
  reload: () => void;
} {
  const { status } = useSession();
  const summaries = useCategorySummaries();
  const [state, setState] = useState<AsyncState<ActivityEntry[]>>({ loading: true });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (status !== "logged-in") return;
    if (summaries.loading) {
      setState({ loading: true });
      return;
    }
    if (summaries.error) {
      setState({ loading: false, error: summaries.error });
      return;
    }
    const withData = (summaries.data ?? []).filter((s) => s.hasData);
    if (withData.length === 0) {
      setState({ loading: false, data: [] });
      return;
    }

    let cancelled = false;
    setState({ loading: true });
    (async () => {
      // List each category that has data. A single failing container must not
      // sink the whole feed — settle and keep what we could read.
      const settled = await Promise.allSettled(
        withData.map(async (s): Promise<CategoryItems> => ({
          category: s.category,
          items: await listCategoryItems(s),
        })),
      );
      const perCategory = settled
        .filter((r): r is PromiseFulfilledResult<CategoryItems> => r.status === "fulfilled")
        .map((r) => r.value);
      if (!cancelled) {
        setState({ loading: false, data: buildRecentChanges(perCategory, limit) });
      }
    })().catch((e: unknown) => {
      if (!cancelled) {
        setState({ loading: false, error: e instanceof Error ? e : new Error(String(e)) });
      }
    });

    return () => {
      cancelled = true;
    };
    // summaries.data identity changes each load; gate on its serialised shape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, summaries.loading, summaries.error, nonce, limit]);

  return { ...state, reload };
}
