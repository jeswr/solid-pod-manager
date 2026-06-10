/**
 * Recorded Discord API v10 shapes (discord.com/api) — trimmed to the fields
 * the adapter reads. Sources: GET /users/@me, GET /users/@me/guilds.
 */
import type { FixtureRoute } from "../core/types.js";

export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
}

export interface DiscordGuild {
  id: string;
  name: string;
  owner: boolean;
  approximate_member_count?: number;
}

export const USER: DiscordUser = {
  id: "80351110224678912",
  username: "alice_v",
  global_name: "Alice",
};

export const GUILDS: DiscordGuild[] = [
  {
    id: "197038439483310086",
    name: "Solid Community",
    owner: false,
    approximate_member_count: 2480,
  },
  {
    id: "613425648685547541",
    name: "Sourdough Bakers",
    owner: true,
    approximate_member_count: 312,
  },
];

export const DISCORD_FIXTURES: readonly FixtureRoute[] = [
  { url: "https://discord.com/api/v10/users/@me/guilds", json: GUILDS },
  { url: "https://discord.com/api/v10/users/@me", json: USER },
];
