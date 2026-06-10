/**
 * Recorded X (Twitter) API v2 shapes (api.twitter.com/2) — trimmed to the
 * fields the adapter reads.
 *
 * GET /2/users/me/tweets returns the authenticated user's tweets in a `data`
 * array; each tweet has an `id`, `text`, `created_at` and a `public_metrics`
 * block. An `includes`/`meta` envelope rounds it out (unused here).
 */
import type { FixtureRoute } from "../core/types.js";

export interface XTweet {
  id: string;
  text: string;
  created_at: string;
  public_metrics?: {
    retweet_count: number;
    reply_count: number;
    like_count: number;
    quote_count: number;
  };
}

export interface XTweetsAnswer {
  data: XTweet[];
  meta?: { result_count: number; next_token?: string };
}

export const TWEETS: XTweetsAnswer = {
  data: [
    {
      id: "1789012345678901234",
      text: "Shipping data portability for the open web. The pod is the product. 🧵",
      created_at: "2026-05-19T14:22:07.000Z",
      public_metrics: { retweet_count: 42, reply_count: 8, like_count: 311, quote_count: 5 },
    },
    {
      id: "1789098765432109876",
      text: "Reminder: you should own your data, and be able to take it anywhere.",
      created_at: "2026-05-21T09:01:55.000Z",
      public_metrics: { retweet_count: 17, reply_count: 3, like_count: 128, quote_count: 1 },
    },
  ],
  meta: { result_count: 2 },
};

export const X_TWITTER_FIXTURES: readonly FixtureRoute[] = [
  { url: "https://api.twitter.com/2/users/me/tweets", json: TWEETS },
];
