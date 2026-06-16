// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, expect, it } from "vitest";
import {
  communityPrefsKey,
  defaultCommunityPrefs,
  loadCommunityPrefs,
  markThreadRead,
  type PrefsStorage,
  saveCommunityPrefs,
} from "./community-prefs.js";

const WEBID = "https://alice.example/profile/card#me";

/** An in-memory PrefsStorage for tests. */
function memStorage(initial: Record<string, string> = {}): PrefsStorage & {
  map: Map<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

describe("defaultCommunityPrefs", () => {
  it("seeds the canonical Solid Matrix rooms and forum-latest on", () => {
    const p = defaultCommunityPrefs();
    expect(p.matrixRooms).toContain("#solid_project:matrix.org");
    expect(p.includeDiscourseLatest).toBe(true);
    expect(p.discourseTopicIds).toEqual([]);
    expect(p.readMarker).toEqual({});
  });
});

describe("load/save round-trip (per-WebID scoped)", () => {
  it("persists under a per-WebID key and reloads identically", () => {
    const s = memStorage();
    const prefs = { ...defaultCommunityPrefs(), discourseTopicIds: [9856], readMarker: { "discourse:t:9856": "3" } };
    saveCommunityPrefs(WEBID, prefs, s);
    expect(s.map.has(communityPrefsKey(WEBID))).toBe(true);
    expect(loadCommunityPrefs(WEBID, s)).toEqual(prefs);
  });

  it("falls back to defaults for a missing or corrupt value", () => {
    expect(loadCommunityPrefs(WEBID, memStorage())).toEqual(defaultCommunityPrefs());
    const corrupt = memStorage({ [communityPrefsKey(WEBID)]: "{not json" });
    expect(loadCommunityPrefs(WEBID, corrupt)).toEqual(defaultCommunityPrefs());
  });

  it("returns defaults and no-ops without storage (SSR / privacy mode)", () => {
    expect(loadCommunityPrefs(WEBID, null)).toEqual(defaultCommunityPrefs());
    expect(() => saveCommunityPrefs(WEBID, defaultCommunityPrefs(), null)).not.toThrow();
  });

  it("drops malformed entries when coercing stored JSON", () => {
    const s = memStorage({
      [communityPrefsKey(WEBID)]: JSON.stringify({
        matrixRooms: ["#ok:hs", 42, ""],
        discourseTopicIds: [1, -2, "x", 3],
        includeDiscourseLatest: "yes", // not a boolean → default
        // Only finite non-negative NUMERIC strings survive: drop non-string (7),
        // non-numeric ("abc"), and negative ("-1") markers.
        readMarker: { good: "5", bad: 7, nan: "abc", neg: "-1" },
      }),
    });
    const p = loadCommunityPrefs(WEBID, s);
    expect(p.matrixRooms).toEqual(["#ok:hs"]);
    expect(p.discourseTopicIds).toEqual([1, 3]);
    expect(p.includeDiscourseLatest).toBe(true);
    expect(p.readMarker).toEqual({ good: "5" });
  });
});

describe("markThreadRead (immutable, monotonic)", () => {
  it("advances a marker and returns a new object", () => {
    const p0 = defaultCommunityPrefs();
    const p1 = markThreadRead(p0, "discourse:t:1", "5");
    expect(p1).not.toBe(p0);
    expect(p1.readMarker["discourse:t:1"]).toBe("5");
  });

  it("never regresses a marker (stale re-mark is ignored, same object returned)", () => {
    const p1 = markThreadRead(defaultCommunityPrefs(), "t", "10");
    const p2 = markThreadRead(p1, "t", "4");
    expect(p2).toBe(p1); // unchanged identity → no needless re-render/persist
    expect(p2.readMarker.t).toBe("10");
  });

  it("ignores a non-numeric position", () => {
    const p0 = defaultCommunityPrefs();
    expect(markThreadRead(p0, "t", "abc")).toBe(p0);
  });
});
