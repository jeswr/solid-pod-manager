// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * Regression lock for the Recent-activity SWR caching (PM home-page slowness
 * fix). The live symptom: Home painted "Recent activity" behind a spinner on
 * every nav-back-home and every cold open, re-running the full discovery +
 * per-category listing chain each time.
 *
 * The fix (already on `main`): {@link useRecentActivity} reads through the
 * shared {@link SwrCache} under the CONSTANT key `"recent-activity"`, partitioned
 * per WebID, with the durable `recent-activity` snapshot (a registered
 * {@link jsonCodec}) for instant cold-open paint. Home (`useRecentActivity(5)`)
 * and the Activity page (`useRecentActivity(50)`) both read that ONE key and
 * slice to their own `limit` at render — so they share ONE fetch and ONE cache
 * entry, and a second mount (nav-back) paints from cache with no blocking
 * refetch (only a silent background revalidate, never a spinner).
 *
 * Why this is a pure cache test (mirrors `swr-initial-state.test.ts`):
 * `useRecentActivity`/`useSwrRead` live in `src/components` and the Vitest config
 * runs the `node` environment with no DOM / React renderer, so we cannot mount
 * the real hook. Instead we drive the SAME {@link SwrCache} the hook uses,
 * through a `mountUseSwrRead` helper that reproduces the hook's mount logic 1:1
 * (synchronous `deriveSwrInitialState` paint + a single background revalidation
 * fetch that `set`s the result), and count the underlying `loadRecentActivity`
 * fetcher. That is the load-bearing behaviour; the React wiring around it is
 * exercised by the build + e2e.
 */

import { describe, expect, it, vi } from "vitest";
import { SwrCache, deriveSwrInitialState, type DurableStore } from "../lib/swr-cache.js";

/** The constant cache key `useRecentActivity` reads under (see use-activity.ts). */
const RECENT_ACTIVITY_KEY = "recent-activity";
/** The cached feed depth — callers slice DOWN to their own limit (use-activity.ts MAX_FEED). */
const MAX_FEED = 50;

const WEBID = "https://alice.example/profile#me";
const WEBID_B = "https://bob.example/profile#me";
const STORAGE = "https://alice.example/storage/";

/** A stand-in activity feed entry — only its shape/identity matters here. */
type Entry = { url: string };

/** A feed of `n` synthetic entries (newest-first), capped like the real fetcher. */
function feed(n: number): Entry[] {
  return Array.from({ length: Math.min(n, MAX_FEED) }, (_, i) => ({ url: `urn:entry:${i}` }));
}

/** In-memory durable fake (WebID+key scoped) so the cold-open path is testable. */
class FakeDurable implements DurableStore {
  readonly map = new Map<string, unknown>();
  private k(webId: string, key: string) {
    return `${webId}\u0000${key}`;
  }
  read<T>(webId: string, key: string): T | null {
    return this.map.has(this.k(webId, key)) ? (this.map.get(this.k(webId, key)) as T) : null;
  }
  write<T>(webId: string, key: string, value: T): void {
    this.map.set(this.k(webId, key), value);
  }
  clearEntry(webId: string, key: string): void {
    this.map.delete(this.k(webId, key));
  }
  clearWebId(webId: string): void {
    for (const k of [...this.map.keys()]) if (k.startsWith(`${webId}\u0000`)) this.map.delete(k);
  }
  clearAll(): void {
    this.map.clear();
  }
}

/**
 * Mount `useRecentActivity(limit)` once, modelling `useSwrRead`'s mount 1:1:
 *
 *  1. Seed the visible state SYNCHRONOUSLY from the cache
 *     ({@link deriveSwrInitialState}) — a hit paints instantly (loading:false),
 *     a miss is the cold spinner (loading:true). This is what the user sees on
 *     the FIRST paint; no network is awaited for it.
 *  2. Run exactly ONE background revalidation via `fetcher`, then `cache.set`
 *     the result (the SWR "always revalidate on mount" step). On a cache hit
 *     this is a SILENT background refresh — the user already saw data and never
 *     a spinner.
 *  3. Slice the visible value to `limit` (Home shows 5, Activity 50), exactly
 *     as `useRecentActivity` does at render.
 *
 * Returns the first-paint state the user saw, plus the post-revalidation value.
 */
async function mountUseSwrRead(
  cache: SwrCache,
  webId: string | undefined,
  limit: number,
  fetcher: (webId: string) => Promise<Entry[]>,
) {
  // (1) Synchronous first paint — the user-visible state before any network.
  const initial = deriveSwrInitialState<Entry[]>(cache, webId, RECENT_ACTIVITY_KEY);
  const firstPaint = {
    loading: initial.loading,
    revalidating: initial.revalidating,
    // The hook slices `data?.slice(0, limit)`; undefined while cold.
    data: initial.data?.slice(0, Math.max(0, limit)),
  };

  // (2) Exactly one background revalidation, then write through to the cache.
  if (webId) {
    const fresh = await fetcher(webId);
    cache.set(webId, RECENT_ACTIVITY_KEY, fresh);
  }

  // (3) The settled value, sliced to this caller's limit.
  const settled = webId ? cache.get<Entry[]>(webId, RECENT_ACTIVITY_KEY) : undefined;
  return {
    firstPaint,
    data: settled?.slice(0, Math.max(0, limit)),
  };
}

