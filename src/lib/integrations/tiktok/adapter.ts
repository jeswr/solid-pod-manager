/**
 * TikTok → Media + Social. Your own videos (`POST /v2/video/list/`) saved two
 * ways: the clip as `schema:VideoObject` (Media), and the post itself as
 * `schema:SocialMediaPosting` (Social & interests).
 *
 * Tier B: TikTok requires a developer audit of the app before the
 * `video.list` scope can read a real user's videos. TikTok's OAuth uses a
 * confidential client for code→token, so live mode runs through the
 * maintainer's token proxy. Demoable now against recorded fixtures.
 */
import { DataFactory, Store } from "n3";
import { postJson } from "../core/fixture-fetch.js";
import type { ImportContext, ImportOutcome, IntegrationAdapter } from "../core/types.js";
import { CLASSES, MediaItem, SocialMediaPosting } from "../core/vocab.js";
import { type TikTokVideoListAnswer, TIKTOK_FIXTURES } from "./fixtures.js";

const ID = "tiktok";
const API = "https://open.tiktokapis.com/v2";
const SCOPES = ["user.info.basic", "video.list"] as const;
const VIDEO_FIELDS = "id,title,video_description,share_url,cover_image_url,duration,create_time,view_count";

export const tiktokAdapter: IntegrationAdapter = {
  metadata: {
    id: ID,
    name: "TikTok",
    tier: "B",
    authKind: "oauth-pkce",
    scopes: SCOPES,
    categories: ["media", "social"],
    whatYouGet: "Your videos — the clips into Media, the posts into Social & interests.",
    requirements: [
      "TikTok developer audit: TikTok must audit and approve the app before the video.list scope can read a real user's videos.",
      "Create an app at developers.tiktok.com and add <app-origin>/oauth-callback.html as a redirect URI.",
      "TikTok uses a confidential OAuth client, so set NEXT_PUBLIC_TIKTOK_CLIENT_ID and deploy the token proxy at NEXT_PUBLIC_TIKTOK_TOKEN_PROXY.",
    ],
  },
  oauth: {
    clientId: process.env.NEXT_PUBLIC_TIKTOK_CLIENT_ID,
    authorizationEndpoint: "https://www.tiktok.com/v2/auth/authorize/",
    tokenEndpoint: "https://open.tiktokapis.com/v2/oauth/token/",
    scopes: SCOPES,
    tokenExchange: "proxy",
    tokenProxyUrl: process.env.NEXT_PUBLIC_TIKTOK_TOKEN_PROXY,
  },
  fixtures: () => TIKTOK_FIXTURES,

  async import(ctx: ImportContext): Promise<ImportOutcome> {
    ctx.progress({ label: "Fetching your videos…", done: 0, total: 2 });
    const answer = await postJson<TikTokVideoListAnswer>(
      ID,
      ctx.api,
      `${API}/video/list/?fields=${VIDEO_FIELDS}`,
      { max_count: 20 },
    );

    const mediaDoc = ctx.resolve("media/videos.ttl");
    const socialDoc = ctx.resolve("social/posts.ttl");
    const media = new Store();
    const social = new Store();

    for (const v of answer.data.videos) {
      const when = new Date(v.create_time * 1000);
      const clip = new MediaItem(`${mediaDoc}#video-${v.id}`, media, DataFactory).mark(
        CLASSES.VideoObject,
      );
      clip.name = v.title || v.video_description || "TikTok video";
      clip.identifier = v.id;
      clip.description = v.video_description || undefined;
      clip.contentUrl = v.cover_image_url;
      clip.sourceUrl = v.share_url;
      clip.encodingFormat = "video/mp4";
      clip.duration = `PT${v.duration}S`;
      clip.datePublished = when;

      const post = new SocialMediaPosting(`${socialDoc}#post-${v.id}`, social, DataFactory).mark();
      post.identifier = v.id;
      post.headline = v.title || undefined;
      post.description = v.video_description || undefined;
      post.isPartOf = "TikTok";
      post.sourceUrl = v.share_url;
      post.datePublished = when;
    }

    await ctx.write({
      slug: "media/videos.ttl",
      category: "media",
      forClass: CLASSES.VideoObject,
      dataset: media,
    });
    ctx.progress({ label: "Saving your posts…", done: 1, total: 2 });
    await ctx.write({
      slug: "social/posts.ttl",
      category: "social",
      forClass: CLASSES.SocialMediaPosting,
      dataset: social,
    });

    ctx.progress({ label: "Done", done: 2, total: 2 });
    return {};
  },
};
