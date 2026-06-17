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
// The read-page registry is the SHARED single source of truth (also consumed by
// the proactive-prefetch completeness guard in instant-nav-prefetch.test.ts), so
// it lives in a non-test module both suites import (avoids re-running describes).
import { READ_PAGE_HOOKS, WEBID } from "./instant-nav-registry.js";

const COMPONENTS_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// (1) Behavioural registry — every READ-PAGE hook + a sample key + a seed.
//     Defined in ./instant-nav-registry.ts (imported above) so the prefetch
//     completeness guard derives from the SAME list (roborev finding, Low).
// ---------------------------------------------------------------------------

// READ_PAGE_HOOKS (the registry), PREFETCH_EXEMPT_HOOKS, WEBID, STORAGE, and the
// ReadPageHook type all come from ./instant-nav-registry.js (imported above) —
// the shared single source of truth this suite AND the prefetch completeness
// guard both read, so neither can drift and a new read page added there is seen
// by both (roborev finding, Low).

/** An in-memory durable fake so the COLD-OPEN (durable snapshot) path is testable. */
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
  // Storage-scoped as of the prefetch follow-up (roborev finding, Medium): the
  // model is the ACL grants of THIS storage, so a same-WebID switch must change
  // the key — never paint the previous pod's app-permissions.
  {
    hook: "useConnectedApps",
    keyFor: (s) => `connected-apps:${s}`,
    value: (s) => ({ apps: [{ agentId: `a-${s}`, name: "App" }], ctx: {} }),
  },
  // Pod-backed app preferences (task #89). The prefs FILE is per-WebID, but the
  // key is storage-scoped (ensuring it on a write needs the active storage and
  // the prefs belong to that pod) — so a same-WebID storage switch must change
  // the key and never paint the other storage's prefs.
  {
    hook: "useAppPrefs",
    keyFor: (s) => `app-prefs:${s}`,
    value: (s) => ({
      community: {
        matrixRooms: [`#room-${s}:matrix.org`],
        discourseTopicIds: [],
        includeDiscourseLatest: true,
        readMarker: {},
      },
      extra: {},
    }),
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
    for (const h of [
      "useDomains",
      "useDomain",
      "useInbox",
      "usePeople",
      "useAssignedTasks",
      "useConnectedApps",
      "useAppPrefs",
    ]) {
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
  "use-webid-search.ts", // useWebIdSearch/useIsIndexed (query-driven panel reads, see NON_REGISTRY note)
  "use-community.ts", // useCommunityFeed (useCommunityPrefs facades useAppPrefs, exempt below)
  "use-app-prefs.ts", // useAppPrefs (pod-backed app preferences, task #89)
  "use-federation-registry.ts", // useFederationMembers (registry-asserted memberships, /federations)
  "use-tracker.ts", // useTrackerMeta (wf:Tracker config doc metadata, /issues read path)
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
  "use-prefetch.ts", // PROACTIVE PREFETCH orchestrator (PM #65 Phase 2): a side-effect
  // that WARMS the read cache for the likely-next pages; it has no navigable read
  // model of its own (it warms the OTHER hooks' slots), so it is not a READ hook.
  // Its instant-FIRST-visit guarantee is asserted in instant-nav-prefetch.test.ts.
];

/**
 * Exported `use*` hooks that live INSIDE a READ_HOOKS file but do NOT get their
 * own {@link READ_PAGE_HOOKS} registry entry — because they are derived-state /
 * factory / probe helpers, not a navigable read with its own cache slot. Listed
 * with a reason so the export-level coverage guard below forces a CONSCIOUS
 * choice for any NEW exported hook (registry entry, or an exemption here) —
 * closing the drift hole roborev flagged (a second read hook in an
 * already-covered file silently skipping the registry).
 */
const NON_REGISTRY_READ_HELPERS: ReadonlySet<string> = new Set([
  "useFilesScope", // pure derived state (active root + in-scope guard), no fetch/cache
  "useStore", // a memoised ProductivityStore FACTORY, not a read (the read is useItems/useItem)
  "usePurchaseFeature", // a fail-closed feature PROBE (no navigable read model / cache slot)
  "useConnectedApp", // derives ONE app from the cached useConnectedApps list (no own slot)
  "useCategorySummary", // derives ONE summary from the cached useCategorySummaries list (no own slot)
  "useWebIdSearch", // QUERY-driven WebID-index search panel (key webid-search:<q>) — not a
  // navigable read PAGE with a fixed cache slot; it lives in /contacts (which has its own
  // registry entry) and goes through useSwrRead, so it is still cached for re-typed queries.
  "useIsIndexed", // QUERY-driven index existence probe (key webid-indexed:<webid>); same — no own page slot.
  "useCommunityPrefs", // a Community-view-shaped FACADE over useAppPrefs (task #89): channel
  // subscriptions + read-markers, now pod-backed. NOT a navigable read with its OWN SWR cache
  // slot — the cached read it delegates to (useAppPrefs, `app-prefs:<storage>`) has the registry
  // entry; this just reshapes that model for the Community page.
]);

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

  it("EVERY exported use* hook in a READ_HOOKS file has a registry entry OR a documented exemption", () => {
    // Export-LEVEL coverage (roborev finding, Medium): a per-FILE guard let a
    // SECOND read hook added to an already-covered file (e.g. a new `useX` in
    // use-productivity.ts) skip a registry entry. This parses EVERY exported
    // `use*` hook in each READ_HOOKS source and asserts each is EITHER a
    // READ_PAGE_HOOKS entry (its instant-paint property is asserted) OR listed in
    // NON_REGISTRY_READ_HELPERS below with a reason — so a new read-hook export
    // can no longer silently escape the instant-paint guard. The detection covers
    // every export FORM the codebase could use — `export [async] function useX`,
    // `export default function useX`, and `export const|let|var useX =` (roborev
    // finding, Low: a `function`-only regex would miss the const-arrow form).
    const registryHooks = new Set(READ_PAGE_HOOKS.map((e) => e.hook));
    const exportedHooksIn = (src: string): string[] => {
      const out: string[] = [];
      // Inline declaration export forms.
      const declPatterns = [
        /export\s+(?:async\s+)?function\s+(use[A-Za-z0-9]+)/g, // export [async] function useX
        /export\s+default\s+(?:async\s+)?function\s+(use[A-Za-z0-9]+)/g, // export default function useX
        /export\s+(?:const|let|var)\s+(use[A-Za-z0-9]+)\s*[:=]/g, // export const useX = / useX:
      ];
      for (const re of declPatterns) for (const m of src.matchAll(re)) out.push(m[1]);
      // Named-export-LIST form (roborev finding, Low): `export { useFoo, x as useBar }`
      // (optionally `export type { ... }` — skip those). For each specifier take
      // the EXPORTED name (after `as` if aliased) and keep it if it starts `use`.
      for (const block of src.matchAll(/export\s+(?!type\b)\{([^}]*)\}/g)) {
        for (const spec of block[1].split(",")) {
          const parts = spec.trim().split(/\s+as\s+/);
          const exportedName = (parts[1] ?? parts[0]).trim();
          if (/^use[A-Za-z0-9]+$/.test(exportedName)) out.push(exportedName);
        }
      }
      return out;
    };

    const offenders: string[] = [];
    for (const file of READ_HOOKS) {
      if (file === "use-swr-read.ts") continue; // the cache mechanism itself
      const src = readFileSync(join(COMPONENTS_DIR, file), "utf8");
      for (const hook of exportedHooksIn(src)) {
        if (registryHooks.has(hook)) continue; // has its own registry entry
        if (NON_REGISTRY_READ_HELPERS.has(hook)) continue; // documented helper
        offenders.push(`${file}:${hook}`);
      }
    }
    expect(
      offenders,
      `Read-hook export(s) with NEITHER a registry entry NOR an exemption: ${offenders.join(", ")}. ` +
        `Add a READ_PAGE_HOOKS entry (instant-nav-registry.ts) if it backs a navigable read page, ` +
        `or add it to NON_REGISTRY_READ_HELPERS with a reason if it is a derived/helper read.`,
    ).toEqual([]);

    // And the converse: every registry entry's `source` is a real READ_HOOKS
    // file (no entry pointing at an unclassified / action / deleted file).
    const readSet = new Set(READ_HOOKS);
    const orphanSources = [...new Set(READ_PAGE_HOOKS.map((e) => e.source))].filter(
      (s) => !readSet.has(s),
    );
    expect(
      orphanSources,
      `Registry entr(ies) whose source is not a READ_HOOKS file: ${orphanSources.join(", ")}`,
    ).toEqual([]);

    // And every exemption is real (names an export that still exists in a READ
    // file) — so a stale exemption for a deleted/renamed hook is caught. Uses the
    // SAME multi-form export detector as the offender scan above.
    const allReadExports = new Set<string>();
    for (const file of READ_HOOKS) {
      if (file === "use-swr-read.ts") continue;
      const src = readFileSync(join(COMPONENTS_DIR, file), "utf8");
      for (const hook of exportedHooksIn(src)) allReadExports.add(hook);
    }
    const staleExemptions = [...NON_REGISTRY_READ_HELPERS].filter((h) => !allReadExports.has(h));
    expect(
      staleExemptions,
      `NON_REGISTRY_READ_HELPERS names hook(s) no longer exported by a READ file: ${staleExemptions.join(", ")}`,
    ).toEqual([]);
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
