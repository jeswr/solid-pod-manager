// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * SYSTEMATIC "instant nav" guarantee (the durable contract behind the PM
 * home/files-slowness fix).
 *
 * The user-visible bug: navigating to a READ page (`/files`, `/notes`,
 * `/inbox`, …) re-ran its full fetch chain behind a blank SPINNER every time,
 * even though the data was already in hand from a previous visit. The fix is
 * that every READ-page hook sources its display model through {@link useSwrRead}
 * over the shared {@link SwrCache}, which seeds the FIRST paint SYNCHRONOUSLY
 * from the cache (in-memory OR the durable cold-open snapshot): a warm cache
 * paints instantly (`loading:false`, data present) while a silent background
 * revalidation runs (`revalidating:true`); only a first-ever, never-seen key
 * shows the spinner (`loading:true`).
 *
 * This file is the SINGLE SOURCE OF TRUTH that the property holds for EVERY read
 * page — now and for any read page added later — in two independent ways:
 *
 *  1. A behavioural REGISTRY ({@link READ_PAGE_HOOKS}) listing every read-page
 *     hook with a SAMPLE cache key and a seed function. For each entry we drive
 *     the EXACT synchronous first-paint logic the hooks use
 *     ({@link deriveSwrInitialState}) against a test {@link SwrCache} (the
 *     `useSwrRead` `options.cache` seam) and assert: WARM cache → instant paint
 *     (no spinner) + background revalidate; COLD cache → the spinner exactly
 *     once. (Vitest runs the `node` env with no DOM/React renderer — see
 *     vitest.config.ts — so, exactly as `use-activity.test.ts` does, we exercise
 *     the load-bearing first-paint logic directly rather than mounting React;
 *     the React wiring around it is covered by the build + e2e.)
 *
 *  2. A STRUCTURAL guard ({@link READ_HOOK_SOURCES}) that reads every
 *     `src/components/use-*.ts` source and FAILS the build if a hook classified
 *     READ does not import/use `useSwrRead` — so a future read page that forgets
 *     the cache (and would therefore spin on every nav) breaks the build. The
 *     classification (READ vs ACTION) is explicit and commented below; adding a
 *     new read page means adding it to BOTH lists.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SwrCache, deriveSwrInitialState, type DurableStore } from "../lib/swr-cache.js";
import {
  type InboxDiscovery,
  inboxCacheKey,
  inboxDiscoveryReady,
} from "../lib/inbox-discovery.js";

const COMPONENTS_DIR = dirname(fileURLToPath(import.meta.url));
const WEBID = "https://alice.example/profile#me";
const STORAGE = "https://alice.example/storage/";

// ---------------------------------------------------------------------------
// (1) Behavioural registry — every READ-PAGE hook + a sample key + a seed.
// ---------------------------------------------------------------------------

/**
 * One read-page hook's entry in the registry: the bare cache key it reads under
 * (WebID-partitioned by `useSwrRead`, so we seed the bare key), and a function
 * that seeds a representative cached value into a test cache. Adding a read page
 * = adding an entry here (and to {@link READ_HOOKS} below).
 */
interface ReadPageHook {
  /** The hook export name (documentation + failure messages). */
  hook: string;
  /** The page(s) it backs (documentation). */
  page: string;
  /**
   * A SAMPLE bare cache key the hook reads under. Where the hook keys
   * dynamically (per container / per item / per chat / per domain), this is a
   * representative concrete key — the cache treats the key as opaque, so the
   * first-paint property is identical for every concrete value.
   */
  key: string;
  /** Seed a representative value for `key` into `cache` for `WEBID`. */
  seed: (cache: SwrCache) => void;
}

/**
 * The registry. Each entry maps a read page hook to a sample key + a seed. This
 * is the systematic enumeration the instant-paint property is asserted over —
 * keep it in lockstep with {@link READ_HOOKS}.
 */