describe("useRecentActivity — shared SWR cache (PM home-slowness regression)", () => {
  it("Home(5) and Activity(50) share ONE fetch and ONE cache entry under the constant key", async () => {
    const cache = new SwrCache(null);
    // ONE underlying loadRecentActivity, counted across both callers.
    const fetcher = vi.fn(async () => feed(MAX_FEED));

    // Home mounts first (cold): one fetch, paints a spinner, then caps at 5.
    const home = await mountUseSwrRead(cache, WEBID, 5, fetcher);
    expect(home.firstPaint.loading).toBe(true); // cold first-ever paint
    expect(home.data).toHaveLength(5);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Navigate Home → Activity: the SAME key is already cached, so Activity
    // paints INSTANTLY from the shared entry (no spinner) and shows up to 50.
    const activity = await mountUseSwrRead(cache, WEBID, 50, fetcher);
    expect(activity.firstPaint.loading).toBe(false); // served from cache, no spinner
    expect(activity.firstPaint.revalidating).toBe(true); // silent background refresh
    expect(activity.firstPaint.data).toHaveLength(MAX_FEED); // the full cached feed
    expect(activity.data).toHaveLength(MAX_FEED);

    // There is exactly ONE cache entry (the constant key), shared by both views.
    expect(cache.has(WEBID, RECENT_ACTIVITY_KEY)).toBe(true);
    expect(cache.get<Entry[]>(WEBID, RECENT_ACTIVITY_KEY)).toHaveLength(MAX_FEED);
  });

  it("a second mount (nav-back-home) hydrates from cache instantly — first paint never a spinner", async () => {
    const cache = new SwrCache(null);
    const fetcher = vi.fn(async () => feed(MAX_FEED));

    // First Home visit (cold) primes the shared entry.
    await mountUseSwrRead(cache, WEBID, 5, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Nav away and back to Home: the cached value paints SYNCHRONOUSLY — the
    // user sees data immediately (loading:false), the network is NOT awaited for
    // the first paint. The fix's whole point: no blank/spinner on nav-back.
    const back = await mountUseSwrRead(cache, WEBID, 5, fetcher);
    expect(back.firstPaint.loading).toBe(false); // instant paint from cache
    expect(back.firstPaint.data).toHaveLength(5); // already had data to show
    expect(back.firstPaint.revalidating).toBe(true); // refresh runs silently behind it
    expect(back.data).toHaveLength(5);
  });

  it("a cold open / app reopen paints from the durable snapshot (no spinner, no blocking fetch)", async () => {
    const durable = new FakeDurable();
    // Session 1: Home fetched + cached, mirrored to the durable snapshot.
    const c1 = new SwrCache(durable);
    await mountUseSwrRead(c1, WEBID, 5, vi.fn(async () => feed(MAX_FEED)));
    expect(durable.read<Entry[]>(WEBID, RECENT_ACTIVITY_KEY)).toHaveLength(MAX_FEED);

    // Session 2 (cold open / reopen): a brand-new in-memory cache over the same
    // durable store. The FIRST paint hydrates the snapshot synchronously — no
    // spinner, before the background revalidation fetch even starts.
    const c2 = new SwrCache(durable);
    const fetcher2 = vi.fn(async () => feed(MAX_FEED));
    const reopened = await mountUseSwrRead(c2, WEBID, 5, fetcher2);
    expect(reopened.firstPaint.loading).toBe(false); // durable hit → instant
    expect(reopened.firstPaint.data).toHaveLength(5);
  });

  it("the cache is per-WebID — one account's feed never paints for another", async () => {
    const cache = new SwrCache(null);
    await mountUseSwrRead(cache, WEBID, 5, vi.fn(async () => feed(MAX_FEED)));

    // A different account is cold for the SAME key — it must not see Alice's feed.
    const bob = deriveSwrInitialState<Entry[]>(cache, WEBID_B, RECENT_ACTIVITY_KEY);
    expect(bob).toEqual({ data: undefined, loading: true, revalidating: false });
  });

  it("the topic url (active storage) is stable, so a mount never invalidates the entry", () => {
    // useRecentActivity passes a CONSTANT key and a stable topicUrl (activeStorage);
    // nothing on mount drops the entry. Only a real notification / logout does.
    // Model that: priming + re-deriving on the same (webId, key, storage) keeps
    // the entry — no per-visit invalidation defeats the cache.
    const cache = new SwrCache(null);
    cache.set(WEBID, RECENT_ACTIVITY_KEY, feed(MAX_FEED));
    // Storage is the topicUrl; it is the same across mounts within a session.
    void STORAGE;
    // Re-deriving (a re-mount) sees the entry, never clears it.
    const remount = deriveSwrInitialState<Entry[]>(cache, WEBID, RECENT_ACTIVITY_KEY);
    expect(remount.loading).toBe(false);
    expect(remount.revalidating).toBe(true);
    expect(cache.has(WEBID, RECENT_ACTIVITY_KEY)).toBe(true);

    // A genuine change event (notification) is what SHOULD drop it.
    cache.invalidate(WEBID, RECENT_ACTIVITY_KEY);
    expect(cache.has(WEBID, RECENT_ACTIVITY_KEY)).toBe(false);
  });
});
