// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

import { describe, expect, it, vi } from "vitest";
import { SwrCache, type DurableStore } from "./swr-cache.js";

const WEBID_A = "https://alice.example/profile#me";
const WEBID_B = "https://bob.example/profile#me";

/**
 * An in-memory {@link DurableStore} fake, WebID+key scoped like the real
 * localStorage layer, so the SwrCache↔durable wiring is testable without a DOM.
 */
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
    for (const k of [...this.map.keys()]) {
      if (k.startsWith(`${webId}\u0000`)) this.map.delete(k);
    }
  }
  clearAll(): void {
    this.map.clear();
  }
}

describe("SwrCache", () => {
  it("returns a cached value instantly on hit (no async, no spinner needed)", () => {
    const cache = new SwrCache();
    expect(cache.has(WEBID_A, "k")).toBe(false);
    expect(cache.get(WEBID_A, "k")).toBeUndefined();

    cache.set(WEBID_A, "k", { apps: 3 });
    // A re-mount reads synchronously — this is what lets the UI paint at once.
    expect(cache.has(WEBID_A, "k")).toBe(true);
    expect(cache.get<{ apps: number }>(WEBID_A, "k")).toEqual({ apps: 3 });
    expect(cache.storedAt(WEBID_A, "k")).toBeTypeOf("number");
  });

  it("overwrites on a background revalidate and notifies subscribers", () => {
    const cache = new SwrCache();
    const listener = vi.fn();
    cache.set(WEBID_A, "k", "stale");
    cache.subscribe(WEBID_A, "k", listener);

    // Simulate the revalidation completing with fresh data.
    cache.set(WEBID_A, "k", "fresh");
    expect(cache.get(WEBID_A, "k")).toBe("fresh");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("invalidation drops the entry and notifies (notification-driven refresh)", () => {
    const cache = new SwrCache();
    const listener = vi.fn();
    cache.set(WEBID_A, "k", "value");
    cache.subscribe(WEBID_A, "k", listener);

    cache.invalidate(WEBID_A, "k");
    expect(cache.has(WEBID_A, "k")).toBe(false);
    expect(cache.get(WEBID_A, "k")).toBeUndefined();
    // A subscriber is told to go revalidate.
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("invalidation notifies even when nothing was cached (subscriber revalidates)", () => {
    const cache = new SwrCache();
    const listener = vi.fn();
    cache.subscribe(WEBID_A, "k", listener);
    cache.invalidate(WEBID_A, "k");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("is scoped per WebID — one account never reads another's value", () => {
    const cache = new SwrCache();
    cache.set(WEBID_A, "k", "alice");
    cache.set(WEBID_B, "k", "bob");
    expect(cache.get(WEBID_A, "k")).toBe("alice");
    expect(cache.get(WEBID_B, "k")).toBe("bob");

    // A subscriber for A is not fired by a write to B.
    const aListener = vi.fn();
    cache.subscribe(WEBID_A, "k", aListener);
    cache.set(WEBID_B, "k", "bob2");
    expect(aListener).not.toHaveBeenCalled();
  });

  it("clearWebId drops one account's partition and notifies its subscribers (logout)", () => {
    const cache = new SwrCache();
    cache.set(WEBID_A, "k", "alice");
    cache.set(WEBID_B, "k", "bob");
    const aListener = vi.fn();
    const bListener = vi.fn();
    cache.subscribe(WEBID_A, "k", aListener);
    cache.subscribe(WEBID_B, "k", bListener);

    cache.clearWebId(WEBID_A);
    expect(cache.get(WEBID_A, "k")).toBeUndefined();
    expect(cache.get(WEBID_B, "k")).toBe("bob"); // untouched
    expect(aListener).toHaveBeenCalledTimes(1); // re-render → no stale render
    expect(bListener).not.toHaveBeenCalled();
  });

  it("clearAll wipes everything and notifies all subscribers (hard reset)", () => {
    const cache = new SwrCache();
    cache.set(WEBID_A, "k", "alice");
    cache.set(WEBID_B, "k", "bob");
    const aListener = vi.fn();
    const bListener = vi.fn();
    cache.subscribe(WEBID_A, "k", aListener);
    cache.subscribe(WEBID_B, "k", bListener);

    cache.clearAll();
    expect(cache.get(WEBID_A, "k")).toBeUndefined();
    expect(cache.get(WEBID_B, "k")).toBeUndefined();
    expect(aListener).toHaveBeenCalledTimes(1);
    expect(bListener).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops further notifications", () => {
    const cache = new SwrCache();
    const listener = vi.fn();
    const unsub = cache.subscribe(WEBID_A, "k", listener);
    cache.set(WEBID_A, "k", "v1");
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    cache.set(WEBID_A, "k", "v2");
    expect(listener).toHaveBeenCalledTimes(1); // not called again
    // Idempotent.
    expect(() => unsub()).not.toThrow();
  });

  it("distinct keys under one WebID are independent", () => {
    const cache = new SwrCache();
    const kListener = vi.fn();
    cache.set(WEBID_A, "k1", "one");
    cache.subscribe(WEBID_A, "k1", kListener);

    cache.set(WEBID_A, "k2", "two");
    expect(cache.get(WEBID_A, "k1")).toBe("one");
    expect(cache.get(WEBID_A, "k2")).toBe("two");
    expect(kListener).not.toHaveBeenCalled(); // a write to k2 doesn't touch k1
  });
});

describe("SwrCache durable persistence (offline-first cold open)", () => {
  it("set mirrors the value to the durable store (next cold open paints it)", () => {
    const durable = new FakeDurable();
    const cache = new SwrCache(durable);
    cache.set(WEBID_A, "apps", { n: 3 });
    expect(durable.read(WEBID_A, "apps")).toEqual({ n: 3 });
  });

  it("hydrate pulls the durable snapshot into memory SYNCHRONOUSLY (cold-open first-paint)", () => {
    const durable = new FakeDurable();
    durable.write(WEBID_A, "apps", { n: 5 });
    // A fresh cache (simulating a reload: in-memory map is empty) hydrates.
    const cache = new SwrCache(durable);
    expect(cache.has(WEBID_A, "apps")).toBe(false); // nothing in memory yet
    expect(cache.hydrate<{ n: number }>(WEBID_A, "apps")).toEqual({ n: 5 });
    // After hydrate the value is in memory, so a synchronous get serves it.
    expect(cache.get<{ n: number }>(WEBID_A, "apps")).toEqual({ n: 5 });
  });

  it("hydrate returns undefined on a durable miss (cold load stays a spinner)", () => {
    const cache = new SwrCache(new FakeDurable());
    expect(cache.hydrate(WEBID_A, "apps")).toBeUndefined();
    expect(cache.has(WEBID_A, "apps")).toBe(false);
  });

  it("hydrate prefers an existing in-memory value over the durable snapshot", () => {
    const durable = new FakeDurable();
    durable.write(WEBID_A, "apps", "stale-from-disk");
    const cache = new SwrCache(durable);
    cache.set(WEBID_A, "apps", "fresh-in-memory"); // also overwrites durable
    durable.write(WEBID_A, "apps", "tampered"); // sneak a different durable value
    // The in-memory value wins — hydrate must not clobber a live value.
    expect(cache.hydrate(WEBID_A, "apps")).toBe("fresh-in-memory");
  });

  it("hydrate does NOT notify subscribers (it is a read-time fill, not a change)", () => {
    const durable = new FakeDurable();
    durable.write(WEBID_A, "apps", "x");
    const cache = new SwrCache(durable);
    const listener = vi.fn();
    cache.subscribe(WEBID_A, "apps", listener);
    cache.hydrate(WEBID_A, "apps");
    expect(listener).not.toHaveBeenCalled();
  });

  it("invalidate drops the durable snapshot (stale value can't resurrect on cold open)", () => {
    const durable = new FakeDurable();
    const cache = new SwrCache(durable);
    cache.set(WEBID_A, "apps", "v1");
    expect(durable.read(WEBID_A, "apps")).toBe("v1");
    cache.invalidate(WEBID_A, "apps");
    expect(durable.read(WEBID_A, "apps")).toBeNull();
  });

  it("clearWebId wipes the durable partition too (account switch leaves nothing behind)", () => {
    const durable = new FakeDurable();
    const cache = new SwrCache(durable);
    cache.set(WEBID_A, "apps", "alice");
    cache.set(WEBID_B, "apps", "bob");
    cache.clearWebId(WEBID_A);
    expect(durable.read(WEBID_A, "apps")).toBeNull();
    expect(durable.read(WEBID_B, "apps")).toBe("bob"); // other account untouched
  });

  it("clearAll wipes the entire durable store too (logout)", () => {
    const durable = new FakeDurable();
    const cache = new SwrCache(durable);
    cache.set(WEBID_A, "apps", "alice");
    cache.set(WEBID_B, "apps", "bob");
    cache.clearAll();
    expect(durable.read(WEBID_A, "apps")).toBeNull();
    expect(durable.read(WEBID_B, "apps")).toBeNull();
    expect(durable.map.size).toBe(0);
  });

  it("after a write+set the durable snapshot is the NEW value (no stale-after-write)", () => {
    const durable = new FakeDurable();
    const cache = new SwrCache(durable);
    cache.set(WEBID_A, "apps", ["app-x", "app-y"]); // before revoke
    // A revoke + reload re-fetches fresh and set()s the corrected model.
    cache.set(WEBID_A, "apps", ["app-x"]); // after revoke
    expect(durable.read(WEBID_A, "apps")).toEqual(["app-x"]);
  });

  it("a cold open (new SwrCache over a populated durable store) survives a reload", () => {
    const durable = new FakeDurable();
    // Session 1: fetch + cache.
    new SwrCache(durable).set(WEBID_A, "activity", [{ url: "a" }]);
    // Session 2 (reload): a brand-new in-memory cache over the same durable store.
    const reopened = new SwrCache(durable);
    expect(reopened.hydrate<{ url: string }[]>(WEBID_A, "activity")).toEqual([{ url: "a" }]);
  });

  it("passing null disables persistence (pure in-memory behaviour)", () => {
    const cache = new SwrCache(null);
    cache.set(WEBID_A, "apps", "x");
    // No durable store to read from on a fresh cache → cold.
    expect(new SwrCache(null).hydrate(WEBID_A, "apps")).toBeUndefined();
  });
});
