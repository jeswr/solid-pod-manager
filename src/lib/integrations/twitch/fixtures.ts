/**
 * Recorded Twitch Helix shapes (api.twitch.tv/helix) — trimmed to the fields
 * the adapter reads. Sources: GET /users, GET /channels/followed.
 */
import type { FixtureRoute } from "../core/types.js";

export interface TwitchUser {
  id?: string | null;
  login?: string | null;
  display_name?: string | null;
}

export interface TwitchUsersAnswer {
  data?: (TwitchUser | null)[] | null;
}

export interface TwitchFollowedChannel {
  broadcaster_id?: string | null;
  broadcaster_login?: string | null;
  broadcaster_name?: string | null;
  followed_at?: string | null; // ISO
}

export interface TwitchFollowsAnswer {
  total?: number | null;
  data?: (TwitchFollowedChannel | null)[] | null;
  pagination?: { cursor?: string | null } | null;
}

export const USERS: TwitchUsersAnswer = {
  data: [{ id: "141981764", login: "alice_v", display_name: "AliceV" }],
};

export const FOLLOWS: TwitchFollowsAnswer = {
  total: 2,
  data: [
    {
      broadcaster_id: "71092938",
      broadcaster_login: "xqc",
      broadcaster_name: "xQc",
      followed_at: "2025-09-14T19:21:00Z",
    },
    {
      broadcaster_id: "207813352",
      broadcaster_login: "hasanabi",
      broadcaster_name: "HasanAbi",
      followed_at: "2024-12-02T08:05:00Z",
    },
  ],
  pagination: {},
};

export const TWITCH_FIXTURES: readonly FixtureRoute[] = [
  { url: "https://api.twitch.tv/helix/channels/followed", json: FOLLOWS },
  { url: "https://api.twitch.tv/helix/users", json: USERS },
];
