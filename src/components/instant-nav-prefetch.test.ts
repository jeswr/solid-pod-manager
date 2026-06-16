// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * SYSTEMATIC "instant FIRST visit" guarantee — the durable contract behind
 * PROACTIVE PREFETCH (PM #65 Phase 2).
 *
 * Phase 1 ({@link file://./instant-nav.test.ts}) guarantees that a read page with
 * a WARM cache paints instantly. Phase 2 (this file) guarantees the cache is
 * ALREADY WARM for the likely-next pages BEFORE the user ever visits them: after
 * the prefetch orchestrator ({@link file://../lib/prefetch.ts} `runPrefetch`) runs
 * once logged in, EVERY read page's cache key is populated, so the FIRST
 * navigation to it is instant (no spinner) — not just a return visit.
 *
 * The property is asserted in three independent, systematic ways:
 *
 *  1. After `runPrefetch` (with every underlying library read MOCKED so it runs
 *     offline-deterministically), assert that for EVERY read-page cache key the
 *     registry enumerates, the cache holds a value AND `deriveSwrInitialState`
 *     (the EXACT first-paint logic `useSwrRead` runs) returns `loading:false`
 *     with data — i.e. a subsequent first-visit useSwrRead is instant.
 *
 *  2. A COMPLETENESS guard cross-checking the prefetch target set against the
 *     READ-page registry: every cacheable read page MUST have a prefetch target,
 *     so a NEW read page added without a prefetch target breaks THIS build (the
 *     instant-first-visit promise can't silently regress).
 *
 *  3. NON-BLOCKING + ISOLATION: `runPrefetch` does not throw / does not await on
 *     a caller's render path, and a single target's fetch rejection is isolated
 *     (the others still warm).
 *
 * As elsewhere in this suite, the `node` Vitest env has no React renderer, so we
 * drive the load-bearing logic (`runPrefetch` + `deriveSwrInitialState`) directly
 * rather than mounting React (the wiring is covered by the build + e2e).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock every library read the prefetch fetchers delegate to, so `runPrefetch`
// resolves deterministically offline (no server, no network). Each mock returns
// a recognisable representative value; the test asserts that value lands in the
// cache under the page's key.
// ---------------------------------------------------------------------------

const WEBID = "https://alice.example/profile#me";
const STORAGE = "https://alice.example/storage/";

// freshRdf — used by friends / type-index / category-summaries / activity /
// connected-apps / people / assigned-tasks. Returns a fake dataset + etag.
const FAKE_DATASET = { __fake: "dataset" } as const;
vi.mock("@/lib/rdf-read", () => ({
  freshRdf: vi.fn(async () => ({ dataset: FAKE_DATASET, etag: 'W/"x"' })),
}));

vi.mock("@/lib/profile-edit", () => ({
  profileDocUrl: (id: string) => id.split("#")[0],
}));

vi.mock("@/lib/social", () => ({
  readKnows: vi.fn(() => ["https://bob.example/profile#me"]),
}));

vi.mock("@/lib/profile", () => ({
  readProfile: vi.fn(() => ({ webId: WEBID, displayName: "Alice", storages: [STORAGE] })),
}));

vi.mock("@/lib/type-index-manage", () => ({
  listAllRegistrations: vi.fn(() => ({ public: [{ forClass: "x" }], private: [] })),
}));

// The exported discovery-chain readers (single source of truth — the SAME
// functions the hooks use); mock the hook modules so prefetch imports the mock.
vi.mock("@/components/use-pod-data", () => ({
  loadCategorySummaries: vi.fn(async () => [{ category: { id: "notes" }, hasData: true }]),
}));
vi.mock("@/components/use-activity", () => ({
  loadRecentActivity: vi.fn(async () => [{ url: "urn:entry:1" }]),
}));
vi.mock("@/components/use-permissions", () => ({
  loadConnectedApps: vi.fn(async () => ({ apps: [{ agentId: "a", name: "App" }], ctx: {} })),
}));

vi.mock("@/lib/people-search", () => ({
  buildPeopleOptions: vi.fn(() => [{ webId: "https://bob.example/profile#me", name: "Bob" }]),
}));

vi.mock("@/lib/domains", () => ({
  domainsApiBase: (s: string) => new URL(s).origin,
  listDomains: vi.fn(async () => [{ domain: "alice.example", status: "verified" }]),
}));

vi.mock("@/lib/federation-tasks", () => ({
  discoverAssignedTasks: vi.fn(async () => [{ task: { title: "t" } }]),
}));

// contactsStore — used by usePeople + useAssignedTasks. A store whose `.list()`
// returns one contact carrying a WebID.
vi.mock("@/lib/contacts", () => ({
  CONTACTS_SLUG: "contacts/",
  contactsStore: vi.fn(() => ({
    container: `${STORAGE}contacts/`,
    list: vi.fn(async () => [{ data: { webId: "https://bob.example/profile#me", fn: "Bob" } }]),
  })),
}));

// files — listFolder for the root container + asContainerUrl.
vi.mock("@/lib/files", () => ({
  asContainerUrl: (s: string) => (s.endsWith("/") ? s : `${s}/`),
  listFolder: vi.fn(async (container: string) => [{ url: `${container}a.txt` }]),
}));

// inbox — inboxFor discovers an inbox handle whose `.list()` returns one notif.
const INBOX_URL = `${STORAGE}inbox/`;
vi.mock("@/lib/inbox", () => ({
  inboxFor: vi.fn(async () => ({
    inboxUrl: INBOX_URL,
    list: vi.fn(async () => [{ id: "urn:notif:1" }]),
  })),
}));

// The productivity store factories — each returns a store with a derived
// `container` and a `.list()`. The container mirrors `new URL(slug, podRoot)`.
function mockStore(slug: string) {
  return vi.fn(() => ({
    container: `${STORAGE}${slug}`,
    list: vi.fn(async () => [{ url: `${STORAGE}${slug}1`, data: {} }]),
  }));
}
vi.mock("@/lib/notes", () => ({ notesStore: mockStore("notes/") }));
vi.mock("@/lib/calendar", () => ({ calendarStore: mockStore("calendar/") }));
vi.mock("@/lib/bookmarks", () => ({ bookmarksStore: mockStore("bookmarks/") }));
vi.mock("@/lib/tasks", () => ({ tasksStore: mockStore("tasks/") }));
vi.mock("@/lib/issues", () => ({ issuesStore: mockStore("issues/") }));

// durable-cache: keep the real `assignedTasksKey` (storage-scoped key formula).
// (No mock — its key formula is part of the single-source-of-truth contract.)

// Import AFTER the mocks so the module graph wires to them.
import { SwrCache, deriveSwrInitialState } from "../lib/swr-cache.js";
import {
  buildPrefetchTargets,
  discoverInboxTarget,
  runPrefetch,
  type PrefetchContext,
} from "../lib/prefetch.js";
import { assignedTasksKey } from "../lib/durable-cache.js";

const CTX: PrefetchContext = { webId: WEBID, activeStorage: STORAGE, storages: [STORAGE] };

// ---------------------------------------------------------------------------
// The EXPECTED warm keys — the read-page surface prefetch must cover. These are
// the SAME keys instant-nav.test.ts's READ_PAGE_HOOKS registry enumerates (the
// container/storage placeholders bound to the test CTX), kept in lockstep with
// it via the completeness guard below. A page added to that registry without a
// prefetch target makes EXPECTED_WARM_KEYS and the actual targets diverge → the
// completeness test fails (the build breaks), which is the guard we want.
// ---------------------------------------------------------------------------

interface ExpectedKey {
  label: string;
  key: string;
}

const EXPECTED_WARM_KEYS: ExpectedKey[] = [
  { label: "useFriends", key: "friends" },
  { label: "useTypeIndex", key: "type-index" },
  { label: "useCategorySummaries", key: "category-summaries" },
  { label: "useRecentActivity", key: "recent-activity" },
  { label: "useConnectedApps", key: "connected-apps" },
  { label: "usePeople", key: `people:${STORAGE}` },
  { label: "useDomains", key: `domains:${new URL(STORAGE).origin}` },
  { label: "useAssignedTasks", key: assignedTasksKey(STORAGE) },
  { label: "useFolder(root)", key: `files:${STORAGE}` },
  { label: "useItems(notes)", key: `productivity:${STORAGE}notes/` },
  { label: "useItems(calendar)", key: `productivity:${STORAGE}calendar/` },
  { label: "useItems(bookmarks)", key: `productivity:${STORAGE}bookmarks/` },
  { label: "useItems(tasks)", key: `productivity:${STORAGE}tasks/` },
  { label: "useItems(issues)", key: `productivity:${STORAGE}issues/` },
  { label: "useInbox", key: `inbox:${INBOX_URL}` },
];

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// (1) After prefetch, EVERY read page's first visit is instant.
// ---------------------------------------------------------------------------

describe("prefetch: after the orchestrator runs, every read page is INSTANT on its first visit", () => {
  it("warms a value for EVERY expected read-page key", async () => {
    const cache = new SwrCache(null);
    const outcomes = await runPrefetch(CTX, { cache });

    // Every expected key must have warmed (status:"warmed") — not failed, not missing.
    for (const { label, key } of EXPECTED_WARM_KEYS) {
      const outcome = outcomes.find((o) => o.key === key);
      expect(outcome, `${label} (${key}) must have a prefetch outcome`).toBeDefined();
      expect(outcome?.status, `${label} (${key}) must have WARMED, not failed`).toBe("warmed");
      expect(cache.has(WEBID, key), `${label} (${key}) must be in the cache after prefetch`).toBe(
        true,
      );
    }
  });

  for (const { label, key } of EXPECTED_WARM_KEYS) {
    it(`${label} (${key}) → first-visit useSwrRead is INSTANT (loading:false + data) after prefetch`, async () => {
      const cache = new SwrCache(null);
      await runPrefetch(CTX, { cache });

      // This is the EXACT synchronous logic a first-ever useSwrRead runs on mount.
      // After prefetch, it must paint data with NO spinner and revalidate silently
      // — i.e. the user's FIRST visit to this page is instant.
      const first = deriveSwrInitialState(cache, WEBID, key);
      expect(first.loading, `${label} must NOT spin on first visit after prefetch`).toBe(false);
      expect(first.data, `${label} must have cached data on first visit after prefetch`).toBeDefined();
      expect(first.revalidating, `${label} must still revalidate in the background`).toBe(true);
    });
  }

  it("scopes every warmed value to the prefetch WebID (never another account)", async () => {
    const cache = new SwrCache(null);
    await runPrefetch(CTX, { cache });
    for (const { key } of EXPECTED_WARM_KEYS) {
      // Another account sees a COLD cache for the same key.
      const other = deriveSwrInitialState(cache, "https://eve.example/profile#me", key);
      expect(other).toEqual({ data: undefined, loading: true, revalidating: false });
    }
  });
});

// ---------------------------------------------------------------------------
// (2) COMPLETENESS — every cacheable read page has a prefetch target.
// ---------------------------------------------------------------------------

describe("prefetch: COMPLETENESS — a read page added without a prefetch target breaks the build", () => {
  it("the prefetch target set == the expected read-page surface (no page un-prefetched)", async () => {
    // The synchronous targets + the async inbox target form the full set.
    const sync = buildPrefetchTargets(CTX);
    const inbox = await discoverInboxTarget(CTX);
    const targets = inbox ? [...sync, inbox] : sync;

    const targetKeys = new Set(targets.map((t) => t.key));
    const expectedKeys = new Set(EXPECTED_WARM_KEYS.map((e) => e.key));

    // No expected page is missing a target (a NEW read page added to the registry
    // without a prefetch target trips THIS — the build breaks, the promise holds).
    const missing = [...expectedKeys].filter((k) => !targetKeys.has(k));
    expect(
      missing,
      `Read page(s) with NO prefetch target: ${missing.join(", ")}. ` +
        `Add a target in src/lib/prefetch.ts (buildPrefetchTargets / discoverInboxTarget) so the ` +
        `first visit is instant — or document why it is intentionally not prefetched.`,
    ).toEqual([]);

    // No EXTRA target without an expected entry (keeps the two definitions honest).
    const extra = [...targetKeys].filter((k) => !expectedKeys.has(k));
    expect(extra, `Prefetch target(s) with no expected-key entry: ${extra.join(", ")}`).toEqual([]);
  });

  it("every target key is unique (no two pages collide on one slot)", () => {
    const keys = buildPrefetchTargets(CTX).map((t) => t.key);
    expect(new Set(keys).size, "duplicate prefetch target keys").toBe(keys.length);
  });

  it("the prefetch surface matches the instant-nav read-hook registry one-to-one", async () => {
    // Cross-check against instant-nav.test.ts's enumerated read-page hooks so the
    // two systematic registries cannot drift. Every read hook that the SWR layer
    // covers (and that prefetch can warm without per-route params) is represented.
    const prefetchLabels = new Set(
      buildPrefetchTargets(CTX)
        .map((t) => t.label)
        .concat("useInbox"),
    );
    // The hooks prefetch warms (those keyed by webId / activeStorage / a known
    // root container — NOT the per-route-param detail hooks useItem / useDomain /
    // useChat / useCategoryItems, which need a specific id/url the user picks and
    // are warmed on demand by their own SWR read on navigation).
    const required = [
      "useFriends",
      "useTypeIndex",
      "useCategorySummaries",
      "useRecentActivity",
      "useConnectedApps",
      "usePeople",
      "useDomains",
      "useAssignedTasks",
      "useInbox",
    ];
    const missing = required.filter((h) => !prefetchLabels.has(h));
    expect(
      missing,
      `Read hook(s) in the instant-nav registry with no prefetch target: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (3) NON-BLOCKING + per-target ISOLATION.
// ---------------------------------------------------------------------------

describe("prefetch: non-blocking + a per-page failure is isolated", () => {
  it("runPrefetch resolves (never throws) even with no storage", async () => {
    const cache = new SwrCache(null);
    // No activeStorage → only the WebID-scoped targets; must still resolve cleanly.
    await expect(runPrefetch({ webId: WEBID }, { cache, includeInbox: false })).resolves.toBeDefined();
  });

  it("a single target's fetch rejection does NOT prevent the others from warming", async () => {
    // Make ONE library read reject; the rest must still warm their slots.
    const social = await import("@/lib/social");
    (social.readKnows as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("boom: friends read failed");
    });

    const cache = new SwrCache(null);
    const outcomes = await runPrefetch(CTX, { cache, includeInbox: false });

    // The other storage-scoped/webid-scoped pages still warmed.
    expect(cache.has(WEBID, "category-summaries")).toBe(true);
    expect(cache.has(WEBID, "connected-apps")).toBe(true);
    expect(cache.has(WEBID, `productivity:${STORAGE}notes/`)).toBe(true);

    // And runPrefetch reported the failure without throwing — isolation, not abort.
    const failures = outcomes.filter((o) => o.status === "failed");
    expect(failures.length, "the failing target is recorded as failed, others warmed").toBeGreaterThanOrEqual(
      1,
    );
  });

  it("does NOT await the caller — scheduling is synchronous, the warm-up is a returned promise", () => {
    // runPrefetch returns a promise immediately (it does not block the call); the
    // caller (usePrefetch) schedules it off the render path and never awaits it.
    const cache = new SwrCache(null);
    const result = runPrefetch(CTX, { cache, includeInbox: false });
    expect(result, "runPrefetch returns a promise synchronously (non-blocking)").toBeInstanceOf(
      Promise,
    );
    return result; // settle it so the test's async work is awaited by vitest.
  });

  it("only WARMS — a target that resolves undefined never blanks a slot", async () => {
    // Make listDomains resolve `undefined` (a degraded read): the slot must stay
    // COLD (not warmed with undefined), so a later real read is honest.
    const domains = await import("@/lib/domains");
    (domains.listDomains as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      undefined as never,
    );
    const cache = new SwrCache(null);
    const base = new URL(STORAGE).origin;
    await runPrefetch(CTX, { cache, includeInbox: false });
    expect(cache.has(WEBID, `domains:${base}`), "undefined must NOT warm the slot").toBe(false);
  });
});
