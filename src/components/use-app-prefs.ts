// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * `useAppPrefs` (task #89, G2/P0) — Pod Manager's own UI/UX preferences
 * (Community channels + per-thread read markers, theme, a generic small
 * key→value escape hatch), POD-BACKED so they follow the user across
 * devices/browsers and survive a cache clear.
 *
 * INSTANT-NAV SWR + localStorage MIRROR. The model is read through
 * {@link useSwrRead} over the shared {@link SwrCache}/durable cache: the FIRST
 * paint is synchronous from the durable snapshot (the localStorage MIRROR — see
 * the `app-prefs:` durable codec), then a background revalidation re-reads the
 * pod (the AUTHORITATIVE store). So the pod is the source of truth and
 * localStorage is purely the instant-paint cache (#89's "localStorage as mirror"
 * design).
 *
 *   - KEY: `app-prefs:<activeStorage>`. The prefs FILE is per-WebID (discovered
 *     off the card), but ENSURING/creating it (on a write) needs the active
 *     storage, and the active storage is the pod the prefs belong to — so the key
 *     is scoped per active storage (the SWR active-storage rule), guaranteeing a
 *     same-WebID storage switch never paints the other storage's prefs.
 *   - WRITES are OPTIMISTIC + non-blocking: the UI + the cache update
 *     immediately; the pod write runs async; on failure the cache reverts and an
 *     error toast fires. A small "Saving…/Saved" status reflects in-flight writes
 *     (the `saving` flag, surfaced via `sonner` by the caller).
 *   - MIGRATION: on first successful read for a WebID whose pod has no stored
 *     prefs but whose legacy localStorage holds Community prefs, those are
 *     written up to the pod ONCE (idempotent — guarded by a per-WebID marker).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "@/components/session-provider";
import { useSwrRead } from "@/components/use-swr-read";
import { readCache } from "@/lib/swr-cache";
import {
  type AppPrefs,
  appPrefsKey,
  defaultAppPrefs,
  discoverPreferencesFile,
  fetchAppPrefs,
  migrateLegacyPrefs,
  persistOptimistic,
} from "@/lib/app-prefs";
import {
  browserPrefsStorage,
  type CommunityPrefs,
} from "@/lib/community-prefs";

// Re-export the (data-layer) key builder so callers that already import the hook
// can reach it without a separate import.
export { appPrefsKey };

/**
 * One-time MIGRATION marker (per WebID) so the legacy-localStorage → pod
 * migration runs at most once per browser per account, regardless of how many
 * times the hook mounts. Idempotent on top of the marker AND on top of the read
 * itself (only migrates when the pod has NO stored prefs).
 */
const MIGRATION_PREFIX = "solid-pod-manager:app-prefs-migrated:";
function migrationMarkerKey(webId: string): string {
  return `${MIGRATION_PREFIX}${webId}`;
}

/** True when this WebID has already been migrated in this browser. */
function alreadyMigrated(webId: string): boolean {
  const storage = browserPrefsStorage();
  try {
    return storage?.getItem(migrationMarkerKey(webId)) === "1";
  } catch {
    return false;
  }
}

/** Mark this WebID migrated (best-effort; a quota failure is non-fatal). */
function markMigrated(webId: string): void {
  const storage = browserPrefsStorage();
  try {
    storage?.setItem(migrationMarkerKey(webId), "1");
  } catch {
    // Non-fatal: the migration is also idempotent against the pod state.
  }
}

