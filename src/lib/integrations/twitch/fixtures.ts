/**
 * Recorded Twitch Helix shapes (api.twitch.tv/helix) — trimmed to the fields
 * the adapter reads. Sources: GET /users, GET /channels/followed.
 */
import type { FixtureRoute } from "../core/types.js";

export interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
}

export interface TwitchUsersAnswer {
  data: TwitchUser[];
}

export interface TwitchFollowedChannel {
  broadcaster_id: string;
  broadcaster_login: string;
  broadcaster_name: string;
  followed_at: string; // ISO
}

export interface TwitchFollowsAnswer {
  total: number;
  data: TwitchFollowedChannel[];
  pagination: { cursor?: string };
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
