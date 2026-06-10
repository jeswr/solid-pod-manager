/**
 * Recorded Facebook Graph API shapes (graph.facebook.com) — trimmed to the
 * fields the adapter reads.
 *
 * GET /me/posts returns the user's own posts (`message`, `created_time`,
 * `permalink_url`). GET /me/groups returns the groups they belong to (`name`,
 * `id`). The adapter maps posts to `schema:SocialMediaPosting` and groups to
 * `foaf:Group`, both in Social & interests.
 */
import type { FixtureRoute } from "../core/types.js";

export interface FbPost {
  id: string;
  message?: string;
  story?: string;
  created_time: string;
  permalink_url: string;
}

export interface FbPostsAnswer {
  data: FbPost[];
  paging?: { next?: string };
}

export interface FbGroup {
  id: string;
  name: string;
  member_count?: number;
}

export interface FbGroupsAnswer {
  data: FbGroup[];
  paging?: { next?: string };
}

export const POSTS: FbPostsAnswer = {
  data: [
    {
      id: "10221234567890123_10224567890123456",
      message: "Back from a brilliant week in the mountains. Already planning the next trip!",
      created_time: "2026-05-15T17:42:00+0000",
      permalink_url: "https://www.facebook.com/10221234567890123/posts/10224567890123456",
    },
    {
      id: "10221234567890123_10224999888777666",
      story: "Updated their profile picture.",
      created_time: "2026-05-02T09:10:00+0000",
      permalink_url: "https://www.facebook.com/10221234567890123/posts/10224999888777666",
    },
  ],
};

export const GROUPS: FbGroupsAnswer = {
  data: [
    { id: "284756192837465", name: "Local Hiking Club", member_count: 1240 },
    { id: "190283746523819", name: "Vintage Synth Enthusiasts", member_count: 8765 },
  ],
};

export const FACEBOOK_FIXTURES: readonly FixtureRoute[] = [
  { url: "https://graph.facebook.com/v20.0/me/posts", json: POSTS },
  { url: "https://graph.facebook.com/v20.0/me/groups", json: GROUPS },
];
