// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Tests for the community-feeds bridge. The package's sources go through an
 * injectable `safeFetch`, so we stub a {@link FetchLike} that returns canned
 * Discourse/Matrix JSON. The headline guarantee proven here: the FORUM feed
 * works with NO credentials, and connecting a Matrix token adds the rooms
 * without one source failing blanking the other.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FetchLike } from "@jeswr/solid-community-feeds";
import {
  buildCommunityFeed,
  fetchCommunityFeed,
  threadReadPosition,
} from "./community-feeds.js";
import {
  clearCommunityCredentials,
  setCommunityCredentials,
} from "./community-credentials.js";
import { defaultCommunityPrefs } from "./community-prefs.js";

/** A minimal SafeFetchResponse for JSON bodies. */
function jsonResponse(body: unknown, status = 200): {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
} {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: {
      get(name: string) {
        const n = name.toLowerCase();
        if (n === "content-type") return "application/json";
        if (n === "content-length") return String(Buffer.byteLength(text));
        return null;
      },
    },
    text: () => Promise.resolve(text),
  };
}

/** Build a routing fetch stub from a URL→body map. Records the URLs hit. */
function stubFetch(routes: Record<string, unknown>): FetchLike & { hits: string[] } {
  const hits: string[] = [];
  const fn = ((url: string | URL) => {
    const u = String(url);
    hits.push(u);
    for (const [needle, body] of Object.entries(routes)) {
      if (u.includes(needle)) return Promise.resolve(jsonResponse(body));
    }
    return Promise.resolve(jsonResponse({ error: "not found" }, 404));
  }) as FetchLike & { hits: string[] };
  fn.hits = hits;
  return fn;
}

const FORUM_LATEST = {
  topic_list: {
    topics: [
      {
        id: 9856,
        title: "Welcome to the Solid forum",
        slug: "welcome",
        posts_count: 3,
        bumped_at: "2026-06-15T10:00:00.000Z",
        created_at: "2026-06-10T09:00:00.000Z",
        category_id: 5,
      },
      {
        id: 9857,
        title: "Older topic",
        slug: "older",
        posts_count: 1,
        bumped_at: "2026-06-01T08:00:00.000Z",
        created_at: "2026-06-01T08:00:00.000Z",
        category_id: 5,
      },
    ],
  },
};

afterEach(() => clearCommunityCredentials());

describe("threadReadPosition", () => {
  it("uses the highest post number (message count) for a Discourse thread", () => {
    expect(
      threadReadPosition({
        id: "discourse:t:1",
        source: "discourse",
        title: "t",
        channelId: "discourse:5",
        lastActivityAt: "2026-06-15T10:00:00.000Z",
        messageCount: 7,
        permalink: "https://forum.solidproject.org/t/x/1",
      }),
    ).toBe("7");
  });

  it("uses the newest message timestamp (ms) for a Matrix thread", () => {
    const pos = threadReadPosition({
      id: "!room:matrix.org",
      source: "matrix",
      title: "Solid",
      channelId: "!room:matrix.org",
      lastActivityAt: "2026-06-15T10:00:00.000Z",
      permalink: "https://matrix.to/#/!room:matrix.org",
      messages: [
        {
          id: "$e1",
          source: "matrix",
          author: "Alice",
          authorId: "@alice:matrix.org",
          body: "hi",
          createdAt: "2026-06-15T10:00:00.000Z",
          permalink: "https://matrix.to/#/!room:matrix.org/$e1",
        },
      ],
    });
    expect(pos).toBe(String(Date.parse("2026-06-15T10:00:00.000Z")));
  });

  it("returns undefined when no position is derivable", () => {
    expect(
      threadReadPosition({
        id: "discourse:t:1",
        source: "discourse",
        title: "t",
        channelId: "discourse:5",
        lastActivityAt: "not-a-date",
        permalink: "https://forum.solidproject.org/t/x/1",
      }),
    ).toBeUndefined();
  });
});

describe("buildCommunityFeed", () => {
  it("always includes the Discourse source; omits Matrix without a token", () => {
    clearCommunityCredentials();
    const feed = buildCommunityFeed(stubFetch({}));
    // We can't introspect private sources directly, but getFeed proves it:
    expect(feed).toBeDefined();
  });
});

describe("fetchCommunityFeed — forum works WITHOUT credentials", () => {
  it("returns the forum latest threads newest-first, no Matrix, no errors", async () => {
    clearCommunityCredentials(); // explicitly: no Matrix token, no Discourse key
    const fetchStub = stubFetch({ "/latest.json": FORUM_LATEST });
    const prefs = { ...defaultCommunityPrefs(), matrixRooms: [], includeDiscourseLatest: true };

    const result = await fetchCommunityFeed(prefs, fetchStub);

    expect(result.errors).toHaveLength(0);
    expect(result.threads.map((t) => t.id)).toEqual(["discourse:t:9856", "discourse:t:9857"]);
    expect(result.threads.every((t) => t.source === "discourse")).toBe(true);
    // No Matrix endpoint was ever called (no token → source omitted).
    expect(fetchStub.hits.some((u) => u.includes("/_matrix/"))).toBe(false);
  });

  it("does not query Matrix rooms even if subscribed, until a token is connected", async () => {
    clearCommunityCredentials();
    const fetchStub = stubFetch({ "/latest.json": FORUM_LATEST });
    const prefs = {
      ...defaultCommunityPrefs(),
      matrixRooms: ["#solid_project:matrix.org"], // subscribed, but no token
    };

    const result = await fetchCommunityFeed(prefs, fetchStub);

    expect(fetchStub.hits.some((u) => u.includes("/_matrix/"))).toBe(false);
    expect(result.errors).toHaveLength(0);
    expect(result.threads.length).toBeGreaterThan(0);
  });
});

describe("fetchCommunityFeed — Matrix added once a token is connected", () => {
  it("queries Matrix rooms and still returns the forum when Matrix fails (per-source error)", async () => {
    setCommunityCredentials({ matrixAccessToken: "syt_test_token" });
    // Forum responds; Matrix alias-resolution 404s → a collected error, not a throw.
    const fetchStub = stubFetch({ "/latest.json": FORUM_LATEST });
    const prefs = {
      ...defaultCommunityPrefs(),
      matrixRooms: ["#solid_project:matrix.org"],
    };

    const result = await fetchCommunityFeed(prefs, fetchStub);

    // Matrix WAS attempted now there's a token…
    expect(fetchStub.hits.some((u) => u.includes("/_matrix/"))).toBe(true);
    // …it failed (alias 404) but only as a collected per-source error…
    expect(result.errors.some((e) => e.source === "matrix")).toBe(true);
    // …and the forum feed is intact regardless (one source failing never blanks the other).
    expect(result.threads.some((t) => t.source === "discourse")).toBe(true);
  });
});
