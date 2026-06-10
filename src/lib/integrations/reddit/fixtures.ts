/**
 * Recorded Reddit OAuth API shapes (oauth.reddit.com) — trimmed to the fields
 * the adapter reads. Sources: GET /api/v1/me, GET /user/{name}/saved,
 * GET /subreddits/mine/subscriber (Listing envelopes).
 */
import type { FixtureRoute } from "../core/types.js";

export interface RedditMe {
  name: string;
}

export interface RedditSavedPost {
  kind: "t3";
  data: {
    id: string;
    name: string; // fullname, e.g. "t3_1abcde"
    title: string;
    subreddit: string;
    permalink: string;
    created_utc: number;
  };
}

export interface RedditListing<T> {
  data: {
    children: T[];
    before: string | null;
    after: string | null;
  };
}

export interface RedditSubreddit {
  kind: "t5";
  data: {
    display_name: string;
    title: string;
    public_description: string;
    url: string; // "/r/solidproject/"
  };
}

export const ME: RedditMe = { name: "alice_on_reddit" };

export const SAVED: RedditListing<RedditSavedPost> = {
  data: {
    children: [
      {
        kind: "t3",
        data: {
          id: "1kx9wz",
          name: "t3_1kx9wz",
          title: "Solid pods explained for normal humans",
          subreddit: "solidproject",
          permalink: "/r/solidproject/comments/1kx9wz/solid_pods_explained/",
          created_utc: 1748854800,
        },
      },
      {
        kind: "t3",
        data: {
          id: "1koa3f",
          name: "t3_1koa3f",
          title: "What's the best sourdough starter routine?",
          subreddit: "Breadit",
          permalink: "/r/Breadit/comments/1koa3f/sourdough_starter_routine/",
          created_utc: 1748168400,
        },
      },
    ],
    before: null,
    after: null,
  },
};

export const SUBSCRIBED: RedditListing<RedditSubreddit> = {
  data: {
    children: [
      {
        kind: "t5",
        data: {
          display_name: "solidproject",
          title: "Solid Project",
          public_description: "Re-decentralizing the web.",
          url: "/r/solidproject/",
        },
      },
      {
        kind: "t5",
        data: {
          display_name: "Breadit",
          title: "Breadit",
          public_description: "A community for bread bakers.",
          url: "/r/Breadit/",
        },
      },
    ],
    before: null,
    after: null,
  },
};

export const REDDIT_FIXTURES: readonly FixtureRoute[] = [
  { url: "https://oauth.reddit.com/api/v1/me", json: ME },
  { url: "https://oauth.reddit.com/user/alice_on_reddit/saved", json: SAVED },
  { url: "https://oauth.reddit.com/subreddits/mine/subscriber", json: SUBSCRIBED },
];
