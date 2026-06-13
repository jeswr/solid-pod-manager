// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

import { describe, expect, it, vi } from "vitest";
import { SwrCache } from "./swr-cache.js";

const WEBID_A = "https://alice.example/profile#me";
const WEBID_B = "https://bob.example/profile#me";

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
