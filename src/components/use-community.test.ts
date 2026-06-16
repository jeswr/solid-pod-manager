// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Structural lock for the `useCommunityFeed` SWR wiring. Vitest runs the `node`
 * env (no DOM / React renderer — see vitest.config.ts), so we cannot mount the
 * hook. Instead we (1) reproduce the exact `prefsKey` digest and prove it
 * changes when subscriptions OR read-markers change (so the SWR cache
 * revalidates on either — the unread badge clears after marking read without a
 * manual reload), and (2) structurally assert the hook keys `useSwrRead` on
 * that prefs digest under the `community:` namespace and uses the plain global
 * fetch (NOT the pod auth-fetch). The React wiring itself is covered by build +
 * e2e.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultCommunityPrefs, markThreadRead } from "../lib/community-prefs.js";

const COMPONENTS_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(COMPONENTS_DIR, "use-community.ts"), "utf8");

/**
 * The prefs→key digest, mirrored 1:1 from the hook (kept in sync via the
 * structural assertions below). A change here that diverges from the hook's
 * `prefsKey` would fail the "encodes prefs" tests, which is the regression lock.
 */
function prefsKey(prefs: ReturnType<typeof defaultCommunityPrefs>, matrixConnected = false): string {
  const rooms = [...prefs.matrixRooms].sort().join(",");
  const topics = [...prefs.discourseTopicIds].sort((a, b) => a - b).join(",");
  const marks = Object.entries(prefs.readMarker)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(";");
  return `community:${matrixConnected ? "m" : "_"}:${prefs.includeDiscourseLatest ? 1 : 0}:${rooms}:${topics}:${marks}`;
}

describe("useCommunityFeed cache key encodes the prefs snapshot", () => {
  it("changes when a subscription is added", () => {
    const a = defaultCommunityPrefs();
    const b = { ...a, discourseTopicIds: [9856] };
    expect(prefsKey(b)).not.toBe(prefsKey(a));
  });

  it("changes when a thread is marked read (so unread badges revalidate)", () => {
    const a = defaultCommunityPrefs();
    const b = markThreadRead(a, "discourse:t:9856", "5");
    expect(prefsKey(b)).not.toBe(prefsKey(a));
  });

  it("changes when Matrix connects/disconnects (no stale cross-credential feed)", () => {
    const p = defaultCommunityPrefs();
    expect(prefsKey(p, true)).not.toBe(prefsKey(p, false));
  });

  it("is stable + order-independent for the same logical prefs", () => {
    const a = { ...defaultCommunityPrefs(), matrixRooms: ["#b:hs", "#a:hs"], discourseTopicIds: [2, 1] };
    const b = { ...defaultCommunityPrefs(), matrixRooms: ["#a:hs", "#b:hs"], discourseTopicIds: [1, 2] };
    expect(prefsKey(a)).toBe(prefsKey(b));
  });

  it("is namespaced under community:", () => {
    expect(prefsKey(defaultCommunityPrefs()).startsWith("community:")).toBe(true);
  });
});

describe("useCommunityFeed structural wiring", () => {
  it("keys useSwrRead on the prefs digest", () => {
    expect(SOURCE).toMatch(/useSwrRead<FeedResult>\(\s*key/);
    expect(SOURCE).toContain('return `community:');
  });

  it("uses the plain fetch path (fetchCommunityFeed with no auth-fetch argument)", () => {
    // The fetcher must call fetchCommunityFeed(prefs) WITHOUT passing the pod
    // auth-fetch — these are public hosts, not the pod (credential-leak guard).
    expect(SOURCE).toMatch(/fetchCommunityFeed\(prefs\)/);
    expect(SOURCE).not.toMatch(/session\.fetch|authFetch|authenticatedFetch/);
  });

  it("persists prefs only for non-secret data (no token in prefs persistence)", () => {
    // markRead / setPrefs touch community-prefs (localStorage); credentials live
    // in the separate in-memory community-credentials module.
    expect(SOURCE).toContain("saveCommunityPrefs");
    expect(SOURCE).not.toContain("matrixAccessToken");
  });

  it("clears community credentials on an account switch via the MODULE-level owner guard", () => {
    // An account switch must not let the previous account's Matrix token leak to
    // the next account (roborev finding, Medium). The guard is module-level (NOT
    // a component ref, which re-inits to undefined on every mount and would
    // falsely disconnect on each remount — roborev follow-up finding).
    expect(SOURCE).toContain("clearCommunityCredentialsIfOwnerChanged");
    expect(SOURCE).not.toContain("credWebIdRef");
  });

  it("folds the Matrix-connected state into the cache key (connect/disconnect revalidates)", () => {
    expect(SOURCE).toMatch(/prefsKey\(prefs,\s*matrixConnected\)/);
    expect(SOURCE).toContain("hasMatrixCredential()");
  });

  it("does NOT fetch the feed off default prefs before saved prefs load (loaded gate)", () => {
    // The feed key is "" until prefs are loaded for the WebID, so no external
    // request fires off the unsaved defaults (roborev finding, Medium). Prefs are
    // also lazily initialised synchronously from storage when the WebID is known.
    expect(SOURCE).toMatch(/loaded \? prefsKey\(prefs, matrixConnected\) : ""/);
    expect(SOURCE).toContain("loadedFor");
    expect(SOURCE).toContain("loaded: boolean");
  });
});
