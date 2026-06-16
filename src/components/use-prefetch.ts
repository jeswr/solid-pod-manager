// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * `usePrefetch` — the React side of PROACTIVE PREFETCH (PM #65 Phase 2). Once the
 * user is logged in (and the app is idle on Home / wherever this is mounted), it
 * warms the shared SWR read cache for every read page the user is likely to visit
 * next, so the FIRST navigation to any of them is instant (data already cached).
 *
 * SCHEDULING (never competes with the current render): the warm-up is kicked off
 * AFTER first paint, during browser IDLE time — `requestIdleCallback` when
 * available, else a short `setTimeout` fallback. It never blocks the render path
 * and never `await`s on the mount: the effect schedules and returns immediately;
 * the actual `runPrefetch` runs later, off the critical path. The current page's
 * own `useSwrRead` always wins the race for its own slot (it sets on its own
 * fetch); prefetch only fills the slots the user has NOT visited yet.
 *
 * ONCE PER (webId, activeStorage): the warm-up is keyed to the active identity +
 * storage, so it runs once per login / storage switch — not on every re-render or
 * navigation. A storage switch re-warms for the new pod (the new storage-scoped
 * keys). Logout / no-storage simply does nothing.
 *
 * RESILIENT + RENDER-ONLY: delegates to {@link runPrefetch}, which isolates each
 * target's failure and only WARMS the cache (never invalidates, never changes
 * `useSwrRead`/`swr-cache` semantics — see prefetch.ts).
 */

import { useEffect, useRef } from "react";
import { useSession } from "@/components/session-provider";
import { runPrefetch, type RunPrefetchOptions } from "@/lib/prefetch";
import { decidePrefetch, scopeKey } from "@/lib/prefetch-scope";

/** A cancel handle for whichever idle/timeout primitive we scheduled with. */
type ScheduleHandle = { cancel: () => void };

/**
 * Schedule `cb` to run during browser idle time (after first paint), falling
 * back to a short timeout where `requestIdleCallback` is unavailable (Safari,
 * SSR-safe). Returns a handle that cancels it if the component unmounts first.
 */
function scheduleIdle(cb: () => void): ScheduleHandle {
  if (typeof window === "undefined") {
    // SSR / no window: nothing to schedule (this hook is "use client", but be safe).
    return { cancel: () => {} };
  }
  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  }).requestIdleCallback;
  if (typeof ric === "function") {
    // `timeout` guarantees it runs even on a busy tab, but still yields first.
    const id = ric(cb, { timeout: 2000 });
    return {
      cancel: () => {
        const cancelRic = (window as unknown as {
          cancelIdleCallback?: (id: number) => void;
        }).cancelIdleCallback;
        cancelRic?.(id);
      },
    };
  }
  // Fallback: a short delay so it lands after the current page's first paint +
  // its own SWR reads, never competing with them.
  const t = window.setTimeout(cb, 300);
  return { cancel: () => window.clearTimeout(t) };
}

/**
 * Warm the read cache for the likely-next pages once logged in. Mount it once
 * in the authenticated app shell. No return value — it is a pure side-effect
 * scheduled off the render path.
 *
 * @param options - test seam (inject a cache / disable inbox discovery); production
 *   passes nothing, warming the shared `readCache`.
 */
export function usePrefetch(options: RunPrefetchOptions = {}): void {
  const { status, webId, activeStorage, profile } = useSession();

  // Guard so the warm-up runs ONCE per (webId, activeStorage) — not on every
  // re-render. A new identity/storage resets it (re-warm for the new pod).
  const warmedFor = useRef<string | undefined>(undefined);

  // Keep the freshest options without making them a scheduling dependency (a new
  // object each render must not re-trigger the warm-up).
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // SESSION-RACE GUARD (roborev finding, High): the LIVE session-scope key, kept
  // fresh on every render. An in-flight warm-up (scheduled post-paint, resolving
  // asynchronously) reads this through `isCurrent` IMMEDIATELY BEFORE each
  // `cache.set`, so if the user logged out / switched account / switched storage
  // while a fetch was in flight, the write is SUPPRESSED — a prefetch can never
  // resurrect a logged-out (or switched-away) account's data into a cache the
  // session change just cleared. Built via the SAME `scopeKey` as `warmKey`
  // below, so the comparison is exact (same identity => same scope => current).
  const liveKeyRef = useRef<string>("");
  liveKeyRef.current = scopeKey(status, webId, activeStorage);

  useEffect(() => {
    // Storage-scoped pages need a storage; until one is chosen, only the
    // WebID-scoped targets would warm — still worth doing, but we re-warm once
    // storage lands (the key below changes), so a no-storage pass is fine too.
    const warmKey = scopeKey(status, webId, activeStorage);

    // The once-per-scope decision (factored into `decidePrefetch`, unit-tested for
    // the logout→same-account-login lifecycle). It also RESETS `warmedFor` when
    // there is no live scope: this hook stays MOUNTED on the logged-out screen
    // (AppShell never unmounts it), and logout clears `readCache`, so without the
    // reset a re-login to the SAME WebID/storage would reproduce the same warmKey
    // and be skipped — leaving the freshly-cleared session COLD (roborev Medium).
    const { shouldWarm, nextWarmedFor } = decidePrefetch(warmedFor.current, warmKey);
    warmedFor.current = nextWarmedFor;
    // `shouldWarm` is true only for a non-empty `warmKey`, which `scopeKey` returns
    // solely when logged-in WITH a WebID — so `webId` is defined here. The explicit
    // check both narrows the type and is a defensive belt.
    if (!shouldWarm || !webId) return;

    const storages = profile?.storages;
    // The scope this warm-up was scheduled FOR; `isCurrent` holds only while the
    // live session still matches it (same WebID + same active storage + still
    // logged in). A caller-supplied `isCurrent` is composed (AND-ed) so a test
    // seam can still force-suppress.
    const callerIsCurrent = optionsRef.current.isCurrent;
    const isCurrent = () =>
      liveKeyRef.current === warmKey && (callerIsCurrent?.() ?? true);

    const handle = scheduleIdle(() => {
      // Fire-and-forget: never block, never surface — a warm-up failure is silent
      // (each target is isolated in runPrefetch; the page cold-loads if missed).
      void runPrefetch(
        { webId, activeStorage, storages },
        { ...optionsRef.current, isCurrent },
      ).catch(() => undefined);
    });

    return () => handle.cancel();
  }, [status, webId, activeStorage, profile?.storages]);
}
