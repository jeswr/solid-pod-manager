/**
 * Recorded Instagram Graph API shapes (graph.instagram.com) — trimmed to the
 * fields the adapter reads.
 *
 * GET /me/media returns the user's own media: each item has an `id`,
 * `media_type` (IMAGE | VIDEO | CAROUSEL_ALBUM), a `media_url`, a `permalink`,
 * an optional `caption`, and a `timestamp`.
 */
import type { FixtureRoute } from "../core/types.js";

export interface IgMediaItem {
  id: string;
  media_type: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
  media_url: string;
  permalink: string;
  caption?: string;
  timestamp: string;
}

export interface IgMediaAnswer {
  data: IgMediaItem[];
  paging?: { cursors?: { after?: string }; next?: string };
}

export const MEDIA: IgMediaAnswer = {
  data: [
    {
      id: "17895695668004550",
      media_type: "IMAGE",
      media_url: "https://scontent.cdninstagram.com/v/t51/17895695668004550.jpg",
      permalink: "https://www.instagram.com/p/CqL8z3kAbCd/",
      caption: "Golden hour at the coast 🌅 #sunset",
      timestamp: "2026-05-18T19:30:11+0000",
    },
    {
      id: "17912345678901234",
      media_type: "VIDEO",
      media_url: "https://scontent.cdninstagram.com/v/t51/17912345678901234.mp4",
      permalink: "https://www.instagram.com/reel/CqM1n9kAxYz/",
      caption: "Quick recipe reel 🍝",
      timestamp: "2026-05-20T12:05:44+0000",
    },
    {
      id: "17934567890123456",
      media_type: "CAROUSEL_ALBUM",
      media_url: "https://scontent.cdninstagram.com/v/t51/17934567890123456.jpg",
      permalink: "https://www.instagram.com/p/CqN4p2kAdEf/",
      timestamp: "2026-05-22T08:15:00+0000",
    },
  ],
};

export const INSTAGRAM_FIXTURES: readonly FixtureRoute[] = [
  { url: "https://graph.instagram.com/me/media", json: MEDIA },
];
