// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

import { describe, expect, it } from "vitest";
import {
  ASSIGNED_TASKS_KEY_PREFIX,
  assignedTasksCodec,
  assignedTasksKey,
  CONNECTED_APPS_KEY_PREFIX,
  connectedAppsKey,
  clearAllDurableCache,
  clearDurableCacheEntry,
  clearDurableCacheForWebId,
  codecFor,
  dateRevivingCodec,
  jsonCodec,
  MAX_AGE_MS,
  readDurableCache,
  reviveDatesDeep,
  type SyncStorage,
  VERSION,
  writeDurableCache,
} from "./durable-cache.js";

const WEBID_A = "https://alice.example/profile#me";
const WEBID_B = "https://bob.example/profile#me";

// Two REGISTERED durable keys (see CODECS in durable-cache.ts). Only registered
// keys persist, so the behavioural tests below use real keys — this keeps them
// exercising the live registry rather than a key that would now be memory-only.
const APPS = "connected-apps";
const ACTIVITY = "recent-activity";
// The (WebID, key) separator the storage layer uses (a NUL byte).
const SEP = "\u0000";
const storageKey = (webId: string, key: string) =>
  `solid-pod-manager:read-cache:${webId}${SEP}${key}`;

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
    writeDurableCache(WEBID_A, APPS, [{ name: "App", n: 1 }], s);
    expect(readDurableCache(WEBID_A, APPS, s)).toEqual([{ name: "App", n: 1 }]);
  });

  it("returns null when nothing is cached", () => {
    expect(readDurableCache(WEBID_A, APPS, new MemoryStorage())).toBeNull();
  });

  it("is WebID-scoped — one account never reads another's snapshot", () => {
    const s = new MemoryStorage();
    writeDurableCache(WEBID_A, APPS, "alice-data", s);
    // Bob asks for the same key — must MISS (no cross-user data bleed).
    expect(readDurableCache(WEBID_B, APPS, s)).toBeNull();
    expect(readDurableCache(WEBID_A, APPS, s)).toBe("alice-data");
  });

  it("never hydrates without a WebID (a miss, not a hydrate of someone's data)", () => {
    const s = new MemoryStorage();
    writeDurableCache(WEBID_A, APPS, "alice-data", s);
    expect(readDurableCache(null, APPS, s)).toBeNull();
    expect(readDurableCache(undefined, APPS, s)).toBeNull();
    expect(readDurableCache("", APPS, s)).toBeNull();
  });

  it("does not persist without a WebID (the snapshot would be unreadable)", () => {
    const s = new MemoryStorage();
    writeDurableCache(null, APPS, "x", s);
    writeDurableCache("", APPS, "x", s);
    expect(s.length).toBe(0);
  });

  it("does not persist undefined (nothing to paint)", () => {
    const s = new MemoryStorage();
    writeDurableCache(WEBID_A, APPS, undefined, s);
    expect(s.length).toBe(0);
  });

  it("distinct keys under one WebID are independent", () => {
    const s = new MemoryStorage();
    writeDurableCache(WEBID_A, APPS, "a", s);
    writeDurableCache(WEBID_A, ACTIVITY, "b", s);
    expect(readDurableCache(WEBID_A, APPS, s)).toBe("a");
    expect(readDurableCache(WEBID_A, ACTIVITY, s)).toBe("b");
  });

  it("misses on a version mismatch (stale shapes can't leak or mis-parse)", () => {
    const s = new MemoryStorage();
    // Forge an envelope with a different version.
    const forged = JSON.stringify({
      v: VERSION + 1,
      at: Date.now(),
      webId: WEBID_A,
      key: APPS,
      value: "old-shape",
    });
    s.setItem(storageKey(WEBID_A, APPS), forged);
    expect(readDurableCache(WEBID_A, APPS, s)).toBeNull();
  });

  it("misses on a WebID mismatch even with the right key (defence in depth)", () => {
    const s = new MemoryStorage();
    // Forge an envelope whose in-body webId disagrees with the lookup webId,
    // stored under WEBID_B's key — readDurableCache(WEBID_B) must reject it.
    const forged = JSON.stringify({
      v: VERSION,
      at: Date.now(),
      webId: WEBID_A, // body says Alice
      key: APPS,
      value: "alice-data",
    });
    s.setItem(storageKey(WEBID_B, APPS), forged);
    expect(readDurableCache(WEBID_B, APPS, s)).toBeNull();
  });

  it("does not paint a snapshot older than MAX_AGE_MS (bounded first-paint staleness)", () => {
    const s = new MemoryStorage();
    const now = 1_000_000_000_000;
    writeDurableCache(WEBID_A, APPS, "old", s, now);
    // Just within the bound: still painted.
    expect(readDurableCache(WEBID_A, APPS, s, now + MAX_AGE_MS - 1)).toBe("old");
    // Past the bound: a miss (still revalidates via the network).
    expect(readDurableCache(WEBID_A, APPS, s, now + MAX_AGE_MS + 1)).toBeNull();
  });

  it("returns null (not a throw) on a corrupt entry", () => {
    const s = new MemoryStorage();
    s.setItem(storageKey(WEBID_A, APPS), "{not json");
    expect(readDurableCache(WEBID_A, APPS, s)).toBeNull();
  });

  it("is best-effort: a quota error on write never throws", () => {
    const s = new ThrowingStorage();
    expect(() => writeDurableCache(WEBID_A, APPS, "x", s)).not.toThrow();
  });

  it("degrades to no-cache when there is no storage (SSR / privacy mode)", () => {
    expect(readDurableCache(WEBID_A, APPS, null)).toBeNull();
    expect(() => writeDurableCache(WEBID_A, APPS, "x", null)).not.toThrow();
    expect(() => clearAllDurableCache(null)).not.toThrow();
    expect(() => clearDurableCacheForWebId(WEBID_A, null)).not.toThrow();
    expect(() => clearDurableCacheEntry(WEBID_A, APPS, null)).not.toThrow();
  });

  it("clearDurableCacheEntry removes one (webId, key) only", () => {
    const s = new MemoryStorage();
    writeDurableCache(WEBID_A, APPS, "a", s);
    writeDurableCache(WEBID_A, ACTIVITY, "b", s);
    clearDurableCacheEntry(WEBID_A, APPS, s);
    expect(readDurableCache(WEBID_A, APPS, s)).toBeNull();
    expect(readDurableCache(WEBID_A, ACTIVITY, s)).toBe("b");
  });

  it("clearDurableCacheForWebId drops one account's snapshots, keeps the other's (account switch)", () => {
    const s = new MemoryStorage();
    writeDurableCache(WEBID_A, APPS, "alice", s);
    writeDurableCache(WEBID_A, ACTIVITY, "alice2", s);
    writeDurableCache(WEBID_B, APPS, "bob", s);

    clearDurableCacheForWebId(WEBID_A, s);
    expect(readDurableCache(WEBID_A, APPS, s)).toBeNull();
    expect(readDurableCache(WEBID_A, ACTIVITY, s)).toBeNull();
    expect(readDurableCache(WEBID_B, APPS, s)).toBe("bob"); // untouched
  });

  it("clearAllDurableCache wipes every account's snapshots (logout)", () => {
    const s = new MemoryStorage();
    writeDurableCache(WEBID_A, APPS, "alice", s);
    writeDurableCache(WEBID_B, APPS, "bob", s);
    clearAllDurableCache(s);
    expect(readDurableCache(WEBID_A, APPS, s)).toBeNull();
    expect(readDurableCache(WEBID_B, APPS, s)).toBeNull();
    expect(s.length).toBe(0);
  });

  it("clearAll/clearForWebId leave UNRELATED localStorage keys alone", () => {
    const s = new MemoryStorage();
    s.setItem("some-other-app:thing", "keep-me");
    writeDurableCache(WEBID_A, APPS, "alice", s);
    clearAllDurableCache(s);
    expect(s.getItem("some-other-app:thing")).toBe("keep-me");
  });
});

