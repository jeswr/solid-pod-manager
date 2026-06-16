// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * PROACTIVE PREFETCH (PM #65 Phase 2) — after the user lands on Home (logged
 * in) and the app goes idle, warm the shared {@link SwrCache} for the pages the
 * user is likely to visit next, so navigating to ANY read page is INSTANT (the
 * data is already in the cache, `loading:false`, no spinner) on the FIRST visit.
 *
 * This builds DIRECTLY on the cache-first SWR layer ({@link file://./swr-cache.ts}):
 * a prefetch is nothing more than running a read page's EXACT fetcher and calling
 * `cache.set(webId, key, value)` for the SAME `(webId, key)` the page's
 * {@link useSwrRead} hook reads under. A subsequent `useSwrRead` for that page
 * then takes the warm path on its first render — instant paint + a silent
 * background revalidate — exactly as if the user had already visited it.
 *
 * SINGLE SOURCE OF TRUTH (no duplicated fetch logic): every prefetch target is
 * reconstructed from the SAME library functions and key formulas the read hooks
 * use. The discovery-chain readers (`loadCategorySummaries`, `loadRecentActivity`,
 * `loadConnectedApps`) are imported from their hook modules; the per-store /
 * per-domain / per-people fetchers call the same `listFolder` /
 * `productivityStore.list()` / `listDomains` / `contactsStore` /
 * `discoverAssignedTasks` / `inboxFor` entry points the hooks call. The key
 * strings are built the same way the hooks build them (and the
 * `instant-nav-prefetch.test.ts` asserts the keys match the registry one-to-one,
 * so a drift breaks the build).
 *
 * INVARIANT (unchanged): the cache is a RENDER-SPEED optimisation ONLY. Prefetch
 * only WARMS the render cache; it never makes the cache authoritative and never
 * changes `useSwrRead`/`swr-cache` semantics. Mutations still read FRESH. A
 * prefetch is scoped to the active WebID + active storage, isolated per target
 * (one page's failure never sinks the others), and skipped entirely when not
 * logged-in / no storage / offline-erroring.
 */

import { readCache, type SwrCache } from "./swr-cache.js";
import { loadCategorySummaries } from "@/components/use-pod-data";
import { loadRecentActivity } from "@/components/use-activity";
import { loadConnectedApps } from "@/components/use-permissions";
import { freshRdf } from "./rdf-read.js";
import { profileDocUrl } from "./profile-edit.js";
import { readKnows } from "./social.js";
import { readProfile } from "./profile.js";
import { listAllRegistrations } from "./type-index-manage.js";
import { contactsStore } from "./contacts.js";
import { buildPeopleOptions } from "./people-search.js";
import { listDomains, domainsApiBase } from "./domains.js";
import { assignedTasksKey } from "./durable-cache.js";
import { discoverAssignedTasks } from "./federation-tasks.js";
import { inboxFor } from "./inbox.js";
import { listFolder, asContainerUrl } from "./files.js";
import type { ProductivityStore } from "./productivity-store.js";
import { notesStore } from "./notes.js";
import { calendarStore } from "./calendar.js";
import { bookmarksStore } from "./bookmarks.js";
import { tasksStore } from "./tasks.js";
import { issuesStore } from "./issues.js";

/**
 * The minimal session slice a prefetch needs — the exact inputs the read hooks
 * read off `useSession()`. A NON-REACT caller (and the orchestrator) reconstructs
 * every key + fetcher from this.
 */
export interface PrefetchContext {
  /** The active WebID (the cache partition + the fetcher argument). */
  webId: string;
  /** The chosen storage the storage-scoped pages read from. */
  activeStorage?: string;
  /** All of the user's storages (chat scopes against all of them). */
  storages?: readonly string[];
}

/**
 * One prefetch target: a cache `key` (the SAME `(webId,key)` slot the page's
 * `useSwrRead` reads) and the `fetch` that produces the value to warm it with.
 * `fetch` receives the WebID (mirroring the hook fetcher's `(webId) => …`
 * signature). `label` is for diagnostics/tests only.
 */
export interface PrefetchTarget {
  /** Diagnostic name of the page/hook this warms (e.g. `"useFriends"`). */
  label: string;
  /** The cache key — identical to the page hook's `(webId, key)` key. */
  key: string;
  /** Run the page's read (the SAME library call the hook makes). */
  fetch: (webId: string) => Promise<unknown>;
}

/**
 * The productivity stores Home is likely to drill into — the SAME factories the
 * pages bind via `useStore(...)`. Each yields a `productivity:<container>` target
 * keyed exactly as {@link file://../components/use-productivity.ts useItems} keys it.
 * Listed by factory (not hard-coded container URLs) so the container is always
 * derived the same way the store derives it (`new URL(slug, podRoot)`).
 */
const PRODUCTIVITY_STORE_FACTORIES: ReadonlyArray<{
  label: string;
  factory: (opts: { podRoot: string; webId: string }) => ProductivityStore<unknown>;
}> = [
  { label: "notes", factory: notesStore as never },
  { label: "calendar", factory: calendarStore as never },
  { label: "bookmarks", factory: bookmarksStore as never },
  { label: "tasks", factory: tasksStore as never },
  { label: "issues", factory: issuesStore as never },
  // Contacts use the same productivity-store list path; the contacts STORE is
  // also the input to usePeople, prefetched separately under `people:<storage>`.
];

/**
 * Build the SYNCHRONOUS prefetch targets for a logged-in context — every read
 * page whose key + fetcher can be reconstructed without an async discovery step.
 * (The inbox needs an async `inboxFor` discovery first, so it is added by
 * {@link discoverInboxTarget} in the orchestrator's async path.)
 *
 * Returns `[]` when there is no WebID (nothing to scope to). Storage-scoped
 * targets are included only when an `activeStorage` is known — matching each
 * hook's own "empty key until storage is set" gate, so we never warm a slot the
 * hook would never read.
 */
export function buildPrefetchTargets(ctx: PrefetchContext): PrefetchTarget[] {
  const { webId, activeStorage } = ctx;
  if (!webId) return [];

  const targets: PrefetchTarget[] = [];

  // --- WebID-scoped, storage-independent (always safe to warm). ---

  // useFriends — `friends`
  targets.push({
    label: "useFriends",
    key: "friends",
    fetch: async (id) => {
      const { dataset } = await freshRdf(profileDocUrl(id));
      return readKnows(id, dataset);
    },
  });

  // useTypeIndex — `type-index`
  targets.push({
    label: "useTypeIndex",
    key: "type-index",
    fetch: async (id) => {
      const { dataset } = await freshRdf(profileDocUrl(id));
      return listAllRegistrations(id, dataset);
    },
  });

  // useCategorySummaries — `category-summaries` (the SAME exported fetcher).
  targets.push({
    label: "useCategorySummaries",
    key: "category-summaries",
    fetch: (id) => loadCategorySummaries(id),
  });

  // useRecentActivity — `recent-activity` (the SAME exported fetcher).
  targets.push({
    label: "useRecentActivity",
    key: "recent-activity",
    fetch: (id) => loadRecentActivity(id),
  });

  // --- Storage-scoped (only when a storage is chosen). ---

  if (activeStorage) {
    // useConnectedApps — `connected-apps` (the SAME exported fetcher).
    targets.push({
      label: "useConnectedApps",
      key: "connected-apps",
      fetch: (id) => loadConnectedApps(id, activeStorage),
    });

    // usePeople — `people:<activeStorage>`
    targets.push({
      label: "usePeople",
      key: `people:${activeStorage}`,
      fetch: async (id) => {
        const store = contactsStore({ podRoot: activeStorage, webId: id });
        const [items, friends] = await Promise.all([
          store.list().catch(() => []),
          (async () => {
            try {
              const { dataset } = await freshRdf(profileDocUrl(id));
              return readKnows(id, dataset);
            } catch {
              return [] as string[];
            }
          })(),
        ]);
        const contacts = items
          .map((i) => ({ webId: i.data.webId ?? "", name: i.data.fn, email: i.data.email }))
          .filter((c) => c.webId);
        return buildPeopleOptions({ contacts, friends });
      },
    });

    // useDomains — `domains:<base>` (base = the active storage's API origin).
    const base = domainsApiBase(activeStorage);
    targets.push({
      label: "useDomains",
      key: `domains:${base}`,
      fetch: () => listDomains(base),
    });

    // useAssignedTasks — `assigned-tasks:<activeStorage>`
    targets.push({
      label: "useAssignedTasks",
      key: assignedTasksKey(activeStorage),
      fetch: async (id) => {
        const { dataset } = await freshRdf(id);
        const myProfile = readProfile(id, dataset);
        const contacts = await contactsStore({ podRoot: activeStorage, webId: id }).list();
        const contactWebIds = contacts
          .map((c) => c.data.webId)
          .filter((w): w is string => Boolean(w));
        return discoverAssignedTasks({
          myWebId: id,
          myProfile,
          myProfileDataset: dataset,
          contactWebIds,
        });
      },
    });

    // useFolder (the files browser ROOT container) — `files:<rootContainer>`.
    // Home is most likely to be followed by opening the files root; deeper
    // folders are warmed on demand by the page's own SWR read.
    const root = asContainerUrl(activeStorage);
    targets.push({
      label: "useFolder(root)",
      key: `files:${root}`,
      fetch: () => listFolder(root),
    });

    // useItems for each productivity store — `productivity:<container>`.
    for (const { label, factory } of PRODUCTIVITY_STORE_FACTORIES) {
      const store = factory({ podRoot: activeStorage, webId });
      targets.push({
        label: `useItems(${label})`,
        key: `productivity:${store.container}`,
        fetch: () => store.list(),
      });
    }
  }

  return targets;
}

/**
 * The inbox prefetch target, which needs an async `inboxFor` discovery first
 * (the inbox container is active-storage-dependent). Mirrors `useInbox`: derives
 * the discovered URL, keys `inbox:<inboxUrl>` (or the storage-scoped
 * `inbox:none:<storage>` sentinel when there is no inbox), and warms it from the
 * live `inbox.list()`. Returns `null` when there is nothing to warm (no storage,
 * or discovery failed) — the orchestrator simply skips it.
 */
export async function discoverInboxTarget(
  ctx: PrefetchContext,
): Promise<PrefetchTarget | null> {
  const { webId, activeStorage } = ctx;
  if (!webId || !activeStorage) return null;
  const inbox = await inboxFor({ webId, activeStorage }).catch(() => undefined);
  // Match `inboxCacheKey`: discovered URL → `inbox:<url>`, else the
  // storage-scoped no-inbox sentinel so the empty list still warms its slot.
  const key = inbox?.inboxUrl
    ? `inbox:${inbox.inboxUrl}`
    : `inbox:none:${activeStorage}`;
  return {
    label: "useInbox",
    key,
    fetch: () => (inbox ? inbox.list() : Promise.resolve([])),
  };
}

/** Options for {@link runPrefetch} (test seams; all optional in production). */
export interface RunPrefetchOptions {
  /** The cache to warm; defaults to the shared {@link readCache}. */
  cache?: SwrCache;
  /**
   * Also run the async inbox discovery + warm its slot. On by default; tests
   * that only want the synchronous targets can turn it off.
   */
  includeInbox?: boolean;
}

/** A per-target prefetch outcome (for diagnostics + tests). */
export interface PrefetchOutcome {
  label: string;
  key: string;
  /** `"warmed"` if the value landed in the cache, `"failed"` if the fetch threw. */
  status: "warmed" | "failed";
  error?: unknown;
}

/**
 * Warm the cache for every prefetch target of `ctx`. Resolves to a per-target
 * outcome list. Resilient by construction:
 *
 *   - A single target's fetch rejection is ISOLATED (`Promise.allSettled`): it is
 *     recorded as `failed` and NEVER warms (nor clears) its slot, and never
 *     prevents the other targets from warming. A page that errors offline just
 *     gets skipped — its `useSwrRead` will cold-load when the user navigates.
 *   - Only WARMS — never invalidates, never clears. A target that resolves
 *     `undefined` is treated as nothing-to-warm (matches `SwrCache.set`/durable
 *     ignoring `undefined`), so a failed-but-resolved read can't blank a slot.
 *   - Scoped to `ctx.webId`: every value is set under `(ctx.webId, key)`, so a
 *     prefetch can never warm another account's partition.
 *
 * This does NOT touch `useSwrRead`/`swr-cache` semantics: it calls the public
 * `cache.set` exactly as a completed read would, so a warmed slot is
 * indistinguishable from one filled by an actual visit.
 */
export async function runPrefetch(
  ctx: PrefetchContext,
  options: RunPrefetchOptions = {},
): Promise<PrefetchOutcome[]> {
  const cache = options.cache ?? readCache;
  const includeInbox = options.includeInbox ?? true;
  if (!ctx.webId) return [];

  const targets = buildPrefetchTargets(ctx);
  if (includeInbox) {
    // Discovery is itself best-effort — a failure just drops the inbox target.
    const inboxTarget = await discoverInboxTarget(ctx).catch(() => null);
    if (inboxTarget) targets.push(inboxTarget);
  }

  const settled = await Promise.allSettled(
    targets.map(async (t): Promise<PrefetchOutcome> => {
      try {
        const value = await t.fetch(ctx.webId);
        // Only warm a real value. `undefined` means "nothing to show" — set()
        // would no-op the durable write anyway; skip to keep the slot cold so a
        // later cold-load is honest rather than caching an empty placeholder.
        if (value === undefined) return { label: t.label, key: t.key, status: "failed" };
        cache.set(ctx.webId, t.key, value);
        return { label: t.label, key: t.key, status: "warmed" };
      } catch (error) {
        // Isolated: this page just won't be pre-warmed; its useSwrRead cold-loads.
        return { label: t.label, key: t.key, status: "failed", error };
      }
    }),
  );

  // allSettled never rejects here (the map body catches), so every result is
  // fulfilled; unwrap to the outcome list.
  return settled.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : { label: "unknown", key: "", status: "failed", error: r.reason },
  );
}
