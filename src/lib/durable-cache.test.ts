// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

import { describe, expect, it } from "vitest";
import {
  clearAllDurableCache,
  clearDurableCacheEntry,
  clearDurableCacheForWebId,
  MAX_AGE_MS,
  readDurableCache,
  type SyncStorage,
  VERSION,
  writeDurableCache,
} from "./durable-cache.js";

const WEBID_A = "https://alice.example/profile#me";
const WEBID_B = "https://bob.example/profile#me";

/** An in-memory SyncStorage matching the localStorage contract (node test env). */
class MemoryStorage implements SyncStorage {
  private map = new Map<string, string>();
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
}

/** A storage whose writes throw (quota-exceeded simulation). */
class ThrowingStorage extends MemoryStorage {
  setItem(): void {
    throw new Error("QuotaExceededError");
  }
}

describe("durable-cache", () => {
  it("round-trips a value for a (webId, key) pair", () => {
    const s = new MemoryStorage();
    writeDurableCache(WEBID_A, "apps", [{ name: "App", n: 1 }], s);
    expect(readDurableCache(WEBID_A, "apps", s)).toEqual([{ name: "App", n: 1 }]);
  });

  it("returns null when nothing is cached", () => {
    expect(readDurableCache(WEBID_A, "apps", new MemoryStorage())).toBeNull();
  });

  it("is WebID-scoped — one account never reads another's snapshot", () => {
    const s = new MemoryStorage();
    writeDurableCache(WEBID_A, "apps", "alice-data", s);
    // Bob asks for the same key — must MISS (no cross-user data bleed).
    expect(readDurableCache(WEBID_B, "apps", s)).toBeNull();
    expect(readDurableCache(WEBID_A, "apps", s)).toBe("alice-data");
  });

  it("never hydrates without a WebID (a miss, not a hydrate of someone's data)", () => {
    const s = new MemoryStorage();
    writeDurableCache(WEBID_A, "apps", "alice-data", s);
    expect(readDurableCache(null, "apps", s)).toBeNull();
    expect(readDurableCache(undefined, "apps", s)).toBeNull();
    expect(readDurableCache("", "apps", s)).toBeNull();
  });

  it("does not persist without a WebID (the snapshot would be unreadable)", () => {
    const s = new MemoryStorage();
    writeDurableCache(null, "apps", "x", s);
    writeDurableCache("", "apps", "x", s);
    expect(s.length).toBe(0);
  });

  it("does not persist undefined (nothing to paint)", () => {
    const s = new MemoryStorage();
    writeDurableCache(WEBID_A, "apps", undefined, s);
    expect(s.length).toBe(0);
  });

  it("distinct keys under one WebID are independent", () => {
    const s = new MemoryStorage();
    writeDurableCache(WEBID_A, "apps", "a", s);
    writeDurableCache(WEBID_A, "activity", "b", s);
    expect(readDurableCache(WEBID_A, "apps", s)).toBe("a");
    expect(readDurableCache(WEBID_A, "activity", s)).toBe("b");
  });

  it("misses on a version mismatch (stale shapes can't leak or mis-parse)", () => {
    const s = new MemoryStorage();
    // Forge an envelope with a different version.
    const forged = JSON.stringify({
      v: VERSION + 1,
      at: Date.now(),
      webId: WEBID_A,
      key: "apps",
      value: "old-shape",
    });
    s.setItem(`solid-pod-manager:read-cache:${WEBID_A}\u0000apps`, forged);
    expect(readDurableCache(WEBID_A, "apps", s)).toBeNull();
  });

  it("misses on a WebID mismatch even with the right key (defence in depth)", () => {
    const s = new MemoryStorage();
    // Forge an envelope whose in-body webId disagrees with the lookup webId,
    // stored under WEBID_B's key — readDurableCache(WEBID_B) must reject it.
    const forged = JSON.stringify({
      v: VERSION,
      at: Date.now(),
      webId: WEBID_A, // body says Alice
      key: "apps",
      value: "alice-data",
    });
    s.setItem(`solid-pod-manager:read-cache:${WEBID_B}\u0000apps`, forged);
    expect(readDurableCache(WEBID_B, "apps", s)).toBeNull();
  });

  it("does not paint a snapshot older than MAX_AGE_MS (bounded first-paint staleness)", () => {
    const s = new MemoryStorage();
    const now = 1_000_000_000_000;
    writeDurableCache(WEBID_A, "apps", "old", s, now);
    // Just within the bound: still painted.
    expect(readDurableCache(WEBID_A, "apps", s, now + MAX_AGE_MS - 1)).toBe("old");
    // Past the bound: a miss (still revalidates via the network).
    expect(readDurableCache(WEBID_A, "apps", s, now + MAX_AGE_MS + 1)).toBeNull();
  });

  it("returns null (not a throw) on a corrupt entry", () => {
    const s = new MemoryStorage();
    s.setItem(`solid-pod-manager:read-cache:${WEBID_A}\u0000apps`, "{not json");
    expect(readDurableCache(WEBID_A, "apps", s)).toBeNull();
  });

  it("is best-effort: a quota error on write never throws", () => {
    const s = new ThrowingStorage();
    expect(() => writeDurableCache(WEBID_A, "apps", "x", s)).not.toThrow();
  });

  it("degrades to no-cache when there is no storage (SSR / privacy mode)", () => {
    expect(readDurableCache(WEBID_A, "apps", null)).toBeNull();
    expect(() => writeDurableCache(WEBID_A, "apps", "x", null)).not.toThrow();
    expect(() => clearAllDurableCache(null)).not.toThrow();
    expect(() => clearDurableCacheForWebId(WEBID_A, null)).not.toThrow();
    expect(() => clearDurableCacheEntry(WEBID_A, "apps", null)).not.toThrow();
  });

  it("clearDurableCacheEntry removes one (webId, key) only", () => {
    const s = new MemoryStorage();
    writeDurableCache(WEBID_A, "apps", "a", s);
    writeDurableCache(WEBID_A, "activity", "b", s);
    clearDurableCacheEntry(WEBID_A, "apps", s);
    expect(readDurableCache(WEBID_A, "apps", s)).toBeNull();
    expect(readDurableCache(WEBID_A, "activity", s)).toBe("b");
  });

  it("clearDurableCacheForWebId drops one account's snapshots, keeps the other's (account switch)", () => {
    const s = new MemoryStorage();
    writeDurableCache(WEBID_A, "apps", "alice", s);
    writeDurableCache(WEBID_A, "activity", "alice2", s);
    writeDurableCache(WEBID_B, "apps", "bob", s);

    clearDurableCacheForWebId(WEBID_A, s);
    expect(readDurableCache(WEBID_A, "apps", s)).toBeNull();
    expect(readDurableCache(WEBID_A, "activity", s)).toBeNull();
    expect(readDurableCache(WEBID_B, "apps", s)).toBe("bob"); // untouched
  });

  it("clearAllDurableCache wipes every account's snapshots (logout)", () => {
    const s = new MemoryStorage();
    writeDurableCache(WEBID_A, "apps", "alice", s);
    writeDurableCache(WEBID_B, "apps", "bob", s);
    clearAllDurableCache(s);
    expect(readDurableCache(WEBID_A, "apps", s)).toBeNull();
    expect(readDurableCache(WEBID_B, "apps", s)).toBeNull();
    expect(s.length).toBe(0);
  });

  it("clearAll/clearForWebId leave UNRELATED localStorage keys alone", () => {
    const s = new MemoryStorage();
    s.setItem("some-other-app:thing", "keep-me");
    writeDurableCache(WEBID_A, "apps", "alice", s);
    clearAllDurableCache(s);
    expect(s.getItem("some-other-app:thing")).toBe("keep-me");
  });
});
