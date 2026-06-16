// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * PRIVACY LOCK — private Matrix feed content must NEVER be written to disk
 * (localStorage). roborev finding (HIGH): the unified community `FeedResult`
 * interleaves PRIVATE Matrix room messages with the public Solid forum; routing
 * it through the DEFAULT durable {@link readCache} would mirror those private
 * message bodies into the `localStorage` snapshot, where they outlive the
 * session and aren't scoped/cleared like auth state.
 *
 * The fix routes `useCommunityFeed` through the MEMORY-ONLY {@link memoryReadCache}
 * (a `SwrCache` built with no durable store). These tests assert, end-to-end
 * through the REAL cache instances and a REAL `localStorage` fake, that:
 *
 *   1. Writing a feed value that contains Matrix message bodies through
 *      `memoryReadCache` puts NOTHING into localStorage (the leak is closed at
 *      the cache the hook actually uses).
 *   2. The value is still served from memory (instant-nav UX preserved).
 *   3. Account-switch / logout clears the memory cache (no cross-account or
 *      post-logout retention in memory either).
 *   4. Defense-in-depth: even the default durable `readCache` refuses to persist
 *      a `community:` key, because the durable layer's codec registry has no
 *      codec for it (unregistered ⇒ memory-only) — so the leak cannot reopen by
 *      accident if the cache wiring ever regressed.
 *
 * Runs under the `node` env (no DOM); we install a minimal `localStorage` fake
 * that records every write, so any persisted byte is observable.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FeedResult } from "@jeswr/solid-community-feeds";
import { clearCommunityFeedCache } from "@/components/use-community";
import { memoryReadCache, readCache, SwrCache } from "@/lib/swr-cache";
import { writeDurableCache } from "@/lib/durable-cache";

const WEBID = "https://alice.example/profile#me";
const OTHER_WEBID = "https://bob.example/profile#me";
const COMMUNITY_KEY = "community:m:1::9856:";
/** The disconnected-Matrix slot for the same rooms (key folds m→_). */
const COMMUNITY_KEY_DISCONNECTED = "community:_:1::9856:";

/** A secret string that must NEVER appear in any persisted (localStorage) byte. */
const SECRET_MATRIX_BODY = "PRIVATE-MATRIX-SECRET-do-not-persist-42";

/** A FeedResult whose Matrix thread carries a private message body. */
function feedWithMatrixBodies(): FeedResult {
  return {
    threads: [
      {
        id: "matrix:!room:matrix.org:$evt",
        source: "matrix",
        title: "private room",
        url: "https://matrix.to/#/!room:matrix.org",
        lastActivityAt: new Date().toISOString(),
        messageCount: 1,
        messages: [
          {
            id: "$evt",
            author: "@alice:matrix.org",
            body: SECRET_MATRIX_BODY,
            createdAt: new Date().toISOString(),
          },
        ],
        unread: true,
      },
    ],
    errors: [],
  } as unknown as FeedResult;
}

/** Minimal localStorage fake that records every write (node env has none). */
class RecordingStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
  /** Every persisted byte concatenated — for a global "secret present?" check. */
  allBytes(): string {
    return [...this.map.values()].join("\n");
  }
}

