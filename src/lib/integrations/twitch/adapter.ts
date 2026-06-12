/**
 * Twitch → Media. `/helix/channels/followed` as `schema:WatchAction` (the
 * channels you follow, with when you followed them). Helix requires a
 * `Client-Id` header on every call.
 *
 * Live-mode honesty: Twitch's authorization-code grant requires the client
 * secret (no public PKCE) — live mode needs the maintainer's token proxy.
 * Snapshot semantics (the follows listing has page cursors, not change
 * cursors).
 */
import { DataFactory, Store } from "n3";
import { getJson } from "../core/fixture-fetch.js";
import { arr, optionalDate, optionalText, SkipCounter } from "../core/safe.js";
import { IntegrationSyncError } from "../core/errors.js";
import type { ImportContext, ImportOutcome, IntegrationAdapter } from "../core/types.js";
import { CLASSES, WatchAction } from "../core/vocab.js";
import { TWITCH_FIXTURES, type TwitchFollowsAnswer, type TwitchUsersAnswer } from "./fixtures.js";

const ID = "twitch";
const API = "https://api.twitch.tv/helix";
const SCOPES = ["user:read:follows"] as const;

export const twitchAdapter: IntegrationAdapter = {
  metadata: {
    id: ID,
    name: "Twitch",
    tier: "A",
    authKind: "oauth-pkce",
    scopes: SCOPES,
    categories: ["media"],
    whatYouGet: "The channels you follow, saved into Media with when you followed them.",
    requirements: [
      "Register an application at dev.twitch.tv/console/apps.",
      "Add <app-origin>/oauth-callback.html as an OAuth Redirect URL.",
      "Set NEXT_PUBLIC_TWITCH_CLIENT_ID.",
      "Twitch's token endpoint requires the client secret (no public PKCE): deploy the token-exchange proxy and set NEXT_PUBLIC_TWITCH_TOKEN_PROXY.",
    ],
  },
  oauth: {
    clientId: process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID,
    authorizationEndpoint: "https://id.twitch.tv/oauth2/authorize",
    tokenEndpoint: "https://id.twitch.tv/oauth2/token",
    scopes: SCOPES,
    tokenExchange: "proxy",
    tokenProxyUrl: process.env.NEXT_PUBLIC_TWITCH_TOKEN_PROXY,
  },
  // Helix rejects calls without the app's Client-Id header.
  apiHeaders: { "client-id": process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID ?? "" },
  fixtures: () => TWITCH_FIXTURES,

  async import(ctx: ImportContext): Promise<ImportOutcome> {
    const skipped = new SkipCounter();

    ctx.progress({ label: "Checking who you are on Twitch…", done: 0, total: 2 });
    const users = await getJson<TwitchUsersAnswer>(ID, ctx.api, `${API}/users`);
    // `data` can be an empty array; the follows endpoint needs our user id, so
    // a missing id is genuinely fatal (not a per-item skip).
    const me = arr(users?.data)[0];
    const myId = optionalText(me?.id);
    if (myId === undefined) {
      throw new IntegrationSyncError(ID, "Twitch did not return your user id — cannot list follows.");
    }

    ctx.progress({ label: "Fetching the channels you follow…", done: 1, total: 2 });
    const follows = await getJson<TwitchFollowsAnswer>(
      ID,
      ctx.api,
      `${API}/channels/followed?user_id=${encodeURIComponent(myId)}&first=100`,
    );

    const doc = ctx.resolve("media/followed-channels.ttl");
    const dataset = new Store();
    for (const f of arr(follows?.data)) {
      // A follow with no broadcaster id has no stable fragment IRI — skip it.
      const broadcasterId = f ? optionalText(f.broadcaster_id) : undefined;
      if (!f || broadcasterId === undefined) {
        skipped.skip();
        continue;
      }
      const watch = new WatchAction(
        `${doc}#follow-${broadcasterId}`,
        dataset,
        DataFactory,
      ).mark();
      watch.name = optionalText(f.broadcaster_name);
      watch.identifier = broadcasterId;
      const login = optionalText(f.broadcaster_login);
      watch.sourceUrl = login !== undefined ? `https://www.twitch.tv/${login}` : undefined;
      watch.startTime = optionalDate(f.followed_at);
    }
    await ctx.write({
      slug: "media/followed-channels.ttl",
      category: "media",
      forClass: CLASSES.WatchAction,
      dataset,
    });

    ctx.progress({ label: "Done", done: 2, total: 2 });
    return { skipped: skipped.value };
  },
};
