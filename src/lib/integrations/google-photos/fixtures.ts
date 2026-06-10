/**
 * Recorded Google Photos Library API shapes
 * (photoslibrary.googleapis.com/v1) — trimmed to the fields the adapter reads.
 * Source: GET /v1/mediaItems. Each item carries a `baseUrl` (the hosted
 * asset), a `mimeType`, a filename, and a `mediaMetadata` block with
 * creation time and pixel dimensions; videos add a `video` sub-block.
 */
import type { FixtureRoute } from "../core/types.js";

export interface GPhotosMediaMetadata {
  creationTime: string;
  width: string;
  height: string;
  photo?: Record<string, unknown>;
  video?: { fps?: number; status?: string };
}

export interface GPhotosMediaItem {
  id: string;
  productUrl: string;
  baseUrl: string;
  mimeType: string;
  filename: string;
  description?: string;
  mediaMetadata: GPhotosMediaMetadata;
}

export interface GPhotosMediaItemsList {
  mediaItems: GPhotosMediaItem[];
  nextPageToken?: string;
}

export const MEDIA_ITEMS: GPhotosMediaItemsList = {
  mediaItems: [
    {
      id: "AGj1epU8f9k2mNq",
      productUrl: "https://photos.google.com/lr/photo/AGj1epU8f9k2mNq",
      baseUrl: "https://lh3.googleusercontent.com/lr/AGj1epU8f9k2mNq",
      mimeType: "image/jpeg",
      filename: "IMG_4821.jpg",
      description: "Sunset over the bay",
      mediaMetadata: {
        creationTime: "2026-05-20T18:42:11Z",
        width: "4032",
        height: "3024",
        photo: {},
      },
    },
    {
      id: "BHk2fqV9g0l3oOr",
      productUrl: "https://photos.google.com/lr/photo/BHk2fqV9g0l3oOr",
      baseUrl: "https://lh3.googleusercontent.com/lr/BHk2fqV9g0l3oOr",
      mimeType: "image/heic",
      filename: "IMG_4822.heic",
      mediaMetadata: {
        creationTime: "2026-05-21T09:15:03Z",
        width: "3024",
        height: "4032",
        photo: {},
      },
    },
    {
      id: "CIl3grW0h1m4pPs",
      productUrl: "https://photos.google.com/lr/photo/CIl3grW0h1m4pPs",
      baseUrl: "https://lh3.googleusercontent.com/lr/CIl3grW0h1m4pPs",
      mimeType: "video/mp4",
      filename: "VID_1003.mp4",
      description: "Birthday candles",
      mediaMetadata: {
        creationTime: "2026-05-22T20:01:44Z",
        width: "1920",
        height: "1080",
        video: { fps: 30, status: "READY" },
      },
    },
  ],
};

export const GOOGLE_PHOTOS_FIXTURES: readonly FixtureRoute[] = [
  { url: "https://photoslibrary.googleapis.com/v1/mediaItems", json: MEDIA_ITEMS },
];
