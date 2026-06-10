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
import { facebookAdapter } from "./facebook/adapter.js";
import { fitbitAdapter } from "./fitbit/adapter.js";
import { garminAdapter } from "./garmin/adapter.js";
import { githubAdapter } from "./github/adapter.js";
import { googleCalendarAdapter } from "./google-calendar/adapter.js";
import { googlePhotosAdapter } from "./google-photos/adapter.js";
import { instagramAdapter } from "./instagram/adapter.js";
import { linkedinAdapter } from "./linkedin/adapter.js";
import { notionAdapter } from "./notion/adapter.js";
import { pinterestAdapter } from "./pinterest/adapter.js";
import { redditAdapter } from "./reddit/adapter.js";
import { slackAdapter } from "./slack/adapter.js";
import { spotifyAdapter } from "./spotify/adapter.js";
import { stravaAdapter } from "./strava/adapter.js";
import { tiktokAdapter } from "./tiktok/adapter.js";
import { twitchAdapter } from "./twitch/adapter.js";
import { xTwitterAdapter } from "./x-twitter/adapter.js";
import { youtubeAdapter } from "./youtube/adapter.js";
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

/**
 * The 12 Tier-B adapters — real OAuth APIs with working fixture-backed
 * imports, but platform app-review gates any **live** user connect. They are
 * full {@link IntegrationAdapter}s (so the demo import is real), yet
 * {@link statusOf} keeps them `"approval-needed"`: even with a client id, the
 * platform must approve the app before it can touch a real account.
 */
export const TIER_B_ADAPTERS: readonly IntegrationAdapter[] = [
  googleCalendarAdapter,
  googlePhotosAdapter,
  youtubeAdapter,
  fitbitAdapter,
  garminAdapter,
  instagramAdapter,
  facebookAdapter,
  tiktokAdapter,
  linkedinAdapter,
  xTwitterAdapter,
  slackAdapter,
  pinterestAdapter,
];

/** Every adapter the app can run an import for (Tier A live/demo + Tier B demo). */
export const ALL_ADAPTERS: readonly IntegrationAdapter[] = [...ADAPTERS, ...TIER_B_ADAPTERS];

const byId = new Map(ALL_ADAPTERS.map((a) => [a.metadata.id, a]));

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

/**
 * Tier B — real OAuth APIs exist with working fixture-backed imports, but
 * platform approval gates any **live** user connect. Derived from the adapters'
 * own metadata (single source of truth); the `blocker` is the first
 * requirement, which each adapter states as its specific platform gate.
 */
export const TIER_B: readonly CatalogEntry[] = TIER_B_ADAPTERS.map((a) => ({
  ...a.metadata,
  blocker: a.metadata.requirements[0],
}));

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
