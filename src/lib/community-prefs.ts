// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Community-view preferences — which channels the user subscribes to, plus the
 * per-thread read-markers used to compute unread counts.
 *
 * INTERIM STORAGE NOTE: these non-secret preferences are persisted in
 * `localStorage`, scoped per WebID. The pod is the eventual home (per the
 * credentials-in-pod / pod-data conventions) — but the unified-feed package is
 * experimental and read-first, and inventing/committing an RDF vocab for an
 * experimental surface is premature. `localStorage` matches how the SWR durable
 * cache and login-UX already persist client-side state, and keeps the feature
 * shippable today. The store is split into a pure (storage-injected) core so it
 * is fully unit-testable in the no-DOM `node` test env and can be re-pointed at
 * a pod resource later without touching the hook/page.
 *
 * SECURITY: this holds NO credentials (those live in `community-credentials.ts`,
 * in memory only). Only channel selections + read positions live here.
 */
import { SOLID_CHANNELS } from "@jeswr/solid-community-feeds";
import type { ReadMarker } from "@jeswr/solid-community-feeds";

/** A single subscribable channel descriptor (Matrix room alias OR forum topic id). */
export type CommunityChannelRef =
  | { kind: "matrix"; room: string; label: string }
  | { kind: "discourse-topic"; topicId: number; label: string };

/** The user's persisted community-view preferences. */
export interface CommunityPrefs {
  /** Matrix room aliases/ids the user follows. */
  matrixRooms: string[];
  /** Discourse topic ids the user follows directly. */
  discourseTopicIds: number[];
  /** Include the forum's site-wide latest topics as headers (default true). */
  includeDiscourseLatest: boolean;
  /** Per-thread last-seen marker (the package's ReadMarker shape). */
  readMarker: ReadMarker;
}

/**
 * The canonical Solid channels shown out of the box. The forum-latest header
 * feed needs NO credential, so a brand-new user sees the Solid forum
 * immediately; the Matrix rooms only produce a feed once a Matrix token is
 * connected (otherwise the package collects a per-source error, never blanking
 * the forum).
 */
export const DEFAULT_MATRIX_ROOMS: readonly string[] = [
  SOLID_CHANNELS.matrixRoom,
  SOLID_CHANNELS.matrixGitterRoom,
] as const;

/** Default preferences for a user who has not customised anything yet. */
export function defaultCommunityPrefs(): CommunityPrefs {
  return {
    matrixRooms: [...DEFAULT_MATRIX_ROOMS],
    discourseTopicIds: [],
    includeDiscourseLatest: true,
    readMarker: {},
  };
}

const PREFIX = "solid-pod-manager:community-prefs:";

/** The localStorage key for a given WebID's community prefs. */
export function communityPrefsKey(webId: string): string {
  return `${PREFIX}${webId}`;
}

/** Minimal synchronous KV contract (localStorage satisfies it; injectable for tests). */
export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The browser's localStorage when present, else `null` (SSR / privacy mode). */
export function browserPrefsStorage(): PrefsStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Coerce arbitrary parsed JSON into a well-formed {@link CommunityPrefs}. */
function coerce(raw: unknown): CommunityPrefs {
  const base = defaultCommunityPrefs();
  if (!raw || typeof raw !== "object") return base;
  const o = raw as Record<string, unknown>;
  const matrixRooms = Array.isArray(o.matrixRooms)
    ? o.matrixRooms.filter((r): r is string => typeof r === "string" && r.length > 0)
    : base.matrixRooms;
  const discourseTopicIds = Array.isArray(o.discourseTopicIds)
    ? o.discourseTopicIds.filter(
        (n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0,
      )
    : base.discourseTopicIds;
  const includeDiscourseLatest =
    typeof o.includeDiscourseLatest === "boolean"
      ? o.includeDiscourseLatest
      : base.includeDiscourseLatest;
  const readMarker: ReadMarker = {};
  if (o.readMarker && typeof o.readMarker === "object") {
    for (const [k, v] of Object.entries(o.readMarker as Record<string, unknown>)) {
      // The ReadMarker contract is a NUMERIC string (Matrix ms ts / Discourse
      // post number). Keep only finite, non-negative numeric strings so corrupt
      // storage can't flow an invalid marker into the feed package (it would be
      // treated as "no marker" anyway, but we reject it up front).
      if (typeof v !== "string") continue;
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) readMarker[k] = v;
    }
  }
  return {
    matrixRooms: dedupe(matrixRooms),
    discourseTopicIds: dedupeNums(discourseTopicIds),
    includeDiscourseLatest,
    readMarker,
  };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
function dedupeNums(xs: number[]): number[] {
  return [...new Set(xs)];
}

/**
 * Load a WebID's community prefs from storage, falling back to defaults on a
 * missing/corrupt value (so a bad write can never brick the view).
 */
export function loadCommunityPrefs(webId: string, storage: PrefsStorage | null): CommunityPrefs {
  if (!storage) return defaultCommunityPrefs();
  try {
    const raw = storage.getItem(communityPrefsKey(webId));
    if (!raw) return defaultCommunityPrefs();
    return coerce(JSON.parse(raw));
  } catch {
    return defaultCommunityPrefs();
  }
}

/** Persist a WebID's community prefs to storage (no-op without storage). */
export function saveCommunityPrefs(
  webId: string,
  prefs: CommunityPrefs,
  storage: PrefsStorage | null,
): void {
  if (!storage) return;
  try {
    storage.setItem(communityPrefsKey(webId), JSON.stringify(prefs));
  } catch {
    // Quota / privacy-mode failures are non-fatal: the view still works for the
    // session, the marker just won't survive a reload.
  }
}

/**
 * Mark a thread read at `position` (a numeric string per the package's
 * {@link ReadMarker} contract: Matrix → latest seen origin_server_ts in ms;
 * Discourse → highest seen post_number). Returns a NEW prefs object (immutable
 * update — safe for React state). A non-advancing position is ignored so a
 * stale re-mark cannot resurrect unread badges.
 */
export function markThreadRead(
  prefs: CommunityPrefs,
  threadId: string,
  position: string,
): CommunityPrefs {
  const next = Number(position);
  if (!Number.isFinite(next) || next < 0) return prefs;
  const prev = Number(prefs.readMarker[threadId]);
  if (Number.isFinite(prev) && prev >= next) return prefs;
  return {
    ...prefs,
    readMarker: { ...prefs.readMarker, [threadId]: String(next) },
  };
}
