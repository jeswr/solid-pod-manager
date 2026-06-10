/**
 * YouTube → Media. Your liked videos (`/youtube/v3/videos?myRating=like`) as
 * `schema:VideoObject`, and your playlists (`/youtube/v3/playlists?mine=true`)
 * as `schema:MusicPlaylist`.
 *
 * Vocab note: schema.org has no generic "video playlist" class, so playlists
 * reuse `schema:MusicPlaylist` — the closest media-mapped collection class
 * (it carries name + numTracks and lands in Media, which is what the user
 * sees). The items themselves are correctly `schema:VideoObject`.
 *
 * Tier B: YouTube requires an API compliance audit before scopes that read a
 * user's history/likes can serve real users. Google web clients are
 * confidential, so live mode runs code→token through the maintainer proxy.
 * Demoable now against recorded fixtures.
 */
import { DataFactory, Store } from "n3";
import { getJson } from "../core/fixture-fetch.js";
import type { ImportContext, ImportOutcome, IntegrationAdapter } from "../core/types.js";
import { CLASSES, MediaItem, MusicPlaylist } from "../core/vocab.js";
import { type YTPlaylistsList, type YTVideosList, YOUTUBE_FIXTURES } from "./fixtures.js";

const ID = "youtube";
const API = "https://www.googleapis.com/youtube/v3";
const SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"] as const;

export const youtubeAdapter: IntegrationAdapter = {
  metadata: {
    id: ID,
    name: "YouTube",
    tier: "B",
    authKind: "oauth-pkce",
    scopes: SCOPES,
    categories: ["media"],
    whatYouGet: "Your liked videos and playlists, saved into Media.",
    requirements: [
      "YouTube API audit for history scopes: Google requires a compliance audit before youtube.readonly can serve real users.",
      "Create a Web OAuth client at console.cloud.google.com and add <app-origin>/oauth-callback.html as an authorised redirect URI.",
      "Google web clients are confidential, so set NEXT_PUBLIC_YOUTUBE_CLIENT_ID and deploy the token proxy at NEXT_PUBLIC_YOUTUBE_TOKEN_PROXY.",
    ],
  },
  oauth: {
    clientId: process.env.NEXT_PUBLIC_YOUTUBE_CLIENT_ID,
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    scopes: SCOPES,
    tokenExchange: "proxy",
    tokenProxyUrl: process.env.NEXT_PUBLIC_YOUTUBE_TOKEN_PROXY,
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
  fixtures: () => YOUTUBE_FIXTURES,

  async import(ctx: ImportContext): Promise<ImportOutcome> {
    ctx.progress({ label: "Fetching your liked videos…", done: 0, total: 2 });
    const liked = await getJson<YTVideosList>(
      ID,
      ctx.api,
      `${API}/videos?part=snippet,contentDetails&myRating=like&maxResults=50`,
    );

    const videosDoc = ctx.resolve("media/videos.ttl");
    const videos = new Store();
    for (const v of liked.items) {
      const item = new MediaItem(`${videosDoc}#video-${v.id}`, videos, DataFactory).mark(
        CLASSES.VideoObject,
      );
      item.name = v.snippet.title;
      item.identifier = v.id;
      item.description = v.snippet.description || undefined;
      item.sourceUrl = `https://www.youtube.com/watch?v=${v.id}`;
      item.contentUrl = v.snippet.thumbnails?.high?.url ?? v.snippet.thumbnails?.default?.url;
      item.duration = v.contentDetails.duration;
      if (v.snippet.publishedAt) item.datePublished = new Date(v.snippet.publishedAt);
    }
    await ctx.write({
      slug: "media/videos.ttl",
      category: "media",
      forClass: CLASSES.VideoObject,
      dataset: videos,
    });

    ctx.progress({ label: "Fetching your playlists…", done: 1, total: 2 });
    const lists = await getJson<YTPlaylistsList>(
      ID,
      ctx.api,
      `${API}/playlists?part=snippet,contentDetails&mine=true&maxResults=50`,
    );

    const listsDoc = ctx.resolve("media/playlists.ttl");
    const playlists = new Store();
    for (const p of lists.items) {
      const pl = new MusicPlaylist(`${listsDoc}#playlist-${p.id}`, playlists, DataFactory).mark();
      pl.name = p.snippet.title;
      pl.identifier = p.id;
      pl.description = p.snippet.description || undefined;
      pl.numTracks = p.contentDetails.itemCount;
      pl.sourceUrl = `https://www.youtube.com/playlist?list=${p.id}`;
    }
    await ctx.write({
      slug: "media/playlists.ttl",
      category: "media",
      forClass: CLASSES.MusicPlaylist,
      dataset: playlists,
    });

    ctx.progress({ label: "Done", done: 2, total: 2 });
    return {};
  },
};