describe("durable-cache codec registry (serialisation safety, roborev finding)", () => {
  it("registers a codec for every durable key the SwrCache persists", () => {
    // The four real read-model keys (see use-permissions/use-activity/use-pod-data).
    expect(codecFor("connected-apps")).not.toBeNull();
    expect(codecFor("category-summaries")).not.toBeNull();
    expect(codecFor("recent-activity")).not.toBeNull();
    // category-items is keyed with a dynamic category-id suffix (prefix match).
    expect(codecFor("category-items:identity")).not.toBeNull();
    expect(codecFor("category-items:anything-here")).not.toBeNull();
    // The "Assigned to me" federation view (use-federation-tasks) — a real
    // Date-carrying model, so it MUST be registered (else it would silently be
    // memory-only and never hydrate on a cold open). Its key is storage-scoped
    // (`assigned-tasks:<storage>`), matched by PREFIX, so both the bare prefix and
    // a real storage-suffixed key resolve to a codec.
    expect(codecFor("assigned-tasks")).not.toBeNull();
    expect(codecFor(assignedTasksKey("https://alice.example/"))).not.toBeNull();
    expect(codecFor(ASSIGNED_TASKS_KEY_PREFIX)).not.toBeNull();
    // Connected-apps is now storage-scoped too (`connected-apps:<storage>`,
    // PREFIX-matched), so both the bare prefix AND a storage-suffixed key resolve
    // to a codec (roborev finding, Medium — the model is per-storage ACL grants).
    expect(codecFor(CONNECTED_APPS_KEY_PREFIX)).not.toBeNull();
    expect(codecFor(connectedAppsKey("https://alice.example/storage/"))).not.toBeNull();
  });

  it("has NO codec for an unregistered key (it is memory-only)", () => {
    expect(codecFor("not-a-real-key")).toBeNull();
    expect(codecFor("apps")).toBeNull(); // a bare/legacy key is memory-only
    expect(codecFor("category-items")).toBeNull(); // missing the ':' is not the prefix
  });

  it("an unregistered key is NEVER persisted (memory-only — no unverified round-trip)", () => {
    const s = new MemoryStorage();
    writeDurableCache(WEBID_A, "unregistered-model", { foo: 1 }, s);
    // Nothing was written, and a read misses.
    expect(s.length).toBe(0);
    expect(readDurableCache(WEBID_A, "unregistered-model", s)).toBeNull();
  });

  it("ignores a forged entry under an unregistered key (read short-circuits before storage)", () => {
    const s = new MemoryStorage();
    // Even if a value somehow exists under an unregistered key, it never hydrates.
    s.setItem(
      storageKey(WEBID_A, "unregistered-model"),
      JSON.stringify({ v: VERSION, at: Date.now(), webId: WEBID_A, key: "unregistered-model", value: 1 }),
    );
    expect(readDurableCache(WEBID_A, "unregistered-model", s)).toBeNull();
  });

  it("jsonCodec round-trips a JSON-plain value unchanged", () => {
    const codec = jsonCodec<{ a: number; b: string[]; c: boolean }>();
    const model = { a: 1, b: ["x", "y"], c: true };
    const roundTripped = codec.decode(JSON.parse(JSON.stringify(codec.encode(model))));
    expect(roundTripped).toEqual(model);
  });

  it("reviveDatesDeep revives ISO-datetime strings to Dates through nesting", () => {
    const iso = "2026-06-13T10:20:30.000Z";
    const revived = reviveDatesDeep<{ when: unknown; nested: { items: unknown[] } }>({
      when: iso,
      nested: { items: [iso, "not-a-date", 7] },
    });
    expect(revived.when).toBeInstanceOf(Date);
    expect((revived.when as Date).toISOString()).toBe(iso);
    expect(revived.nested.items[0]).toBeInstanceOf(Date);
    expect(revived.nested.items[1]).toBe("not-a-date"); // plain string left alone
    expect(revived.nested.items[2]).toBe(7);
  });

  it("dateRevivingCodec makes a model with Date fields round-trip to EQUAL Dates (not strings)", () => {
    interface Model {
      id: string;
      createdAt: Date;
      nested: { updatedAt: Date };
      tags: string[];
    }
    const codec = dateRevivingCodec<Model>();
    const model: Model = {
      id: "abc",
      createdAt: new Date("2026-06-13T10:20:30.000Z"),
      nested: { updatedAt: new Date("2025-01-02T03:04:05.000Z") },
      tags: ["one", "two"],
    };
    // Go through the REAL JSON boundary, exactly as localStorage would.
    const encoded = JSON.stringify(codec.encode(model));
    const decoded = codec.decode(JSON.parse(encoded));
    // Type-faithful: Dates hydrate as Dates, equal to the originals.
    expect(decoded.createdAt).toBeInstanceOf(Date);
    expect(decoded.createdAt.getTime()).toBe(model.createdAt.getTime());
    expect(decoded.nested.updatedAt).toBeInstanceOf(Date);
    expect(decoded.nested.updatedAt.getTime()).toBe(model.nested.updatedAt.getTime());
    expect(decoded).toEqual(model);
  });
});

