/**
 * Recorded YouTube Data API v3 shapes (www.googleapis.com/youtube/v3) —
 * trimmed to the fields the adapter reads.
 *
 * Liked videos come from GET /videos?myRating=like (each item has a `snippet`
 * with title/description/publishedAt/channelTitle and a `contentDetails`
 * ISO-8601 `duration`). Playlists come from GET /playlists?mine=true (snippet
 * title/description plus a `contentDetails.itemCount`).
 */
import type { FixtureRoute } from "../core/types.js";

export interface YTThumbnails {
  default?: { url: string };
  high?: { url: string };
}

export interface YTVideoItem {
  id: string;
  snippet: {
    title: string;
    description: string;
    publishedAt: string;
    channelTitle: string;
    thumbnails?: YTThumbnails;
  };
  contentDetails: { duration: string };
}

export interface YTVideosList {
  items: YTVideoItem[];
  nextPageToken?: string;
}

export interface YTPlaylistItem {
  id: string;
  snippet: { title: string; description: string; publishedAt: string; channelTitle: string };
  contentDetails: { itemCount: number };
}

export interface YTPlaylistsList {
  items: YTPlaylistItem[];
  nextPageToken?: string;
}

export const LIKED_VIDEOS: YTVideosList = {
  items: [
    {
      id: "dQw4w9WgXcQ",
      snippet: {
        title: "Rick Astley - Never Gonna Give You Up (Official Video)",
        description: "The official video for Never Gonna Give You Up.",
        publishedAt: "2009-10-25T06:57:33Z",
        channelTitle: "Rick Astley",
        thumbnails: { high: { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" } },
      },
      contentDetails: { duration: "PT3M33S" },
    },
    {
      id: "9bZkp7q19f0",
      snippet: {
        title: "PSY - GANGNAM STYLE",
        description: "PSY - GANGNAM STYLE music video.",
        publishedAt: "2012-07-15T07:46:32Z",
        channelTitle: "officialpsy",
      },
      contentDetails: { duration: "PT4M13S" },
    },
  ],
};

export const PLAYLISTS: YTPlaylistsList = {
  items: [
    {
      id: "PLrAXtmRdnEQy6nuLMHjMZOz59O",
      snippet: {
        title: "Watch later",
        description: "Saved for later.",
        publishedAt: "2024-01-02T10:00:00Z",
        channelTitle: "My Channel",
      },
      contentDetails: { itemCount: 42 },
    },
    {
      id: "PLFgquLnL59ak3Oj9XVnrJaQ8B",
      snippet: {
        title: "Cooking",
        description: "Recipes to try.",
        publishedAt: "2023-11-20T18:30:00Z",
        channelTitle: "My Channel",
      },
      contentDetails: { itemCount: 17 },
    },
  ],
};

export const YOUTUBE_FIXTURES: readonly FixtureRoute[] = [
  { url: "https://www.googleapis.com/youtube/v3/videos", json: LIKED_VIDEOS },
  { url: "https://www.googleapis.com/youtube/v3/playlists", json: PLAYLISTS },
];
