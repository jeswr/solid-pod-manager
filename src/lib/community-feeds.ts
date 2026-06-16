// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Community feeds — the Pod Manager's bridge to `@jeswr/solid-community-feeds`.
 *
 * Builds a unified, newest-first feed of the Solid community's channels — the
 * Solid **forum** (forum.solidproject.org, Discourse) and the Solid **chat**
 * rooms (matrix.org) — so the user sees the threads they care about inside PM.
 *
 *   - The **forum** read path needs NO credential — it works out of the box, so
 *     a brand-new user immediately sees the Solid forum's latest topics.
 *   - The **Matrix** rooms only produce a feed once the user connects a Matrix
 *     access token (`community-credentials.ts`). Without it the Matrix source is
 *     simply omitted, so the forum feed still renders (the package also collects
 *     any per-source error rather than throwing — one source failing never
 *     blanks the other).
 *
 * FETCH SEAM — IMPORTANT: these are PUBLIC third-party hosts (matrix.org,
 * forum.solidproject.org), NOT the user's pod. PM's session provider PATCHES
 * `globalThis.fetch` with the reactive-auth wrapper (which, on a 401, re-issues
 * with Solid DPoP/bearer credentials when a provider matches the host). We must
 * NEVER risk that on a third-party host, so we use the PRISTINE native `fetch`
 * captured at boot before the patch ({@link getNativeFetch} — see
 * `native-fetch.ts`), guaranteeing these requests bypass the Solid auth layer
 * entirely. The package's `safeFetch` additionally enforces https-only + an
 * SSRF host block + no-redirect + a timeout/size cap on every outbound request.
 * `fetch` stays injectable purely for tests.
 *
 * Credentials (the Matrix token, the optional Discourse user API key) are passed
 * via source config and are never logged.
 */
import {
  CommunityFeed,
  DiscourseFeedSource,
  MatrixFeedSource,
  SOLID_CHANNELS,
} from "@jeswr/solid-community-feeds";
import type {
  CommunityThread,
  FeedResult,
  FetchLike,
} from "@jeswr/solid-community-feeds";
import { getCommunityCredentials } from "./community-credentials.js";
import type { CommunityPrefs } from "./community-prefs.js";
import { getNativeFetch } from "./native-fetch.js";

/** Re-export the unified thread type for the UI/hook (single import site). */
export type { CommunityThread, FeedResult } from "@jeswr/solid-community-feeds";

/**
 * The numeric read-position a thread is "at" (for the read marker), per the
 * package's ReadMarker contract:
 *   - Matrix → the newest message's `origin_server_ts` in **ms**.
 *   - Discourse → the highest `post_number` (≈ messageCount).
 * Best-effort: returns `undefined` when the thread carries no messages and no
 * count to derive a position from.
 */
export function threadReadPosition(thread: CommunityThread): string | undefined {
  if (thread.source === "matrix") {
    const newest = thread.messages?.[0];
    if (newest) return String(Date.parse(newest.createdAt));
    // Fall back to the thread's last activity timestamp.
    const ts = Date.parse(thread.lastActivityAt);
    return Number.isFinite(ts) ? String(ts) : undefined;
  }
  // Discourse: post_number — the message count is the highest seen post number.
  if (typeof thread.messageCount === "number" && thread.messageCount > 0) {
    return String(thread.messageCount);
  }
  return undefined;
}

/**
 * Construct a {@link CommunityFeed} for the current prefs + connected
 * credentials. The Discourse source is ALWAYS present (public read). The Matrix
 * source is added only when a Matrix access token is connected.
 *
 * @param fetchImpl - test-only override of the outbound fetch. **Omit in
 *   production**; the pristine native `fetch` ({@link getNativeFetch}) is used,
 *   bypassing the Solid auth layer (these are public hosts — NOT the pod; see
 *   the file header). If no native fetch was captured (SSR), the package
 *   defaults to `globalThis.fetch`.
 */
export function buildCommunityFeed(fetchImpl?: FetchLike): CommunityFeed {
  const creds = getCommunityCredentials();
  const outbound = fetchImpl ?? (getNativeFetch() as FetchLike | undefined);
  const fetchOpts = outbound ? { fetch: outbound } : {};

  const discourse = new DiscourseFeedSource(
    {
      baseUrl: SOLID_CHANNELS.forumBaseUrl,
      ...(creds.discourseUserApiKey ? { userApiKey: creds.discourseUserApiKey } : {}),
      ...(creds.discourseUserApiClientId
        ? { userApiClientId: creds.discourseUserApiClientId }
        : {}),
    },
    fetchOpts,
  );

  const sources: ConstructorParameters<typeof CommunityFeed>[0] = { discourse };
  if (creds.matrixAccessToken) {
    sources.matrix = new MatrixFeedSource(
      { homeserverUrl: SOLID_CHANNELS.matrixHomeserver, accessToken: creds.matrixAccessToken },
      fetchOpts,
    );
  }
  return new CommunityFeed(sources);
}

/**
 * Fetch the unified community feed for the given preferences. The Matrix rooms
 * are only queried when a token is connected (otherwise they would each yield a
 * per-source 401 error — we skip them so the forum feed renders cleanly).
 */
export async function fetchCommunityFeed(
  prefs: CommunityPrefs,
  fetchImpl?: FetchLike,
): Promise<FeedResult> {
  const creds = getCommunityCredentials();
  const feed = buildCommunityFeed(fetchImpl);
  return feed.getFeed(
    {
      // Only ask for Matrix rooms when we actually have a token.
      ...(creds.matrixAccessToken && prefs.matrixRooms.length
        ? { matrixRooms: prefs.matrixRooms }
        : {}),
      ...(prefs.discourseTopicIds.length ? { discourseTopicIds: prefs.discourseTopicIds } : {}),
      includeDiscourseLatest: prefs.includeDiscourseLatest,
    },
    prefs.readMarker,
  );
}