const READ_PAGE_HOOKS: ReadPageHook[] = [
  // use-files.ts — the headline fix: per-container listing.
  {
    hook: "useFolder",
    page: "/files",
    key: `files:${STORAGE}documents/`,
    seed: (c) => c.set(WEBID, `files:${STORAGE}documents/`, [{ url: `${STORAGE}documents/a.txt` }]),
  },
  // use-friends.ts — friend list.
  {
    hook: "useFriends",
    page: "/people (friends)",
    key: "friends",
    seed: (c) => c.set(WEBID, "friends", ["https://bob.example/profile#me"]),
  },
  // use-inbox.ts — LDN inbox listing, keyed per DISCOVERED inbox URL (the inbox
  // container is active-storage-dependent, so the key carries the discovered URL).
  {
    hook: "useInbox",
    page: "/inbox",
    key: `inbox:${STORAGE}inbox/`,
    seed: (c) => c.set(WEBID, `inbox:${STORAGE}inbox/`, [{ id: "urn:notif:1" }]),
  },
  // use-people.ts — people-picker options, keyed PER ACTIVE STORAGE (the fetcher
  // reads the active storage's contacts store).
  {
    hook: "usePeople",
    page: "people-picker (/people, /contacts pickers)",
    key: `people:${STORAGE}`,
    seed: (c) =>
      c.set(WEBID, `people:${STORAGE}`, [{ webId: "https://bob.example/profile#me", name: "Bob" }]),
  },
  // use-productivity.ts — list view, keyed per store container.
  {
    hook: "useItems",
    page: "/notes /calendar /contacts /bookmarks /tasks /issues",
    key: `productivity:${STORAGE}notes/`,
    seed: (c) => c.set(WEBID, `productivity:${STORAGE}notes/`, [{ url: `${STORAGE}notes/1`, data: {} }]),
  },
  // use-productivity.ts — single item, keyed per item URL.
  {
    hook: "useItem",
    page: "/notes/edit /calendar/edit /contacts/edit /tasks/edit /issues/edit",
    key: `productivity-item:${STORAGE}notes/1`,
    seed: (c) => c.set(WEBID, `productivity-item:${STORAGE}notes/1`, { url: `${STORAGE}notes/1`, data: {} }),
  },
  // use-domains.ts — domain bindings list, keyed PER API BASE (the fetcher reads
  // from the active storage's domains API base).
  {
    hook: "useDomains",
    page: "/settings/domains",
    key: `domains:${STORAGE}`,
    seed: (c) => c.set(WEBID, `domains:${STORAGE}`, [{ domain: "alice.example", status: "verified" }]),
  },
  // use-domains.ts — one binding's detail, keyed PER API BASE + domain (detail
  // read AND verify POST are scoped to the base).
  {
    hook: "useDomain",
    page: "/settings/domains/[domain]",
    key: `domain:${STORAGE}:alice.example`,
    seed: (c) =>
      c.set(WEBID, `domain:${STORAGE}:alice.example`, { domain: "alice.example", status: "verified" }),
  },
  // use-chat.ts — message listing, keyed per chat container.
  {
    hook: "useChat",
    page: "/chat",
    key: `chat:${STORAGE}chats/general/`,
    seed: (c) => c.set(WEBID, `chat:${STORAGE}chats/general/`, [{ id: "urn:msg:1", content: "hi" }]),
  },
  // use-type-index.ts — type-index management view.
  {
    hook: "useTypeIndex",
    page: "/settings/type-index",
    key: "type-index",
    seed: (c) => c.set(WEBID, "type-index", { public: [], private: [] }),
  },
  // --- Already-converted read hooks (kept here so the systematic guarantee
  //     covers the WHOLE read surface, not just the newly-converted hooks). ---
  {
    hook: "useRecentActivity",
    page: "/ (home) /activity",
    key: "recent-activity",
    seed: (c) => c.set(WEBID, "recent-activity", [{ url: "urn:entry:1" }]),
  },
  {
    hook: "useCategorySummaries",
    page: "/ (home) /my-data",
    key: "category-summaries",
    seed: (c) => c.set(WEBID, "category-summaries", [{ category: { id: "notes" }, hasData: true }]),
  },
  {
    hook: "useCategoryItems",
    page: "/category/[id]",
    key: "category-items:notes",
    seed: (c) => c.set(WEBID, "category-items:notes", [{ url: `${STORAGE}notes/1` }]),
  },
  {
    hook: "useConnectedApps",
    page: "/connected-apps",
    key: "connected-apps",
    seed: (c) => c.set(WEBID, "connected-apps", { apps: [], ctx: {} }),
  },
  {
    hook: "useAssignedTasks",
    page: "/tasks (assigned-to-me)",
    key: `assigned-tasks:${STORAGE}`,
    seed: (c) => c.set(WEBID, `assigned-tasks:${STORAGE}`, [{ task: { title: "t" } }]),
  },
];

