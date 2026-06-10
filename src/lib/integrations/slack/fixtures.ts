/**
 * Recorded Slack Web API shapes (slack.com/api) — trimmed to the fields the
 * adapter reads.
 *
 * GET auth.test returns the workspace (`team`, `team_id`, `url`). GET
 * conversations.list returns the channels the user can see: each has an `id`,
 * `name`, `is_channel`, `num_members`, a `topic`/`purpose`, and a `created`
 * epoch. Slack envelopes carry an `ok` boolean.
 */
import type { FixtureRoute } from "../core/types.js";

export interface SlackAuthTest {
  ok: boolean;
  url: string;
  team: string;
  team_id: string;
  user: string;
  user_id: string;
}

export interface SlackChannel {
  id: string;
  name: string;
  is_channel: boolean;
  is_private: boolean;
  num_members?: number;
  created: number;
  topic?: { value: string };
  purpose?: { value: string };
}

export interface SlackConversationsList {
  ok: boolean;
  channels: SlackChannel[];
  response_metadata?: { next_cursor?: string };
}

export const AUTH_TEST: SlackAuthTest = {
  ok: true,
  url: "https://acme-team.slack.com/",
  team: "Acme Team",
  team_id: "T01ABCDEF",
  user: "alice",
  user_id: "U01ABCDEF",
};

export const CHANNELS: SlackConversationsList = {
  ok: true,
  channels: [
    {
      id: "C01GENERAL",
      name: "general",
      is_channel: true,
      is_private: false,
      num_members: 128,
      created: 1_609_459_200,
      topic: { value: "Company-wide announcements and chatter." },
      purpose: { value: "This channel is for team-wide communication." },
    },
    {
      id: "C02ENGINEER",
      name: "engineering",
      is_channel: true,
      is_private: false,
      num_members: 34,
      created: 1_612_137_600,
      topic: { value: "Ship it." },
      purpose: { value: "Engineering discussion." },
    },
    {
      id: "C03RANDOM",
      name: "random",
      is_channel: true,
      is_private: false,
      num_members: 96,
      created: 1_609_459_200,
      purpose: { value: "Non-work banter." },
    },
  ],
};

export const SLACK_FIXTURES: readonly FixtureRoute[] = [
  { url: "https://slack.com/api/auth.test", json: AUTH_TEST },
  { url: "https://slack.com/api/conversations.list", json: CHANNELS },
];
