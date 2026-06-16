// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * Tests for the global pod search ({@link searchPod}, task #97 / research G9).
 *
 * The pod I/O is fully MOCKED (no server): the typed productivity stores, the
 * Type-Index discovery, `listCategoryItems`, and `listFolder` are replaced with
 * deterministic fixtures so the test exercises the SEARCH logic — cross-type
 * matching, category grouping, de-dup, and the bound/budget that keeps a large
 * pod from hanging the UI — in isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WEBID = "https://alice.example/profile#me";
const STORAGE = "https://alice.example/storage/";
const CTX = { webId: WEBID, activeStorage: STORAGE, storages: [STORAGE] } as const;

// ── Mock the typed productivity stores. Each factory returns a store whose
//    `.list()` yields `{ url, data }` items with the real payload shape.
//    NB: `vi.mock` factories are HOISTED to the top of the file, so they may not
//    reference outer-scope variables — every literal is inlined inside them. ──

// Notes — title/text matching.
vi.mock("@/lib/notes", () => ({
  notesStore: vi.fn(() => ({
    container: "https://alice.example/storage/notes/",
    list: vi.fn(async () => [
      { url: "https://alice.example/storage/notes/1", data: { title: "Quarterly budget", text: "Plan the spend" } },
      { url: "https://alice.example/storage/notes/2", data: { title: "Groceries", text: "milk, eggs" } },
    ]),
  })),
}));
// Contacts — name/email matching.
vi.mock("@/lib/contacts", () => ({
  contactsStore: vi.fn(() => ({
    container: "https://alice.example/storage/contacts/",
    list: vi.fn(async () => [
      { url: "https://alice.example/storage/contacts/1", data: { fn: "Bob Budgetson", email: "bob@example.org" } },
      { url: "https://alice.example/storage/contacts/2", data: { fn: "Carol", email: "carol@example.org" } },
    ]),
  })),
}));
// Bookmarks — title/url/tag matching.
vi.mock("@/lib/bookmarks", () => ({
  bookmarksStore: vi.fn(() => ({
    container: "https://alice.example/storage/bookmarks/",
    list: vi.fn(async () => [
      {
        url: "https://alice.example/storage/bookmarks/1",
        data: { title: "Budgeting guide", url: "https://x.example/b", description: "", tags: ["finance"] },
      },
    ]),
  })),
}));
// Tasks / calendar / issues / schedule.
vi.mock("@/lib/tasks", () => ({
  tasksStore: vi.fn(() => ({
    container: "https://alice.example/storage/tasks/",
    list: vi.fn(async () => [
      { url: "https://alice.example/storage/tasks/1", data: { title: "Review budget", description: "", completed: false, priority: "none" } },
    ]),
  })),
}));
vi.mock("@/lib/calendar", () => ({
  calendarStore: vi.fn(() => ({
    container: "https://alice.example/storage/calendar/",
    list: vi.fn(async () => [
      { url: "https://alice.example/storage/calendar/1", data: { name: "Team lunch", location: "", description: "" } },
    ]),
  })),
}));
vi.mock("@/lib/issues", () => ({
  issuesStore: vi.fn(() => ({
    container: "https://alice.example/storage/issues/",
    list: vi.fn(async () => [
      { url: "https://alice.example/storage/issues/1", data: { title: "Fix login", state: "open" } },
    ]),
  })),
}));
vi.mock("@/lib/schedule", () => ({
  scheduleStore: vi.fn(() => ({
    container: "https://alice.example/storage/schedule/",
    list: vi.fn(async () => [
      { url: "https://alice.example/storage/schedule/1", data: { name: "Offsite poll", options: [], rsvps: [], invitees: [] } },
    ]),
  })),
}));

