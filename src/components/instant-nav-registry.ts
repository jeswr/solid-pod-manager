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
import { domainsApiBase } from "@/lib/domains";

/** The representative WebID every registry seed/key is scoped to. */
export const WEBID = "https://alice.example/profile#me";
/** The representative active storage the storage-scoped keys are built from. */
export const STORAGE = "https://alice.example/storage/";
/**
 * The domains API base for {@link STORAGE} — built with the SAME `domainsApiBase`
 * the `useDomains`/`useDomain` hooks use (the API ORIGIN, not the raw storage
 * URL), so the registry seeds the slot the hooks actually read. Keying it the raw
 * STORAGE would seed a slot the hooks never touch and let domain coverage pass
 * while the real key is broken (roborev finding, Low).
 */
const DOMAINS_BASE = domainsApiBase(STORAGE);

/**
 * One read-page hook's entry in the registry: the bare cache key it reads under
 * (WebID-partitioned by `useSwrRead`, so we seed the bare key), and a function
 * that seeds a representative cached value into a test cache. Adding a read page
 * = adding an entry here (and to `READ_HOOKS` in instant-nav.test.ts).
 */
export interface ReadPageHook {
  /** The hook export name (documentation + failure messages). */
  hook: string;
  /**
   * The `use-*.ts` source file this hook lives in. Ties each registry entry back
   * to a `READ_HOOKS` source-file entry (instant-nav.test.ts) so the structural
   * guard can assert EVERY read source file has at least one registry entry — a
   * read hook added to READ_HOOKS without a registry entry then breaks the build
   * (roborev finding, Medium: the registry-coverage guard read a hard-coded list).
   */
  source: string;
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
    source: "use-files.ts",
    page: "/files",
    key: `files:${STORAGE}documents/`,
    seed: (c) => c.set(WEBID, `files:${STORAGE}documents/`, [{ url: `${STORAGE}documents/a.txt` }]),
  },
  // use-friends.ts — friend list.
  {
    hook: "useFriends",
    source: "use-friends.ts",
    page: "/people (friends)",
    key: "friends",
    seed: (c) => c.set(WEBID, "friends", ["https://bob.example/profile#me"]),
  },
  // use-inbox.ts — LDN inbox listing, keyed per DISCOVERED inbox URL (the inbox
  // container is active-storage-dependent, so the key carries the discovered URL).
  {
    hook: "useInbox",
    source: "use-inbox.ts",
    page: "/inbox",
    key: `inbox:${STORAGE}inbox/`,
    seed: (c) => c.set(WEBID, `inbox:${STORAGE}inbox/`, [{ id: "urn:notif:1" }]),
  },
  // use-people.ts — people-picker options, keyed PER ACTIVE STORAGE (the fetcher
  // reads the active storage's contacts store).
  {
    hook: "usePeople",
    source: "use-people.ts",
    page: "people-picker (/people, /contacts pickers)",
    key: `people:${STORAGE}`,
    seed: (c) =>
      c.set(WEBID, `people:${STORAGE}`, [{ webId: "https://bob.example/profile#me", name: "Bob" }]),
  },
  // use-productivity.ts — list view, keyed per store container.
  {
    hook: "useItems",
    source: "use-productivity.ts",
    page: "/notes /calendar /contacts /bookmarks /tasks /issues",
    key: `productivity:${STORAGE}notes/`,
    seed: (c) => c.set(WEBID, `productivity:${STORAGE}notes/`, [{ url: `${STORAGE}notes/1`, data: {} }]),
  },
  // use-productivity.ts — single item, keyed per item URL.
  {
    hook: "useItem",
    source: "use-productivity.ts",
    page: "/notes/edit /calendar/edit /contacts/edit /tasks/edit /issues/edit",
    key: `productivity-item:${STORAGE}notes/1`,
    seed: (c) => c.set(WEBID, `productivity-item:${STORAGE}notes/1`, { url: `${STORAGE}notes/1`, data: {} }),
  },
  // use-domains.ts — domain bindings list, keyed PER API BASE (the fetcher reads
  // from the active storage's domains API base).
  {
    hook: "useDomains",
    source: "use-domains.ts",
    page: "/settings/domains",
    key: `domains:${DOMAINS_BASE}`,
    seed: (c) =>
      c.set(WEBID, `domains:${DOMAINS_BASE}`, [{ domain: "alice.example", status: "verified" }]),
  },
  // use-domains.ts — one binding's detail, keyed PER API BASE + domain (detail
  // read AND verify POST are scoped to the base).
  {
    hook: "useDomain",
    source: "use-domains.ts",
    page: "/settings/domains/[domain]",
    key: `domain:${DOMAINS_BASE}:alice.example`,
    seed: (c) =>
      c.set(WEBID, `domain:${DOMAINS_BASE}:alice.example`, {
        domain: "alice.example",
        status: "verified",
      }),
  },
  // use-chat.ts — message listing, keyed per chat container.
  {
    hook: "useChat",
    source: "use-chat.ts",
    page: "/chat",
    key: `chat:${STORAGE}chats/general/`,
    seed: (c) => c.set(WEBID, `chat:${STORAGE}chats/general/`, [{ id: "urn:msg:1", content: "hi" }]),
  },
  // use-type-index.ts — type-index management view.
  {
    hook: "useTypeIndex",
    source: "use-type-index.ts",
    page: "/settings/type-index",
    key: "type-index",
    seed: (c) => c.set(WEBID, "type-index", { public: [], private: [] }),
  },
  // --- Already-converted read hooks (kept here so the systematic guarantee
  //     covers the WHOLE read surface, not just the newly-converted hooks). ---
  {
    hook: "useRecentActivity",
    source: "use-activity.ts",
    page: "/ (home) /activity",
    key: "recent-activity",
    seed: (c) => c.set(WEBID, "recent-activity", [{ url: "urn:entry:1" }]),
  },
  {
    hook: "useCategorySummaries",
    source: "use-pod-data.ts",
    page: "/ (home) /my-data",
    key: "category-summaries",
    seed: (c) => c.set(WEBID, "category-summaries", [{ category: { id: "notes" }, hasData: true }]),
  },
  {
    hook: "useCategoryItems",
    source: "use-pod-data.ts",
    page: "/category/[id]",
    key: "category-items:notes",
    seed: (c) => c.set(WEBID, "category-items:notes", [{ url: `${STORAGE}notes/1` }]),
  },
  {
    hook: "useConnectedApps",
    source: "use-permissions.ts",
    page: "/connected-apps",
    // Storage-scoped (`connected-apps:<storage>`): the model is THIS storage's ACL
    // grants, so a SAME-WebID storage switch must change the key and revalidate
    // rather than paint the previous pod's permissions (roborev finding, Medium).
    key: `connected-apps:${STORAGE}`,
    seed: (c) => c.set(WEBID, `connected-apps:${STORAGE}`, { apps: [], ctx: {} }),
  },
  {
    hook: "useAssignedTasks",
    source: "use-federation-tasks.ts",
    page: "/tasks (assigned-to-me)",
    key: `assigned-tasks:${STORAGE}`,
    seed: (c) => c.set(WEBID, `assigned-tasks:${STORAGE}`, [{ task: { title: "t" } }]),
  },
  {
    hook: "useAppPrefs",
    source: "use-app-prefs.ts",
    page: "/community + /settings (pod-backed app preferences, task #89)",
    // Storage-scoped (`app-prefs:<activeStorage>`): the prefs FILE is per-WebID,
    // but ENSURING/creating it on a write needs the active storage and the prefs
    // belong to that pod, so a SAME-WebID storage switch must change the key and
    // revalidate rather than paint the other storage's prefs (the active-storage
    // SWR rule). Built by `appPrefsKey`.
    key: `app-prefs:${STORAGE}`,
    seed: (c) =>
      c.set(WEBID, `app-prefs:${STORAGE}`, {
        community: {
          matrixRooms: ["#solid_project:matrix.org"],
          discourseTopicIds: [],
          includeDiscourseLatest: true,
          readMarker: {},
        },
        extra: {},
      }),
  },
  {
    hook: "useFederationMembers",
    source: "use-federation-registry.ts",
    page: "/federations (registry-asserted federation memberships)",
    // Keyed on the (URL-encoded) configured registry URL — a single build-time
    // constant, so one representative concrete key (the cache treats it as
    // opaque). A re-deploy that re-points the registry changes the key.
    key: `federation-members:${encodeURIComponent("https://registry.example/federation")}`,
    seed: (c) =>
      c.set(WEBID, `federation-members:${encodeURIComponent("https://registry.example/federation")}`, {
        members: [{ id: "https://app.example/clientid.jsonld", source: "https://registry.example/federation", membership: { app: "https://app.example/clientid.jsonld" }, trusted: true, valid: true, issues: [] }],
        valid: true,
        issues: [],
      }),
  },
  {
    hook: "useTrackerMeta",
    source: "use-tracker.ts",
    page: "/issues (wf:Tracker config-doc metadata)",
    // Keyed PER CONTAINER (`tracker:<containerUrl>`) — implicitly storage-scoped
    // since the container is derived from the active storage, so a same-WebID
    // storage switch changes the container (and the key) and revalidates against
    // the new pod rather than painting the previous pod's tracker config. The
    // value is a TrackerMeta (a parsed config) or null (no tracker configured).
    key: `tracker:${STORAGE}issues/`,
    seed: (c) =>
      c.set(WEBID, `tracker:${STORAGE}issues/`, {
        docUrl: `${STORAGE}issues/index.ttl`,
        title: "Issues",
        issueClass: "http://www.w3.org/2005/01/wf/flow#Task",
        categories: [],
        groupMembers: [],
        workflowStates: [],
      }),
  },
  {
    hook: "useCommunityFeed",
    source: "use-community.ts",
    page: "/community (Solid Community — forum + Matrix rooms)",
    // Keyed on the user's prefs snapshot + Matrix-connected flag
    // (`community:<m|_>:<latest>:<rooms>:<topics>:<marks>`), a representative
    // concrete value (the cache treats the key as opaque, so the first-paint
    // property holds for every concrete prefs digest).
    key: "community:_:1:#solid_project:matrix.org::",
    seed: (c) =>
      c.set(WEBID, "community:_:1:#solid_project:matrix.org::", {
        threads: [{ id: "discourse:t:1", source: "discourse", title: "Welcome" }],
        totalUnread: 0,
        errors: [],
      }),
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
  "useCommunityFeed", // reads THIRD-PARTY public hosts (matrix.org / forum.solidproject.org),
  // NOT the pod — warming it on app load would fire unsolicited external requests; it loads
  // on demand when the user opens /community (and is instant-nav cached thereafter)
  "useFederationMembers", // reads a THIRD-PARTY registry origin (NEXT_PUBLIC_FEDERATION_REGISTRY),
  // NOT the pod — warming it on app load would fire an unsolicited external request (and is
  // a no-op when the feature is unset); it loads on demand when the user opens /federations
  // (and is instant-nav cached thereafter), mirroring useCommunityFeed
]);