/**
 * REAL serialisation-boundary round-trips — through the actual
 * writeDurableCache/readDurableCache localStorage path (an in-memory Storage
 * that matches the contract), NOT the FakeDurable shortcut, so the JSON
 * stringify/parse boundary is genuinely exercised (roborev finding fix).
 */
describe("durable-cache real round-trip (write→localStorage→read)", () => {
  it("recent-activity (ISO-string timestamps) round-trips byte-for-byte", () => {
    const s = new MemoryStorage();
    const feed = [
      {
        url: "https://alice.example/notes/1",
        name: "Note one",
        categoryId: "documents",
        categoryLabel: "Documents",
        modified: "2026-06-13T10:20:30.000Z", // ISO string in the model (not a Date)
        isContainer: false,
      },
    ];
    writeDurableCache(WEBID_A, "recent-activity", feed, s);
    const back = readDurableCache<typeof feed>(WEBID_A, "recent-activity", s);
    expect(back).toEqual(feed);
    // The timestamp stays a string (the model's declared shape), not a Date.
    expect(typeof back?.[0].modified).toBe("string");
  });

  it("category-items:<id> (ISO-string timestamps) round-trips through real storage", () => {
    const s = new MemoryStorage();
    const items = [
      { url: "https://alice.example/p/a", name: "a", isContainer: false, modified: "2026-01-01T00:00:00.000Z", size: 12 },
      { url: "https://alice.example/p/b/", name: "b", isContainer: true },
    ];
    writeDurableCache(WEBID_A, "category-items:photos", items, s);
    expect(readDurableCache(WEBID_A, "category-items:photos", s)).toEqual(items);
  });

  it("connected-apps model round-trips through real storage", () => {
    const s = new MemoryStorage();
    const model = {
      apps: [{ agentId: "https://app.example", kind: "agent", wholePod: false, modes: ["Read"], categories: [], name: "App", homepage: "https://app.example" }],
      ctx: { ownerWebId: WEBID_A, podRoot: "https://alice.example/", summaries: [] },
    };
    writeDurableCache(WEBID_A, "connected-apps", model, s);
    expect(readDurableCache(WEBID_A, "connected-apps", s)).toEqual(model);
  });

  it("a model with a real Date field round-trips to EQUAL Dates via a date-reviving key", () => {
    // Register a temporary date-reviving codec for a throwaway key by exercising
    // the codec directly through the same JSON boundary readDurableCache uses.
    // The `assigned-tasks` production key now uses this codec for real (see the
    // round-trip below); this case proves the seam for any other FUTURE model.
    interface DatedModel {
      label: string;
      at: Date;
    }
    const codec = dateRevivingCodec<DatedModel>();
    const model: DatedModel = { label: "x", at: new Date("2026-06-13T12:00:00.000Z") };
    // Simulate exactly what write/read do: stringify(encode) → parse → decode.
    const stored = JSON.stringify({
      v: VERSION,
      at: Date.now(),
      webId: WEBID_A,
      key: "future-dated",
      value: codec.encode(model),
    });
    const env = JSON.parse(stored);
    const decoded = codec.decode(env.value);
    expect(decoded.at).toBeInstanceOf(Date);
    expect(decoded.at.getTime()).toBe(model.at.getTime());
    expect(decoded).toEqual(model);
  });

  it("assigned-tasks (a real AssignedTask[] with a nested Date) round-trips through real storage", () => {
    // The shape the "Assigned to me" federation view caches (use-federation-tasks):
    // an AssignedTask carries `task.created` as a real Date revived from
    // xsd:dateTime. Mirror the model here (no import needed — we assert the
    // SERIALISATION contract, not the discovery logic) and round-trip it through
    // the genuine write→localStorage→read path that the SwrCache uses.
    const s = new MemoryStorage();
    const key = assignedTasksKey("https://alice.example/");
    const created = new Date("2026-06-10T08:15:00.000Z");
    const endedAt = new Date("2026-06-12T09:00:00.000Z");
    const tasks = [
      {
        url: "https://bob.example/issues/42",
        own: false,
        source: "https://bob.example/profile/card#me",
        task: {
          title: "Review the federation PR",
          description: "Please look before Friday",
          state: "closed" as const,
          created,
          endedAt, // prov:endedAtTime — the second real Date field
          assignee: WEBID_A,
        },
      },
      {
        url: "https://alice.example/issues/7",
        own: true,
        source: WEBID_A,
        // A task with NO created date must also survive (the field is optional).
        task: { title: "Tidy my pod", state: "closed" as const },
      },
    ];
    writeDurableCache(WEBID_A, key, tasks, s);
    const back = readDurableCache<typeof tasks>(WEBID_A, key, s);
    expect(back).not.toBeNull();
    // Both nested Dates hydrate as Dates (not the ISO strings JSON parsed them as)
    // — so the cold-open render sorts/formats correctly, matching a fresh fetch.
    expect(back?.[0].task.created).toBeInstanceOf(Date);
    expect((back?.[0].task.created as Date).getTime()).toBe(created.getTime());
    expect(back?.[0].task.endedAt).toBeInstanceOf(Date);
    expect((back?.[0].task.endedAt as Date).getTime()).toBe(endedAt.getTime());
    // The whole model is otherwise byte-faithful, including the dateless task.
    expect(back).toEqual(tasks);
    expect(back?.[1].task.created).toBeUndefined();
  });

  it("assigned-tasks is WebID-scoped — another user never hydrates your assigned list", () => {
    const s = new MemoryStorage();
    const key = assignedTasksKey("https://alice.example/");
    const tasks = [
      { url: "https://x/1", own: true, source: WEBID_A, task: { title: "mine", state: "open" as const } },
    ];
    writeDurableCache(WEBID_A, key, tasks, s);
    // Bob on the same browser must MISS — cross-pod task data is per-viewer.
    expect(readDurableCache(WEBID_B, key, s)).toBeNull();
    expect(readDurableCache(WEBID_A, key, s)).toEqual(tasks);
  });
});