// Type-index discovery + the My-data container listing + the files root.
vi.mock("@/lib/rdf-read", () => ({
  freshRdf: vi.fn(async () => ({ dataset: { __fake: true }, etag: null })),
}));
vi.mock("@/lib/type-index", () => ({
  discoverRegistrations: vi.fn(async () => ({
    links: {},
    hadIndex: true,
    // A Documents container the user wrote with some OTHER app (not a first-party
    // store) — must be found via the type-index tail.
    locations: [
      { forClass: "https://schema.org/DigitalDocument", container: "https://alice.example/storage/docs/" },
    ],
  })),
}));
vi.mock("@/lib/files", () => ({
  listFolder: vi.fn(async () => [
    { url: "https://alice.example/storage/budget-2026.xlsx", name: "budget-2026.xlsx", isContainer: false },
    { url: "https://alice.example/storage/readme.txt", name: "readme.txt", isContainer: false },
  ]),
}));
// pod-data: keep the REAL summariseCategories/nameFromUrl (pure), mock only the
// network `listCategoryItems`.
vi.mock("@/lib/pod-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pod-data")>();
  return {
    ...actual,
    listCategoryItems: vi.fn(async () => [
      { url: "https://alice.example/storage/docs/budget-deck.odp", name: "budget-deck.odp", isContainer: false },
      { url: "https://alice.example/storage/docs/notes.md", name: "notes.md", isContainer: false },
    ]),
  };
});

// Import AFTER the mocks so the module graph wires to them.
import { searchPod, groupResults, isSearchable, SEARCH_DEFAULTS } from "./pod-search.js";

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("searchPod: cross-type matching", () => {
  it("finds matching items across ≥3 types (note, contact, bookmark, task, file, type-index item)", async () => {
    const { results } = await searchPod(CTX, "budget");
    const types = new Set(results.map((r) => r.type));
    // The query "budget" matches a Note (title), a Contact (name), a Bookmark
    // (title), a Task (title), a File (name), and a type-index Document item —
    // far more than the ≥3 distinct types the contract requires.
    expect(types.size).toBeGreaterThanOrEqual(3);
    expect(types.has("note")).toBe(true);
    expect(types.has("contact")).toBe(true);
    expect(types.has("bookmark")).toBe(true);
    expect(types.has("task")).toBe(true);
    expect(types.has("file")).toBe(true);
    expect(types.has("item")).toBe(true); // the Documents type-index item

    // Non-matching items are excluded (Groceries note, Carol contact, Team lunch).
    expect(results.some((r) => r.label === "Groceries")).toBe(false);
    expect(results.some((r) => r.label === "Carol")).toBe(false);
    expect(results.some((r) => r.label === "Team lunch")).toBe(false);
  });

  it("each result carries a label, a pod URL, a category, and a deep-link href", async () => {
    const { results } = await searchPod(CTX, "budget");
    const note = results.find((r) => r.type === "note");
    expect(note?.label).toBe("Quarterly budget");
    expect(note?.url).toBe(`${STORAGE}notes/1`);
    expect(note?.category.id).toBe("documents"); // TextDigitalDocument → Documents
    expect(note?.href).toBe(`/notes/edit?id=${encodeURIComponent(`${STORAGE}notes/1`)}`);

    const contact = results.find((r) => r.type === "contact");
    expect(contact?.label).toBe("Bob Budgetson");
    expect(contact?.href).toBe(`/contacts/edit?id=${encodeURIComponent(`${STORAGE}contacts/1`)}`);
  });

  it("groups results by category, preserving first-appearance order", async () => {
    const { results } = await searchPod(CTX, "budget");
    const groups = groupResults(results);
    expect(groups.length).toBeGreaterThan(0);
    // Every result is accounted for in exactly one group.
    const grouped = groups.flatMap((g) => g.results);
    expect(grouped).toHaveLength(results.length);
    // Documents groups the note/bookmark/issue items; the group has a category.
    const docs = groups.find((g) => g.category.id === "documents");
    expect(docs).toBeDefined();
  });

  it("a match found via a typed store is NOT duplicated by the type-index tail", async () => {
    const { results } = await searchPod(CTX, "budget");
    const urls = results.map((r) => r.url);
    expect(new Set(urls).size, "no duplicate result URLs").toBe(urls.length);
  });
});

describe("searchPod: empty / no-match / not-ready inputs are inert", () => {
  it("an empty query does no work and returns no results", async () => {
    const { results, sourcesScanned } = await searchPod(CTX, "   ");
    expect(results).toEqual([]);
    expect(sourcesScanned).toBe(0);
  });

  it("a no-match query returns an empty, non-capped outcome", async () => {
    const { results, capped } = await searchPod(CTX, "zzxqq-no-such-thing");
    expect(results).toEqual([]);
    expect(capped).toBe(false);
  });

  it("isSearchable enforces the min-length gate", () => {
    expect(isSearchable("a")).toBe(false);
    expect(isSearchable("ab")).toBe(true);
    expect(isSearchable("  ab  ")).toBe(true);
    expect(isSearchable("")).toBe(false);
  });

  it("no active storage → inert", async () => {
    const { results } = await searchPod(
      { webId: WEBID, activeStorage: "", storages: [] },
      "budget",
    );
    expect(results).toEqual([]);
  });
});

