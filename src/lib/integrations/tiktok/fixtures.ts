/**
 * Recorded TikTok Display API shapes (open.tiktokapis.com/v2) — trimmed to the
 * fields the adapter reads.
 *
 * POST /v2/video/list/ returns the user's own videos: each has an `id`, a
 * `title`, a `video_description`, a `share_url`, a `cover_image_url`, a
 * `duration` (seconds), a `create_time` (epoch seconds) and a `view_count`.
 */
import type { FixtureRoute } from "../core/types.js";

export interface TikTokVideo {
  id: string;
  title: string;
  video_description: string;
  share_url: string;
  cover_image_url: string;
  duration: number;
  create_time: number;
  view_count: number;
}

export interface TikTokVideoListAnswer {
  data: { videos: TikTokVideo[]; cursor?: number; has_more?: boolean };
  error?: { code: string; message: string };
}

export const VIDEO_LIST: TikTokVideoListAnswer = {
  data: {
    videos: [
      {
        id: "7341234567890123456",
        title: "Sunrise timelapse",
        video_description: "5am wake-up was worth it #sunrise #timelapse",
        share_url: "https://www.tiktok.com/@user/video/7341234567890123456",
        cover_image_url: "https://p16.tiktokcdn.com/cover/7341234567890123456.jpg",
        duration: 17,
        create_time: 1_747_651_200,
        view_count: 18420,
      },
      {
        id: "7342345678901234567",
        title: "30-second pasta",
        video_description: "the only recipe you need 🍝 #cooking",
        share_url: "https://www.tiktok.com/@user/video/7342345678901234567",
        cover_image_url: "https://p16.tiktokcdn.com/cover/7342345678901234567.jpg",
        duration: 32,
        create_time: 1_747_824_000,
        view_count: 96100,
      },
    ],
    cursor: 1_747_824_000,
    has_more: false,
  },
};

export const TIKTOK_FIXTURES: readonly FixtureRoute[] = [
  { method: "POST", url: "https://open.tiktokapis.com/v2/video/list/", json: VIDEO_LIST },
];