export interface UseAppPrefsResult {
  /** The current app-prefs (cached/fresh; defaults until first load). */
  prefs: AppPrefs;
  /** True only on a first-ever uncached load (spinner) — usually false. */
  loading: boolean;
  /** True while a background revalidation runs (cached value shown). */
  revalidating: boolean;
  /** Set when the initial (uncached) load failed. */
  error?: Error;
  /** True while an optimistic write is being persisted to the pod. */
  saving: boolean;
  /** The prefs-file URL (the SWR topic) once discovered/known. */
  preferencesFile?: string;
  /**
   * Optimistically replace the whole prefs object and persist async. Accepts a
   * value OR a functional updater `(prev) => next` computed from the LIVE cache
   * value (so rapid consecutive writes compose). On failure the previous value
   * is restored (identity-guarded) and `onError` is called (the caller toasts).
   */
  setPrefs: (next: AppPrefs | ((prev: AppPrefs) => AppPrefs)) => void;
  /**
   * Convenience: replace just the Community slice (channels + read markers),
   * keeping theme/extra. Optimistic + non-blocking like {@link setPrefs}.
   *
   * Accepts a value OR a FUNCTIONAL UPDATER `(prev) => next`. The updater is
   * computed from the LIVE cache value (not stale React state), so rapid
   * consecutive calls (two read-marks before a re-render) compose correctly
   * rather than overwriting each other (roborev Medium).
   */
  setCommunity: (
    next: CommunityPrefs | ((prev: CommunityPrefs) => CommunityPrefs),
  ) => void;
}

export interface UseAppPrefsOptions {
  /** Called with the write error after an optimistic write reverts. */
  onError?: (error: Error) => void;
}

/**
 * The pod-backed app-prefs hook. Reads via SWR (instant paint from the
 * localStorage mirror, background pod revalidate); writes optimistically.
 */
