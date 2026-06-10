/**
 * Discord → Social & interests. `/users/@me` as `foaf:OnlineAccount` and
 * `/users/@me/guilds` as `foaf:Group`. Discord supports secretless PKCE for
 * public clients, so live mode needs only a client id. Snapshot semantics.
 */
import { DataFactory, Store } from "n3";
import { getJson } from "../core/fixture-fetch.js";
import type { ImportContext, ImportOutcome, IntegrationAdapter } from "../core/types.js";
import { CLASSES, Group, OnlineAccount } from "../core/vocab.js";
import { DISCORD_FIXTURES, type DiscordGuild, type DiscordUser } from "./fixtures.js";

const ID = "discord";
const API = "https://discord.com/api/v10";
const SCOPES = ["identify", "guilds"] as const;

export const discordAdapter: IntegrationAdapter = {
  metadata: {
    id: ID,
    name: "Discord",
    tier: "A",
    authKind: "oauth-pkce",
    scopes: SCOPES,
    categories: ["social"],
    whatYouGet: "Your Discord profile and the servers you belong to, in Social & interests.",
    requirements: [
      "Create an application at discord.com/developers/applications.",
      "Add <app-origin>/oauth-callback.html under OAuth2 → Redirects.",
      "Set NEXT_PUBLIC_DISCORD_CLIENT_ID — Discord supports secretless PKCE, no proxy needed.",
    ],
  },
  oauth: {
    clientId: process.env.NEXT_PUBLIC_DISCORD_CLIENT_ID,
    authorizationEndpoint: "https://discord.com/oauth2/authorize",
    tokenEndpoint: "https://discord.com/api/oauth2/token",
    scopes: SCOPES,
    tokenExchange: "public",
  },
  fixtures: () => DISCORD_FIXTURES,

  async import(ctx: ImportContext): Promise<ImportOutcome> {
    ctx.progress({ label: "Fetching your Discord profile…", done: 0, total: 2 });
    const user = await getJson<DiscordUser>(ID, ctx.api, `${API}/users/@me`);

    const profileDoc = ctx.resolve("social/profile.ttl");
    const profile = new Store();
    const account = new OnlineAccount(`${profileDoc}#account`, profile, DataFactory).mark();
    account.accountName = user.username;
    account.name = user.global_name ?? user.username;
    account.identifier = user.id;
    account.accountServiceHomepage = "https://discord.com/";
    await ctx.write({
      slug: "social/profile.ttl",
      category: "social",
      forClass: CLASSES.OnlineAccount,
      dataset: profile,
    });

    ctx.progress({ label: "Fetching your servers…", done: 1, total: 2 });
    const guilds = await getJson<DiscordGuild[]>(ID, ctx.api, `${API}/users/@me/guilds`);

    const guildsDoc = ctx.resolve("social/servers.ttl");
    const dataset = new Store();
    for (const g of guilds) {
      const group = new Group(`${guildsDoc}#guild-${g.id}`, dataset, DataFactory).mark();
      group.name = g.name;
      group.identifier = g.id;
      group.description = g.approximate_member_count
        ? `${g.approximate_member_count.toLocaleString("en")} members${g.owner ? " — you own this server" : ""}`
        : undefined;
    }
    await ctx.write({
      slug: "social/servers.ttl",
      category: "social",
      forClass: CLASSES.Group,
      dataset,
    });

    ctx.progress({ label: "Done", done: 2, total: 2 });
    return {};
  },
};
