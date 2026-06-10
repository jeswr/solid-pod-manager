/**
 * Facebook → Social & interests. Your own posts (`/me/posts`) as
 * `schema:SocialMediaPosting` and the groups you belong to (`/me/groups`) as
 * `foaf:Group`.
 *
 * Tier B: Meta App Review is required for the `user_posts` and
 * `groups_access_member_info` permissions before the app may read a real
 * user's posts/groups. Facebook's OAuth uses a confidential client for
 * code→token, so live mode runs through the maintainer's token proxy.
 * Demoable now against recorded fixtures.
 */
import { DataFactory, Store } from "n3";
import { getJson } from "../core/fixture-fetch.js";
import type { ImportContext, ImportOutcome, IntegrationAdapter } from "../core/types.js";
import { CLASSES, Group, SocialMediaPosting } from "../core/vocab.js";
import { type FbGroupsAnswer, type FbPostsAnswer, FACEBOOK_FIXTURES } from "./fixtures.js";

const ID = "facebook";
const API = "https://graph.facebook.com/v20.0";
const SCOPES = ["public_profile", "user_posts", "groups_access_member_info"] as const;

export const facebookAdapter: IntegrationAdapter = {
  metadata: {
    id: ID,
    name: "Facebook",
    tier: "B",
    authKind: "oauth-pkce",
    scopes: SCOPES,
    categories: ["social"],
    whatYouGet: "Your posts and the groups you belong to, saved into Social & interests.",
    requirements: [
      "Meta App Review for user_posts + groups_access_member_info: Meta must approve the app before it can read a real user's posts or groups.",
      "Create an app at developers.facebook.com and add <app-origin>/oauth-callback.html as a valid OAuth redirect URI.",
      "Facebook uses a confidential OAuth client, so set NEXT_PUBLIC_FACEBOOK_CLIENT_ID and deploy the token proxy at NEXT_PUBLIC_FACEBOOK_TOKEN_PROXY.",
    ],
  },
  oauth: {
    clientId: process.env.NEXT_PUBLIC_FACEBOOK_CLIENT_ID,
    authorizationEndpoint: "https://www.facebook.com/v20.0/dialog/oauth",
    tokenEndpoint: "https://graph.facebook.com/v20.0/oauth/access_token",
    scopes: SCOPES,
    tokenExchange: "proxy",
    tokenProxyUrl: process.env.NEXT_PUBLIC_FACEBOOK_TOKEN_PROXY,
  },
  fixtures: () => FACEBOOK_FIXTURES,

  async import(ctx: ImportContext): Promise<ImportOutcome> {
    ctx.progress({ label: "Fetching your posts…", done: 0, total: 2 });
    const posts = await getJson<FbPostsAnswer>(
      ID,
      ctx.api,
      `${API}/me/posts?fields=id,message,story,created_time,permalink_url&limit=50`,
    );

    const postsDoc = ctx.resolve("social/posts.ttl");
    const postStore = new Store();
    for (const p of posts.data) {
      const text = p.message ?? p.story;
      const post = new SocialMediaPosting(`${postsDoc}#post-${fragment(p.id)}`, postStore, DataFactory).mark();
      post.identifier = p.id;
      post.headline = text || undefined;
      post.description = text || undefined;
      post.isPartOf = "Facebook";
      post.sourceUrl = p.permalink_url;
      post.datePublished = new Date(p.created_time);
    }
    await ctx.write({
      slug: "social/posts.ttl",
      category: "social",
      forClass: CLASSES.SocialMediaPosting,
      dataset: postStore,
    });

    ctx.progress({ label: "Fetching your groups…", done: 1, total: 2 });
    const groups = await getJson<FbGroupsAnswer>(ID, ctx.api, `${API}/me/groups?limit=100`);

    const groupsDoc = ctx.resolve("social/groups.ttl");
    const groupStore = new Store();
    for (const g of groups.data) {
      const grp = new Group(`${groupsDoc}#group-${g.id}`, groupStore, DataFactory).mark();
      grp.name = g.name;
      grp.identifier = g.id;
      grp.sourceUrl = `https://www.facebook.com/groups/${g.id}`;
    }
    await ctx.write({
      slug: "social/groups.ttl",
      category: "social",
      forClass: CLASSES.Group,
      dataset: groupStore,
    });

    ctx.progress({ label: "Done", done: 2, total: 2 });
    return {};
  },
};

/** Facebook post ids contain an underscore — keep it fragment-safe. */
function fragment(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "");
}
