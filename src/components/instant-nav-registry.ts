// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * SHARED test fixture — the single source of truth for the read-page "instant
 * nav" registry, imported by BOTH `instant-nav.test.ts` (the instant-paint +
 * structural guards) AND `instant-nav-prefetch.test.ts` (the proactive-prefetch
 * completeness guard).
 *
 * It lives in a NON-test module so the two suites share ONE registry without
 * either re-running the other's `describe` blocks (importing a `*.test.ts` would
 * execute its tests twice). A new read page is added HERE once; both guards then
 * see it automatically — so a page added without instant-nav wiring OR without a
 * prefetch target breaks the build (roborev finding, Low: the prefetch guard read
 * a hard-coded list, not the registry).
 *
 * This is test-support data only (sample keys + seed closures); it ships nothing
 * to the app bundle (no app module imports it).
 */

import type { SwrCache } from "@/lib/swr-cache";

/** The representative WebID every registry seed/key is scoped to. */
export const WEBID = "https://alice.example/profile#me";
/** The representative active storage the storage-scoped keys are built from. */
export const STORAGE = "https://alice.example/storage/";

/**
 * One read-page hook's entry in the registry: the bare cache key it reads under
 * (WebID-partitioned by `useSwrRead`, so we seed the bare key), and a function
 * that seeds a representative cached value into a test cache. Adding a read page
 * = adding an entry here (and to `READ_HOOKS` in instant-nav.test.ts).
 */
export interface ReadPageHook {
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
 * keep it in lockstep with `READ_HOOKS` (instant-nav.test.ts).
 */
export const READ_PAGE_HOOKS: ReadPageHook[] = [
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
    // Storage-scoped (`connected-apps:<storage>`): the model is THIS storage's ACL
    // grants, so a SAME-WebID storage switch must change the key and revalidate
    // rather than paint the previous pod's permissions (roborev finding, Medium).
    key: `connected-apps:${STORAGE}`,
    seed: (c) => c.set(WEBID, `connected-apps:${STORAGE}`, { apps: [], ctx: {} }),
  },
  {
    hook: "useAssignedTasks",
    page: "/tasks (assigned-to-me)",
    key: `assigned-tasks:${STORAGE}`,
    seed: (c) => c.set(WEBID, `assigned-tasks:${STORAGE}`, [{ task: { title: "t" } }]),
  },
];

/**
 * PER-ROUTE-PARAM detail hooks that PROACTIVE PREFETCH intentionally does NOT
 * warm — they key on a specific id/url the user PICKS at navigation time (a
 * folder path, an item URL, a single domain, a chat container, a category id),
 * so there is no single "likely next" slot to warm ahead of the click; they are
 * warmed on demand by their own `useSwrRead` when the user navigates to them.
 *
 * The prefetch completeness guard derives "hooks prefetch must warm" =
 * {@link READ_PAGE_HOOKS} MINUS this set. Adding a NEW read page therefore forces
 * a CONSCIOUS choice: give it a prefetch target, or exempt it here with a reason —
 * it can never silently slip past the guard (roborev finding, Low).
 * `useCategorySummaries`/`useCategoryItems` back the same My-data surface; the
 * SUMMARIES are prefetched (the list the user lands on), the per-category ITEMS
 * are the route-param drill-down, hence exempt.
 */
export const PREFETCH_EXEMPT_HOOKS: ReadonlySet<string> = new Set([
  "useFolder", // a specific container path the user opens
  "useItem", // a single productivity item by URL
  "useDomain", // a single domain binding by name
  "useChat", // a specific chat container the user opens
  "useCategoryItems", // a category's items by route id (summaries ARE prefetched)
]);