describe("searchPod: the bound/budget engages on a large synthetic set", () => {
  it("the RESULT cap clips a large match set and flags capped + 'showing first N'", async () => {
    // A store with FAR more matches than the cap. Re-mock notes for this test.
    const { notesStore } = await import("@/lib/notes");
    const many = Array.from({ length: 500 }, (_, i) => ({
      url: `${STORAGE}notes/big-${i}`,
      data: { title: `budget item ${i}`, text: "" },
    }));
    (notesStore as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      container: `${STORAGE}notes/`,
      list: vi.fn(async () => many),
    });

    const { results, capped } = await searchPod(CTX, "budget", { maxResults: 10 });
    expect(results.length, "results are clipped at the cap").toBe(10);
    expect(capped, "capped flag is set so the UI can say 'showing first N'").toBe(true);
  });

  it("the SOURCE cap stops scanning further sources (so a huge pod can't hang)", async () => {
    // maxSources:1 → only the FIRST typed source (notes) is scanned; later
    // sources (contacts/bookmarks/…) and the type-index tail are never touched.
    const { contactsStore } = await import("@/lib/contacts");
    const { results, capped, sourcesScanned } = await searchPod(CTX, "budget", { maxSources: 1 });
    expect(sourcesScanned).toBe(1);
    expect(capped).toBe(true);
    // No contact result — the contacts source was never scanned.
    expect(results.some((r) => r.type === "contact")).toBe(false);
    expect(contactsStore).not.toHaveBeenCalled();
  });

  it("the TIME budget stops the scan once the wall-clock deadline passes", async () => {
    // A controllable clock that jumps past the deadline after the first source,
    // so the second source's boundHit() trips on the time budget (not the count).
    let t = 1000;
    const now = () => t;
    const clockSources: number[] = [];
    // Each `boundHit`/deadline check reads `now()`; advance time on the 2nd read
    // so source #1 runs within budget and source #2 is over it.
    const advancingNow = () => {
      clockSources.push(t);
      const v = t;
      t += 5000; // each call jumps 5s
      return v;
    };

    const { capped } = await searchPod(CTX, "budget", {
      timeBudgetMs: 1, // a 1ms budget — exceeded after the first clock advance
      now: advancingNow,
      maxSources: 999,
      maxResults: 999,
    });
    expect(capped, "the time budget clips the scan").toBe(true);
    // It used the injected clock (proving the budget is wall-clock-driven).
    expect(clockSources.length).toBeGreaterThan(0);
    // Reference `now` so an unused-var lint never trips (documents the seam).
    expect(typeof now).toBe("function");
  });

  it("an UNBOUNDED scan of the fixtures completes without capping", async () => {
    const { capped } = await searchPod(CTX, "budget");
    expect(capped, "the default bounds easily cover the small fixture set").toBe(false);
  });

  it("the defaults are sane (positive, finite bounds)", () => {
    expect(SEARCH_DEFAULTS.maxResults).toBeGreaterThan(0);
    expect(SEARCH_DEFAULTS.maxSources).toBeGreaterThan(0);
    expect(SEARCH_DEFAULTS.timeBudgetMs).toBeGreaterThan(0);
  });
});

describe("searchPod: own-pod containment (no foreign-origin fetch)", () => {
  it("ignores a type-index location that points outside the user's pods", async () => {
    const { discoverRegistrations } = await import("@/lib/type-index");
    (discoverRegistrations as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      links: {},
      hadIndex: true,
      // An attacker-influenceable type-index entry pointing at a FOREIGN origin.
      locations: [{ forClass: "https://schema.org/DigitalDocument", container: "https://evil.example/docs/" }],
    });
    const { listCategoryItems } = await import("@/lib/pod-data");
    await searchPod(CTX, "budget");
    // The foreign container must NEVER be listed — its summary was filtered out
    // before any fetch (confused-deputy / token-leak guard).
    const calls = (listCategoryItems as ReturnType<typeof vi.fn>).mock.calls;
    for (const [summary] of calls) {
      for (const loc of summary.locations) {
        expect(loc.container ?? loc.instance ?? "").not.toContain("evil.example");
      }
    }
  });
});
