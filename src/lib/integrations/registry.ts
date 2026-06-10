/**
 * The integrations registry — every app in docs/integrations-catalog.md, all
 * 30 visible, each with its honest status:
 *
 * - Tier A + client id (+ proxy where the platform demands one) → **live**
 * - Tier A unconfigured → **demo** (full UX against recorded fixtures)
 * - Tier B → **approval-needed** (platform review gates any user connect)
 * - Tier C → **export-file** (no user-grade API; file import in a later increment)
 *
 * The gate is env-only: an adapter goes live iff `NEXT_PUBLIC_<APP>_CLIENT_ID`
 * is present at build time (each adapter references its env var literally so
 * Next.js can inline it).
 */
import { discordAdapter } from "./discord/adapter.js";
import { dropboxAdapter } from "./dropbox/adapter.js";
import { githubAdapter } from "./github/adapter.js";
import { notionAdapter } from "./notion/adapter.js";
import { redditAdapter } from "./reddit/adapter.js";
import { spotifyAdapter } from "./spotify/adapter.js";
import { stravaAdapter } from "./strava/adapter.js";
import { twitchAdapter } from "./twitch/adapter.js";
import type { IntegrationAdapter, IntegrationMetadata } from "./core/types.js";

/** A renderable catalog row — metadata plus tier-specific honesty fields. */
export interface CatalogEntry extends IntegrationMetadata {
  /** Tier B: why it isn't connectable yet. */
  readonly blocker?: string;
  /** Tier C: the official export users will be able to import. */
  readonly exportFormat?: string;
}

/** What the UI may render for an entry right now. */
export type IntegrationStatus = "live" | "demo" | "approval-needed" | "export-file";

/** The 8 Tier-A adapters (docs/integrations-catalog.md). */
export const ADAPTERS: readonly IntegrationAdapter[] = [
  spotifyAdapter,
  githubAdapter,
  stravaAdapter,
  redditAdapter,
  discordAdapter,
  twitchAdapter,
  notionAdapter,
  dropboxAdapter,
];

const byId = new Map(ADAPTERS.map((a) => [a.metadata.id, a]));

export function adapterById(id: string): IntegrationAdapter | undefined {
  return byId.get(id);
}

/**
 * Live iff the platform client id is configured AND, for platforms that
 * refuse secretless PKCE, the token proxy is too. Nothing else flips it.
 */
export function isLive(adapter: IntegrationAdapter): boolean {
  const oauth = adapter.oauth;
  if (!oauth?.clientId) return false;
  if (oauth.tokenExchange === "proxy" && !oauth.tokenProxyUrl) return false;
  return true;
}

export function statusOf(entry: CatalogEntry): IntegrationStatus {
  if (entry.tier === "B") return "approval-needed";
  if (entry.tier === "C") return "export-file";
  const adapter = byId.get(entry.id);
  return adapter && isLive(adapter) ? "live" : "demo";
}

const B = (
  id: string,
  name: string,
  categories: string[],
  whatYouGet: string,
  blocker: string,
): CatalogEntry => ({
  id,
  name,
  tier: "B",
  authKind: "none",
  scopes: [],
  categories,
  whatYouGet,
  requirements: [blocker],
  blocker,
});

const C = (
  id: string,
  name: string,
  categories: string[],
  whatYouGet: string,
  exportFormat: string,
): CatalogEntry => ({
  id,
  name,
  tier: "C",
  authKind: "export-file",
  scopes: [],
  categories,
  whatYouGet,
  requirements: [],
  exportFormat,
});

/** Tier B — real OAuth APIs exist, but platform approval gates any user connect. */
export const TIER_B: readonly CatalogEntry[] = [
  B("google-calendar", "Google Calendar", ["calendar"], "Your events and appointments into Calendar.", "Google OAuth verification + restricted-scope review."),
  B("google-photos", "Google Photos", ["media"], "Your photo library metadata into Media.", "Photos Library API approval."),
  B("youtube", "YouTube", ["media"], "Subscriptions and playlists into Media.", "YouTube API audit for history scopes."),
  B("fitbit", "Fitbit", ["health"], "Steps, sleep and heart data into Health.", "Fitbit developer app review for intraday data."),
  B("garmin", "Garmin", ["health", "mobility"], "Workouts and journeys into Health and Mobility.", "Garmin partner-program (Health/Connect API) approval."),
  B("instagram", "Instagram", ["media", "social"], "Your posts and profile into Media and Social.", "Meta app review."),
  B("facebook", "Facebook", ["social"], "Your profile, posts and groups into Social & interests.", "Meta app review."),
  B("tiktok", "TikTok", ["media", "social"], "Your videos and likes into Media and Social.", "TikTok developer audit."),
  B("linkedin", "LinkedIn", ["work-education"], "Your positions and education into Work & education.", "LinkedIn Member-data program approval."),
  B("x-twitter", "X (Twitter)", ["social"], "Your posts and follows into Social & interests.", "Paid API tier + elevated access."),
  B("slack", "Slack", ["work-education"], "Your workspaces and channels into Work & education.", "Workspace-admin install approval."),
  B("pinterest", "Pinterest", ["media", "social"], "Your boards and pins into Media and Social.", "Pinterest trial-access review."),
];

/** Tier C — no user-grade API; the platform's official export file instead. */
export const TIER_C: readonly CatalogEntry[] = [
  C("netflix", "Netflix", ["media"], "Your viewing history into Media.", "Viewing-activity CSV"),
  C("amazon-orders", "Amazon orders", ["finance"], "Your order history into Finance.", "Order-history export"),
  C("uber", "Uber", ["mobility", "finance"], "Your trips and receipts into Mobility and Finance.", "Data download (ZIP/CSV)"),
  C("apple-health", "Apple Health", ["health"], "Workouts and vitals into Health.", "Health export.zip (XML)"),
  C("whatsapp", "WhatsApp", ["social"], "Chat history into Social & interests.", "Chat export (TXT)"),
  C("goodreads", "Goodreads", ["documents"], "Your library and reviews into Documents.", "Library export CSV"),
  C("steam", "Steam", ["media", "social"], "Your games and playtime into Media and Social.", "Account-data export"),
  C("chatgpt", "ChatGPT", ["documents"], "Your conversations into Documents.", "Conversations export (JSON)"),
  C("bank-statements", "Bank statements", ["finance"], "Transactions into Finance.", "CSV / OFX statements"),
  C("google-takeout", "Google Takeout", ["documents", "media", "calendar"], "Everything Google holds, filed by category.", "Takeout archive"),
];

/** All 30 catalog entries, A → B → C, in display order. */
export function allCatalogEntries(): CatalogEntry[] {
  return [...ADAPTERS.map((a) => ({ ...a.metadata })), ...TIER_B, ...TIER_C];
}