export function useAppPrefs(options: UseAppPrefsOptions = {}): UseAppPrefsResult {
  const { webId, activeStorage } = useSession();
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;

  // The SWR key is empty (no read) until a WebID + active storage are known, so
  // we never read off an undefined storage. The prefs FILE is per-WebID, but the
  // key is storage-scoped per the active-storage SWR rule (a switch revalidates).
  const key = webId && activeStorage ? appPrefsKey(activeStorage) : "";

  // The discovered prefs-file URL (the SWR topicUrl) — learned after first read.
  // Stored in state so the notification subscription can watch it.
  const [preferencesFile, setPreferencesFile] = useState<string | undefined>(undefined);

  const fetcher = useCallback(
    async (id: string): Promise<AppPrefs> => {
      // Discover + read; the fetcher learns the prefs-file URL as a side effect
      // (for live-notification watching). Reading never creates a resource.
      const prefs = await fetchAppPrefs(id);
      return prefs;
    },
    [],
  );

  const swr = useSwrRead<AppPrefs>(key, fetcher, {
    cache: readCache,
    topicUrl: preferencesFile,
  });

  // Learn the prefs-file URL for the active WebID (best-effort; for the live
  // topic subscription only — the read works without it).
  useEffect(() => {
    if (!webId || !activeStorage) {
      setPreferencesFile(undefined);
      return;
    }
    let cancelled = false;
    discoverPreferencesFile(webId)
      .then((url) => {
        if (!cancelled) setPreferencesFile(url);
      })
      .catch(() => {
        /* topic-only; ignore */
      });
    return () => {
      cancelled = true;
    };
  }, [webId, activeStorage]);

  // The model the UI renders: the SWR value, or the defaults until first load.
  const prefs = swr.data ?? defaultAppPrefs();

  // ---- One-time migration: legacy localStorage → pod (idempotent). ----
  useEffect(() => {
    if (!webId || !activeStorage) return;
    // Only after a real read SETTLED SUCCESSFULLY: not loading, not revalidating,
    // a value present, AND no error. Gating on `!swr.error` (roborev Medium)
    // means we never act on a durable-MIRROR value left behind by a FAILED pod
    // revalidation; migrateLegacyPrefs ALSO re-verifies the pod fresh before
    // writing, so a stale mirror can never lead to clobbering real pod prefs.
    if (swr.loading || swr.revalidating || swr.data === undefined || swr.error) return;
    if (alreadyMigrated(webId)) return;
    let cancelled = false;
    // migrateLegacyPrefs is idempotent against the pod state (it only writes when
    // the pod is CONFIRMED empty AND legacy localStorage has a customisation), so
    // the per-WebID marker is purely an optimisation on top.
    migrateLegacyPrefs({
      webId,
      activeStorage,
      podPrefs: swr.data,
      storage: browserPrefsStorage(),
    })
      .then((outcome) => {
        if (cancelled) return;
        if (outcome.status === "failed") return; // retries on a later load
        markMigrated(webId); // skipped OR migrated → don't re-attempt
        if (outcome.status === "migrated") {
          // Optimistically reflect the migrated value (also mirrors to durable).
          readCache.set(webId, appPrefsKey(activeStorage), outcome.prefs);
        }
      })
      .catch(() => {
        // Defensive: migrateLegacyPrefs already maps errors to a "failed"
        // outcome; a throw here is not fatal — it retries on a later load.
      });
    return () => {
      cancelled = true;
    };
  }, [webId, activeStorage, swr.data, swr.loading, swr.revalidating, swr.error]);

  // ---- Optimistic, non-blocking write. ----
  // `saving` reflects whether ANY write is in flight, tracked with a COUNTER (not
  // a bool) so concurrent writes don't clear "Saving…" while another is still
  // pending (roborev High follow-up).
  const [pending, setPending] = useState(0);
  const saving = pending > 0;

  // The LIVE base for an updater: the cache value (authoritative for the slot),
  // falling back to the last-rendered SWR value, then defaults. Reading the cache
  // here (not React state) makes rapid consecutive updaters compose correctly
  // rather than each computing from the same stale render (roborev Medium).
  const liveBase = useCallback((): AppPrefs => {
    if (webId && activeStorage) {
      const cached = readCache.get<AppPrefs>(webId, appPrefsKey(activeStorage));
      if (cached) return cached;
    }
    return swr.data ?? defaultAppPrefs();
  }, [webId, activeStorage, swr.data]);

  const setPrefs = useCallback(
    (update: AppPrefs | ((prev: AppPrefs) => AppPrefs)) => {
      if (!webId || !activeStorage) return;
      const base = liveBase();
      const next = typeof update === "function" ? update(base) : update;
      // A functional updater that returns the SAME object is a no-op — never
      // write (e.g. a stale read-mark that did not advance). The value form
      // always writes (the caller explicitly asked to persist it).
      if (next === base) return;
      setPending((n) => n + 1);
      // Optimistic + non-blocking: paint+cache `next` now (updates every mount +
      // the durable mirror), persist async, revert on failure (identity-guarded
      // so a newer write is never clobbered). MUTATIONS READ FRESH —
      // persistOptimistic's write re-reads the card + prefs file at write time,
      // never the cached snapshot (the SwrCache security rule).
      persistOptimistic({ cache: readCache, webId, activeStorage, next })
        .then(() => {
          markMigrated(webId); // a successful write means the pod is now stored
        })
        .catch((e: unknown) => {
          const err = e instanceof Error ? e : new Error(String(e));
          onErrorRef.current?.(err);
        })
        .finally(() => setPending((n) => n - 1));
    },
    [webId, activeStorage, liveBase],
  );

  const setCommunity = useCallback(
    (update: CommunityPrefs | ((prev: CommunityPrefs) => CommunityPrefs)) => {
      setPrefs((prev) => {
        const community = typeof update === "function" ? update(prev.community) : update;
        // A no-op updater (e.g. a non-advancing read-mark returns the SAME
        // community object) must NOT churn the pod — keep the same AppPrefs
        // reference so persistOptimistic short-circuits.
        if (community === prev.community) return prev;
        return { ...prev, community };
      });
    },
    [setPrefs],
  );

  return useMemo(
    () => ({
      prefs,
      loading: swr.loading,
      revalidating: swr.revalidating,
      error: swr.error,
      saving,
      preferencesFile,
      setPrefs,
      setCommunity,
    }),
    [prefs, swr.loading, swr.revalidating, swr.error, saving, preferencesFile, setPrefs, setCommunity],
  );
}
