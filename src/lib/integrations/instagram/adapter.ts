/**
 * Instagram → Media + Social. Your own posts (`/me/media`) saved two ways:
 * the visual asset as `schema:ImageObject` / `schema:VideoObject` (Media), and
 * the post itself as `schema:SocialMediaPosting` (Social & interests).
 *
 * Tier B: Meta App Review is required for the `instagram_graph_user_media`
 * permission before the app may read a real user's media. Instagram's OAuth
 * uses a confidential client for code→token, so live mode runs through the
 * maintainer's token proxy. Demoable now against recorded fixtures.
 */
import { DataFactory, Store } from "n3";
import { getJson } from "../core/fixture-fetch.js";
import type { ImportContext, ImportOutcome, IntegrationAdapter } from "../core/types.js";
import { CLASSES, MediaItem, SocialMediaPosting } from "../core/vocab.js";
import { type IgMediaAnswer, INSTAGRAM_FIXTURES } from "./fixtures.js";

const ID = "instagram";
const API = "https://graph.instagram.com";
const SCOPES = ["instagram_graph_user_profile", "instagram_graph_user_media"] as const;

export const instagramAdapter: IntegrationAdapter = {
  metadata: {
    id: ID,
    name: "Instagram",
    tier: "B",
    authKind: "oauth-pkce",
    scopes: SCOPES,
    categories: ["media", "social"],
    whatYouGet: "Your posts — the photos and videos into Media, the posts into Social & interests.",
    requirements: [
      "Meta App Review for instagram_graph_user_media: Meta must approve the app before it can read a real user's media.",
      "Create an app at developers.facebook.com and add <app-origin>/oauth-callback.html as a valid OAuth redirect URI.",
      "Instagram uses a confidential OAuth client, so set NEXT_PUBLIC_INSTAGRAM_CLIENT_ID and deploy the token proxy at NEXT_PUBLIC_INSTAGRAM_TOKEN_PROXY.",
    ],
  },
  oauth: {
    clientId: process.env.NEXT_PUBLIC_INSTAGRAM_CLIENT_ID,
    authorizationEndpoint: "https://api.instagram.com/oauth/authorize",
    tokenEndpoint: "https://api.instagram.com/oauth/access_token",
    scopes: SCOPES,
    tokenExchange: "proxy",
    tokenProxyUrl: process.env.NEXT_PUBLIC_INSTAGRAM_TOKEN_PROXY,
  },
  fixtures: () => INSTAGRAM_FIXTURES,

  async import(ctx: ImportContext): Promise<ImportOutcome> {
    ctx.progress({ label: "Fetching your posts…", done: 0, total: 2 });
    const answer = await getJson<IgMediaAnswer>(
      ID,
      ctx.api,
      `${API}/me/media?fields=id,media_type,media_url,permalink,caption,timestamp&limit=50`,
    );

    const mediaDoc = ctx.resolve("media/posts.ttl");
    const socialDoc = ctx.resolve("social/posts.ttl");
    const media = new Store();
    const social = new Store();

    for (const m of answer.data) {
      const when = new Date(m.timestamp);
      const isVideo = m.media_type === "VIDEO";
      const asset = new MediaItem(`${mediaDoc}#media-${m.id}`, media, DataFactory).mark(
        isVideo ? CLASSES.VideoObject : CLASSES.ImageObject,
      );
      asset.name = m.caption || `Instagram ${m.media_type.toLowerCase()}`;
      asset.identifier = m.id;
      asset.contentUrl = m.media_url;
      asset.sourceUrl = m.permalink;
      asset.encodingFormat = isVideo ? "video/mp4" : "image/jpeg";
      asset.datePublished = when;

      const post = new SocialMediaPosting(`${socialDoc}#post-${m.id}`, social, DataFactory).mark();
      post.identifier = m.id;
      post.headline = m.caption || undefined;
      post.description = m.caption || undefined;
      post.isPartOf = "Instagram";
      post.sourceUrl = m.permalink;
      post.datePublished = when;
    }

    await ctx.write({
      slug: "media/posts.ttl",
      category: "media",
      forClass: CLASSES.ImageObject,
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