/**
 * Round-2 roborev fixes: (1) the FIELD-AWARE assignedTasksCodec must not corrupt
 * user-controlled strings that happen to look like ISO dates (the cold-open
 * `.title.trim()` crash), and (2) the storage-scoped cache key must give each
 * storage of one WebID its OWN slot (no stale cross-storage hit).
 */
describe("assigned-tasks codec + key (roborev round-2)", () => {
  it("revives created/endedAt to Dates but leaves a date-LOOKING title/description/url as STRINGS", () => {
    // The crash regression: a user can legitimately title a task with an ISO
    // date. The generic dateRevivingCodec would hydrate that title as a Date, and
    // the assigned page's `it.title.trim()` would throw on a cold open. The
    // field-aware codec must revive ONLY the known date fields.
    const created = new Date("2026-06-10T08:15:00.000Z");
    const model = [
      {
        url: "https://bob.example/issues/2026-01-01T00:00:00.000Z", // date-shaped URL segment
        own: false,
        source: "https://bob.example/profile/card#me",
        task: {
          title: "2026-01-01T00:00:00.000Z", // a title that IS an ISO datetime
          description: "1999-12-31T23:59:59.000Z", // ditto for the description
          state: "open" as const,
          created, // a REAL date field — must become a Date
          assignee: WEBID_A,
        },
      },
    ];
    const codec = assignedTasksCodec<typeof model>();
    // Through the genuine JSON boundary localStorage uses.
    const decoded = codec.decode(JSON.parse(JSON.stringify(codec.encode(model))));
    const t = decoded[0];
    // The KNOWN date field is a Date…
    expect(t.task.created).toBeInstanceOf(Date);
    expect((t.task.created as Date).getTime()).toBe(created.getTime());
    // …but the user-controlled strings stay STRINGS (the crash regression).
    expect(typeof t.task.title).toBe("string");
    expect(t.task.title).toBe("2026-01-01T00:00:00.000Z");
    expect(() => (t.task.title as string).trim()).not.toThrow();
    expect(typeof t.task.description).toBe("string");
    expect(typeof t.url).toBe("string");
    expect(t.url).toBe("https://bob.example/issues/2026-01-01T00:00:00.000Z");
    expect(t.source).toBe("https://bob.example/profile/card#me");
  });

  it("the same date-shaped title would be CORRUPTED by the generic dateRevivingCodec (contrast)", () => {
    // This documents WHY the field-aware codec is needed: the generic reviver
    // turns the date-shaped title into a Date, which is exactly the corruption.
    const model = [{ task: { title: "2026-01-01T00:00:00.000Z", state: "open" } }];
    const generic = dateRevivingCodec<typeof model>();
    const decoded = generic.decode(JSON.parse(JSON.stringify(generic.encode(model))));
    expect(decoded[0].task.title).toBeInstanceOf(Date); // corruption the fix avoids
  });

  it("absent optional date fields are NOT materialised by the codec", () => {
    const model = [{ url: "u", own: true, source: WEBID_A, task: { title: "x", state: "open" } }];
    const codec = assignedTasksCodec<typeof model>();
    const decoded = codec.decode(JSON.parse(JSON.stringify(codec.encode(model))));
    expect("created" in decoded[0].task).toBe(false);
    expect("endedAt" in decoded[0].task).toBe(false);
    expect(decoded).toEqual(model);
  });

  it("a malformed (non-array / non-object) cached value degrades to an empty list, never throws", () => {
    const codec = assignedTasksCodec();
    expect(codec.decode("not-an-array" as never)).toEqual([]);
    expect(codec.decode({} as never)).toEqual([]);
    // A non-object array element is passed through untouched (no crash).
    expect(codec.decode([42, null] as never)).toEqual([42, null]);
  });

  it("a different active storage yields a DIFFERENT cache key (no stale cross-storage hit)", () => {
    const storageA = "https://alice.example/work/";
    const storageB = "https://alice.example/personal/";
    const keyA = assignedTasksKey(storageA);
    const keyB = assignedTasksKey(storageB);
    expect(keyA).not.toBe(keyB);
    expect(keyA.startsWith(`${ASSIGNED_TASKS_KEY_PREFIX}:`)).toBe(true);
    expect(keyB.startsWith(`${ASSIGNED_TASKS_KEY_PREFIX}:`)).toBe(true);
  });

  it("two storages of ONE WebID never share a durable slot — storage B never hydrates storage A's list", () => {
    const s = new MemoryStorage();
    const keyA = assignedTasksKey("https://alice.example/work/");
    const keyB = assignedTasksKey("https://alice.example/personal/");
    const workTasks = [
      { url: "https://alice.example/work/1", own: true, source: WEBID_A, task: { title: "work item", state: "open" as const } },
    ];
    writeDurableCache(WEBID_A, keyA, workTasks, s);
    // Switching to storage B (same WebID, same browser) is a MISS — it does NOT
    // serve the work-pod list, which was the round-2 cross-storage stale bug.
    expect(readDurableCache(WEBID_A, keyB, s)).toBeNull();
    expect(readDurableCache(WEBID_A, keyA, s)).toEqual(workTasks);
  });
});