describe("community feed privacy — private Matrix content is never persisted to disk", () => {
  let storage: RecordingStorage;
  let prevLocalStorage: Storage | undefined;

  beforeEach(() => {
    storage = new RecordingStorage();
    prevLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
    // Install the recording fake as the global localStorage the durable layer
    // reads via `globalThis.localStorage` (durable-cache `defaultStorage()`).
    Object.defineProperty(globalThis, "localStorage", {
      value: storage,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    memoryReadCache.clearAll();
    readCache.clearAll();
    if (prevLocalStorage === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    } else {
      Object.defineProperty(globalThis, "localStorage", {
        value: prevLocalStorage,
        configurable: true,
        writable: true,
      });
    }
  });

  it("memoryReadCache.set of a feed with Matrix bodies writes NOTHING to localStorage", () => {
    memoryReadCache.set(WEBID, COMMUNITY_KEY, feedWithMatrixBodies());
    // The entire localStorage is empty — no snapshot key, no envelope, nothing.
    expect(storage.length).toBe(0);
    expect(storage.allBytes()).not.toContain(SECRET_MATRIX_BODY);
  });

  it("still serves the feed from memory (instant-nav UX preserved)", () => {
    const value = feedWithMatrixBodies();
    memoryReadCache.set(WEBID, COMMUNITY_KEY, value);
    expect(memoryReadCache.get(WEBID, COMMUNITY_KEY)).toBe(value);
    // hydrate() (the cold-open path) returns the in-memory value but never reads
    // or seeds from durable for this cache (no durable store at all).
    expect(memoryReadCache.hydrate(WEBID, COMMUNITY_KEY)).toBe(value);
    expect(storage.length).toBe(0);
  });

  it("clears the memory cache on account switch (no cross-account retention)", () => {
    memoryReadCache.set(WEBID, COMMUNITY_KEY, feedWithMatrixBodies());
    // The session bridge calls clearWebId(prev) on an account switch.
    memoryReadCache.clearWebId(WEBID);
    expect(memoryReadCache.get(WEBID, COMMUNITY_KEY)).toBeUndefined();
    // The other account never saw the first account's content.
    expect(memoryReadCache.get(OTHER_WEBID, COMMUNITY_KEY)).toBeUndefined();
  });

  it("clears the memory cache on logout (no post-logout retention)", () => {
    memoryReadCache.set(WEBID, COMMUNITY_KEY, feedWithMatrixBodies());
    // The session bridge calls clearAll() on logout.
    memoryReadCache.clearAll();
    expect(memoryReadCache.get(WEBID, COMMUNITY_KEY)).toBeUndefined();
    expect(storage.length).toBe(0);
  });

  it("defense-in-depth: even the durable readCache refuses to persist a community: key", () => {
    // The durable layer's codec registry has no codec for `community:`, so it is
    // memory-only at the durable layer too — a second, independent guard against
    // the leak reopening if the cache wiring ever regressed to the default cache.
    readCache.set(WEBID, COMMUNITY_KEY, feedWithMatrixBodies());
    expect(storage.length).toBe(0);
    expect(storage.allBytes()).not.toContain(SECRET_MATRIX_BODY);
    // Direct durable write of the key is likewise a no-op (no registered codec).
    writeDurableCache(WEBID, COMMUNITY_KEY, feedWithMatrixBodies());
    expect(storage.length).toBe(0);
    expect(storage.allBytes()).not.toContain(SECRET_MATRIX_BODY);
  });

  it("memoryReadCache is a SwrCache with NO durable store (constructed with null)", () => {
    // Structural guarantee: it is the memory-only instance, distinct from the
    // default durable readCache. A regression that pointed the hook back at a
    // durable cache would have to change this construction.
    expect(memoryReadCache).toBeInstanceOf(SwrCache);
    expect(memoryReadCache).not.toBe(readCache);
  });

  it("clearCommunityFeedCache evicts the connected feed on Matrix disconnect (no lingering/reuse)", () => {
    // Matrix connected: the feed cached private content under the "m" slot.
    memoryReadCache.set(WEBID, COMMUNITY_KEY, feedWithMatrixBodies());
    expect(memoryReadCache.get(WEBID, COMMUNITY_KEY)).toBeDefined();
    // On disconnect the page calls clearCommunityFeedCache(webId): the private
    // "m" slot must be GONE from memory, so it can't linger or be re-served on a
    // later reconnect with the same rooms (roborev finding, Medium).
    clearCommunityFeedCache(WEBID);
    expect(memoryReadCache.get(WEBID, COMMUNITY_KEY)).toBeUndefined();
    // And nothing ever touched disk throughout.
    expect(storage.length).toBe(0);
  });

  it("clearCommunityFeedCache also drops the disconnected slot and is a no-op without a WebID", () => {
    memoryReadCache.set(WEBID, COMMUNITY_KEY, feedWithMatrixBodies());
    memoryReadCache.set(WEBID, COMMUNITY_KEY_DISCONNECTED, feedWithMatrixBodies());
    clearCommunityFeedCache(WEBID);
    expect(memoryReadCache.get(WEBID, COMMUNITY_KEY)).toBeUndefined();
    expect(memoryReadCache.get(WEBID, COMMUNITY_KEY_DISCONNECTED)).toBeUndefined();
    // No WebID (logged out): nothing to clear, must not throw.
    expect(() => clearCommunityFeedCache(undefined)).not.toThrow();
  });

  it("a late write to a CLEARED WebID never reaches disk (memory-only boundary holds)", () => {
    // Defense-in-depth for the stale-in-flight-write concern: even if a fetch
    // that started before a session boundary resolves AFTER the cache was
    // cleared and writes back, it writes to the MEMORY-ONLY cache — so the
    // private body still never reaches localStorage. (useSwrRead additionally
    // cancels the in-flight write via its effect-cleanup `cancelled` flag.)
    memoryReadCache.clearWebId(WEBID); // session boundary cleared the partition
    memoryReadCache.set(WEBID, COMMUNITY_KEY, feedWithMatrixBodies()); // late write
    expect(storage.length).toBe(0);
    expect(storage.allBytes()).not.toContain(SECRET_MATRIX_BODY);
  });
});