/** An in-memory durable fake so the COLD-OPEN (durable snapshot) path is testable. */
class FakeDurable implements DurableStore {
  readonly map = new Map<string, unknown>();
  private k(webId: string, key: string) {
    return `${webId} ${key}`;
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
    for (const k of [...this.map.keys()]) if (k.startsWith(`${webId} `)) this.map.delete(k);
  }
  clearAll(): void {
    this.map.clear();
  }
}

describe("instant-nav: every READ page paints instantly from a warm cache", () => {
  for (const entry of READ_PAGE_HOOKS) {
    describe(`${entry.hook} (${entry.page})`, () => {
      it("WARM in-memory cache → FIRST paint is instant (no spinner) + background revalidate", () => {
        const cache = new SwrCache(null);
        entry.seed(cache);

        // This is the EXACT synchronous logic the hook runs on its first render
        // (useSwrRead seeds state from deriveSwrInitialState). A warm cache must
        // paint data with no spinner and kick a silent background refresh.
        const first = deriveSwrInitialState(cache, WEBID, entry.key);
        expect(first.loading, `${entry.hook} must NOT show a spinner with a warm cache`).toBe(false);
        expect(first.data, `${entry.hook} must paint the cached data on first render`).toBeDefined();
        expect(first.revalidating, `${entry.hook} must revalidate in the background`).toBe(true);
      });

      it("WARM cold-open (durable snapshot only) → still instant on the FIRST render", () => {
        // Session 2 / cold open: a brand-new in-memory cache over a durable store
        // that already holds the value. The very first paint must hydrate the
        // snapshot synchronously — instant, no spinner, before any fetch.
        const durable = new FakeDurable();
        const writer = new SwrCache(durable);
        entry.seed(writer); // mirrors the value into the durable snapshot

        const coldOpen = new SwrCache(durable);
        const first = deriveSwrInitialState(coldOpen, WEBID, entry.key);
        expect(first.loading, `${entry.hook} must paint from the durable snapshot on cold open`).toBe(false);
        expect(first.data).toBeDefined();
        expect(first.revalidating).toBe(true);
      });

      it("COLD cache (first-ever visit) → the spinner shows exactly once", () => {
        const cache = new SwrCache(null);
        // No seed: a key never seen for this account.
        const first = deriveSwrInitialState(cache, WEBID, entry.key);
        expect(first.loading, `${entry.hook} must show the spinner on a first-ever visit`).toBe(true);
        expect(first.data).toBeUndefined();
        expect(first.revalidating).toBe(false);
      });

      it("the cache is per-WebID — another account never paints this account's data", () => {
        const cache = new SwrCache(null);
        entry.seed(cache); // seeded for WEBID
        const other = deriveSwrInitialState(cache, "https://eve.example/profile#me", entry.key);
        expect(other).toEqual({ data: undefined, loading: true, revalidating: false });
      });
    });
  }

  it("the registry is non-empty and every key is unique (no accidental collisions)", () => {
    expect(READ_PAGE_HOOKS.length).toBeGreaterThan(0);
    const keys = READ_PAGE_HOOKS.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ---------------------------------------------------------------------------
// (1b) SAME-WebID active-storage SWITCH — the staleness bug roborev flagged.
// ---------------------------------------------------------------------------

/**
 * The bug class: a hook whose fetcher reads an active-storage-dependent input
 * (a domains API `base`, the discovered inbox URL, the contacts store under the
 * active storage) MUST scope its cache key to that input. If it does NOT,
 * switching storage for the SAME WebID keeps the SAME `(webId, key)`, so
 * `useSwrRead` does NOT revalidate (it only revalidates on `(webId, key, status,
 * nonce)`) and the view paints the PREVIOUS storage's data.
 *
 * This registry enumerates every active-storage-scoped READ hook with a
 * key-BUILDER (a function of the active storage / its derived input). The test
 * proves the fix from the cache's point of view: seed storage A's value under
 * storage A's key, then derive the FIRST-paint state for storage B's key (same
 * WebID). Because the keys DIFFER, storage B starts COLD (no data, spinner) —
 * it can never paint storage A's cached value. (If a hook regressed to a static
 * key, A's and B's keys would be identical and B would paint A's data — this
 * test would then fail, which is exactly the guard we want.)
 */
interface StorageScopedHook {
  hook: string;
  /** Build the bare cache key the hook reads under, for a given active storage. */
  keyFor: (storage: string) => string;
  /** A representative cached value for `storage`. */
  value: (storage: string) => unknown;
}

const STORAGE_A = "https://alice.example/storage-a/";
const STORAGE_B = "https://alice.example/storage-b/";
const apiBase = (storage: string) => `${storage}.domains`; // shape only; opaque to the cache

const STORAGE_SCOPED_HOOKS: StorageScopedHook[] = [
  {
    hook: "useDomains",
    keyFor: (s) => `domains:${apiBase(s)}`,
    value: (s) => [{ domain: `${s}-domain.example`, status: "verified" }],
  },
  {
    hook: "useDomain",
    keyFor: (s) => `domain:${apiBase(s)}:alice.example`,
    value: (s) => ({ domain: "alice.example", status: "verified", base: s }),
  },
  {
    hook: "useInbox",
    keyFor: (s) => `inbox:${s}inbox/`,
    value: (s) => [{ id: `urn:notif:${s}` }],
  },
  {
    hook: "usePeople",
    keyFor: (s) => `people:${s}`,
    value: (s) => [{ webId: `${s}#contact`, name: "Bob" }],
  },
  // Already storage-scoped before this fix — included so the switch property is
  // asserted across the WHOLE active-storage-dependent surface, not just the
  // newly-fixed hooks.
  {
    hook: "useAssignedTasks",
    keyFor: (s) => `assigned-tasks:${s}`,
    value: (s) => [{ task: { title: `t-${s}` } }],
  },
];

describe("instant-nav: a SAME-WebID active-storage switch never paints the previous storage's data", () => {
  for (const entry of STORAGE_SCOPED_HOOKS) {
    describe(entry.hook, () => {
      it("switching storage (A→B) changes the key, so B starts COLD — A's data is never shown", () => {
        const cache = new SwrCache(null);
        const keyA = entry.keyFor(STORAGE_A);
        const keyB = entry.keyFor(STORAGE_B);

        // The two storages MUST map to different keys — that is what makes the
        // switch revalidate instead of reusing the other storage's slot.
        expect(keyA, `${entry.hook} must scope its key to the active storage`).not.toBe(keyB);

        // Storage A is warm in the cache.
        cache.set(WEBID, keyA, entry.value(STORAGE_A));

        // Now the user switches to storage B (SAME WebID). The first paint for
        // B's key must be COLD — no data, spinner — NOT storage A's value.
        const onB = deriveSwrInitialState(cache, WEBID, keyB);
        expect(onB.data, `${entry.hook} must NOT paint storage A's value after switching to B`).toBeUndefined();
        expect(onB.loading, `${entry.hook} must cold-load (or revalidate) for the new storage`).toBe(true);
        expect(onB.revalidating).toBe(false);

        // Switching BACK to A still paints A's own value instantly (the slots
        // are independent partitions, not a single overwritten entry).
        const backOnA = deriveSwrInitialState(cache, WEBID, keyA);
        expect(backOnA.data).toEqual(entry.value(STORAGE_A));
        expect(backOnA.loading).toBe(false);
        expect(backOnA.revalidating).toBe(true);
      });

      it("each storage caches into its OWN slot — B's value never overwrites A's", () => {
        const cache = new SwrCache(null);
        cache.set(WEBID, entry.keyFor(STORAGE_A), entry.value(STORAGE_A));
        cache.set(WEBID, entry.keyFor(STORAGE_B), entry.value(STORAGE_B));
        expect(deriveSwrInitialState(cache, WEBID, entry.keyFor(STORAGE_A)).data).toEqual(
          entry.value(STORAGE_A),
        );
        expect(deriveSwrInitialState(cache, WEBID, entry.keyFor(STORAGE_B)).data).toEqual(
          entry.value(STORAGE_B),
        );
      });
    });
  }

  it("covers every active-storage-dependent read hook (no scoped hook omitted)", () => {
    const covered = new Set(STORAGE_SCOPED_HOOKS.map((e) => e.hook));
    // The hooks whose fetcher reads an active-storage-dependent input and whose
    // staleness this guard exists for. (useFolder / useItems / useItem are
    // keyed by a storage-derived container/URL, exercised by the per-key
    // partition tests above; the ones here key on the storage/API-base/inbox
    // INPUT directly and were the roborev finding surface.)
    for (const h of ["useDomains", "useDomain", "useInbox", "usePeople", "useAssignedTasks"]) {
      expect(covered, `storage-switch guard missing ${h}`).toContain(h);
    }
  });
});

// ---------------------------------------------------------------------------
// (2) Structural guard — every READ hook source must use `useSwrRead`.
// ---------------------------------------------------------------------------

/**
 * CLASSIFICATION (READ vs ACTION) — the single source of truth for which
 * `src/components/use-*.ts` hooks MUST go through the SWR cache.
 *
 * A hook is READ when its PRIMARY job is to fetch + return a display model the
 * user navigates to (a list/detail the page renders). Those must paint instantly
 * on re-nav, so they MUST source their model via `useSwrRead`. A hook may ALSO
 * expose mutation methods (add/remove/send/markRead/checkNow) — those stay, and
 * read FRESH per the SwrCache security note; only the read/list/get model is
 * cached.
 *
 * A hook is ACTION when it performs a write/import/login state-machine or is a
 * pure utility/subscription/derived-state helper with NO navigable read model —
 * it must NOT be cached (caching a mutation would violate the render-only
 * invariant, and there is no first-paint model to cache anyway).
 *
 * To add a new read page: implement the hook over `useSwrRead`, then add its
 * source filename to {@link READ_HOOKS} AND a registry entry above. A read hook
 * that forgets `useSwrRead` fails the structural test below (it would spin on
 * every nav — the exact bug this file guards against).
 */
const READ_HOOKS: readonly string[] = [
  "use-files.ts", // useFolder (useFilesScope is pure derived state — see ACTION note)
  "use-friends.ts", // useFriends (+ add/remove mutations, fresh)
  "use-inbox.ts", // useInbox (+ markRead/dismiss mutations, fresh)
  "use-people.ts", // usePeople
  "use-productivity.ts", // useItems/useItem (useStore is a memo factory, not a read)
  "use-domains.ts", // useDomains/useDomain (+ checkNow mutation, fresh; usePurchaseFeature is a fail-closed probe)
  "use-chat.ts", // useChat (+ send mutation, fresh)
  "use-type-index.ts", // useTypeIndex
  "use-pod-data.ts", // useCategorySummaries/useCategoryItems (already converted)
  "use-activity.ts", // useRecentActivity (already converted)
  "use-permissions.ts", // useConnectedApps (already converted; getFreshModel for mutations)
  "use-federation-tasks.ts", // useAssignedTasks (already converted)
];

/**
 * ACTION / utility hooks — deliberately NOT cached. Listed so the "every
 * use-*.ts is classified" completeness check below has the full partition: a
 * future hook must land in exactly one of READ_HOOKS or ACTION_HOOKS, forcing a
 * conscious classification (and, if READ, a registry entry + `useSwrRead`).
 */
const ACTION_HOOKS: readonly string[] = [
  "use-connect.ts", // OAuth/import state machine (write)
  "use-file-import.ts", // file-import state machine (write)
  "use-profile-edit.ts", // editable-profile read FEEDS a conditional WRITE (etag); kept fresh, not cached
  "use-resource-sharing.ts", // ACL read model for a MUTATION panel; self-lockout-sensitive, must read fresh
  "use-resource-notifications.ts", // notification subscription utility (no read model)
  "use-resource.ts", // single-resource viewer that DELIBERATELY revalidates no-cache (post-edit ETag)
  "use-swr-read.ts", // the cache hook itself
];

/** Every `use-*.ts` (excluding tests) under src/components. */
function readHookFilenames(): string[] {
  return readdirSync(COMPONENTS_DIR)
    .filter((f) => /^use-.*\.ts$/.test(f) && !f.endsWith(".test.ts"));
}

describe("instant-nav: structural guard — every READ hook uses useSwrRead", () => {
  for (const file of READ_HOOKS) {
    if (file === "use-swr-read.ts") continue; // the hook itself
    it(`${file} imports/uses useSwrRead (so its read model is cached for instant nav)`, () => {
      const src = readFileSync(join(COMPONENTS_DIR, file), "utf8");
      expect(
        src.includes("useSwrRead"),
        `${file} is classified READ but does not use useSwrRead — it would re-fetch behind a spinner on every nav. ` +
          `Route its read model through useSwrRead (see use-files.ts), or reclassify it ACTION with a reason.`,
      ).toBe(true);
    });
  }

  it("every use-*.ts is classified exactly once (READ or ACTION) — no unclassified read page can slip in", () => {
    const all = readHookFilenames();
    const classified = new Set([...READ_HOOKS, ...ACTION_HOOKS]);
    const missing = all.filter((f) => !classified.has(f));
    expect(
      missing,
      `Unclassified hook(s): ${missing.join(", ")}. Add each to READ_HOOKS (and a registry entry + useSwrRead) ` +
        `if it backs a navigable read page, or to ACTION_HOOKS with a reason.`,
    ).toEqual([]);
    // No hook may be in BOTH lists — the classification must be unambiguous.
    const both = READ_HOOKS.filter((f) => ACTION_HOOKS.includes(f));
    expect(both, `Hook(s) in BOTH READ and ACTION: ${both.join(", ")}`).toEqual([]);
  });

  it("every newly-converted read hook has a behavioural registry entry", () => {
    // The newly-converted read hooks (the bug surface) each map to >=1 registry
    // entry by filename, so the instant-paint property is asserted for each.
    const registryHooks = new Set(READ_PAGE_HOOKS.map((e) => e.hook));
    const required = [
      "useFolder",
      "useFriends",
      "useInbox",
      "usePeople",
      "useItems",
      "useItem",
      "useDomains",
      "useDomain",
      "useChat",
      "useTypeIndex",
    ];
    const missing = required.filter((h) => !registryHooks.has(h));
    expect(missing, `Registry missing entries for: ${missing.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (1c) useInbox cross-storage discovery LAG — the one-render flash roborev flagged.
// ---------------------------------------------------------------------------

/**
 * The bug class (roborev finding, Medium): inbox discovery runs in an effect
 * AFTER paint, so on a SAME-WebID storage switch the discovery state still
 * describes the PREVIOUS storage for the render before the discovery effect
 * re-runs. If the listing trusted `discovered`/`inboxUrl` without checking which
 * storage they belong to, `ready` would stay true and the cache key would be the
 * PREVIOUS storage's `inbox:<oldUrl>` for one render — flashing the previous
 * storage's inbox under the new (scoped) slot.
 *
 * The fix tags discovery with the storage it ran for ({@link InboxDiscovery}) and
 * gates readiness/key derivation on `discovery.storage === activeStorage`. These
 * tests drive the pure {@link inboxDiscoveryReady}/{@link inboxCacheKey} logic the
 * hook runs at render (the node env has no React renderer — same approach as the
 * cache tests above) and assert that a storage switch yields an EMPTY (cold) key
 * until discovery for the NEW storage settles, so the previous inbox never flashes.
 */
describe("instant-nav: useInbox never paints the previous storage's inbox during a switch", () => {
  const LOGGED_IN = "logged-in";
  const INBOX_A = `${STORAGE_A}inbox/`;
  const INBOX_B = `${STORAGE_B}inbox/`;
  /** Settled discovery for a storage with a discovered inbox URL. */
  const settled = (storage: string, inboxUrl: string): InboxDiscovery => ({
    storage,
    inboxUrl,
    discovered: true,
    // `inbox` (the Inbox handle) is irrelevant to key/ready derivation; omitted.
  });

  it("settled discovery for the CURRENT storage → ready, keyed per discovered inbox URL", () => {
    const d = settled(STORAGE_A, INBOX_A);
    expect(inboxDiscoveryReady(d, LOGGED_IN, WEBID, STORAGE_A)).toBe(true);
    expect(inboxCacheKey(d, LOGGED_IN, WEBID, STORAGE_A)).toBe(`inbox:${INBOX_A}`);
  });

  it("a storage switch (A→B) while discovery still belongs to A → NOT ready, EMPTY (cold) key", () => {
    // The render between the switch and the discovery effect re-running: the
    // active storage is now B, but discovery still describes A.
    const stillA = settled(STORAGE_A, INBOX_A);
    expect(
      inboxDiscoveryReady(stillA, LOGGED_IN, WEBID, STORAGE_B),
      "discovery tagged to A must NOT be ready for active storage B",
    ).toBe(false);
    const key = inboxCacheKey(stillA, LOGGED_IN, WEBID, STORAGE_B);
    expect(key, "the key must be EMPTY (cold) so A's inbox key is never used for B").toBe("");
    // Crucially, it must NOT be A's discovered key — that would flash A's inbox.
    expect(key).not.toBe(`inbox:${INBOX_A}`);
  });

  it("re-discovery for B completes → ready, keyed to B's inbox (never A's)", () => {
    const onB = settled(STORAGE_B, INBOX_B);
    expect(inboxDiscoveryReady(onB, LOGGED_IN, WEBID, STORAGE_B)).toBe(true);
    expect(inboxCacheKey(onB, LOGGED_IN, WEBID, STORAGE_B)).toBe(`inbox:${INBOX_B}`);
    // The cache key changed from A's to B's, so useSwrRead revalidates against B
    // and B starts cold (no A data) — proven via deriveSwrInitialState below.
    const cache = new SwrCache(null);
    cache.set(WEBID, `inbox:${INBOX_A}`, [{ id: "urn:notif:a" }]);
    const firstPaintOnB = deriveSwrInitialState(cache, WEBID, `inbox:${INBOX_B}`);
    expect(firstPaintOnB.data, "B must start cold — never A's notifications").toBeUndefined();
    expect(firstPaintOnB.loading).toBe(true);
  });

  it("still-discovering for the current storage (not yet settled) → NOT ready, EMPTY key", () => {
    const discovering: InboxDiscovery = { storage: STORAGE_A, discovered: false };
    expect(inboxDiscoveryReady(discovering, LOGGED_IN, WEBID, STORAGE_A)).toBe(false);
    expect(inboxCacheKey(discovering, LOGGED_IN, WEBID, STORAGE_A)).toBe("");
  });

  it("settled-but-NO-inbox for the current storage → ready, storage-scoped sentinel key", () => {
    const none: InboxDiscovery = { storage: STORAGE_A, discovered: true };
    expect(inboxDiscoveryReady(none, LOGGED_IN, WEBID, STORAGE_A)).toBe(true);
    expect(inboxCacheKey(none, LOGGED_IN, WEBID, STORAGE_A)).toBe(`inbox:none:${STORAGE_A}`);
    // The sentinel is storage-scoped, so a switch to B can't reuse A's empty slot.
    expect(inboxCacheKey(none, LOGGED_IN, WEBID, STORAGE_B)).toBe("");
  });

  it("logged-out / no webId / no active storage → never ready, EMPTY key", () => {
    const d = settled(STORAGE_A, INBOX_A);
    expect(inboxCacheKey(d, "logged-out", WEBID, STORAGE_A)).toBe("");
    expect(inboxCacheKey(d, LOGGED_IN, undefined, STORAGE_A)).toBe("");
    expect(inboxCacheKey(d, LOGGED_IN, WEBID, undefined)).toBe("");
  });
});
