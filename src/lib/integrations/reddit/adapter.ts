/**
 * Reddit → Social & interests. Saved posts (`/user/{name}/saved`) as
 * `schema:SocialMediaPosting` and subscribed subreddits
 * (`/subreddits/mine/subscriber`) as `foaf:Group`.
 *
 * Incremental: the saved listing supports `before=<fullname>` — the cursor is
 * the newest saved post's fullname; newer saves are merged in. Subreddits are
 * snapshot. Live mode works secretless via Reddit's installed-app convention
 * (Basic auth with an empty secret on the token exchange).
 */
import { DataFactory, Store } from "n3";
import { asStore } from "../core/dataset.js";
import { getJson } from "../core/fixture-fetch.js";
import type { ImportContext, ImportOutcome, IntegrationAdapter } from "../core/types.js";
import { CLASSES, Group, SocialMediaPosting } from "../core/vocab.js";
import {
  type RedditListing,
  type RedditMe,
  type RedditSavedPost,
  type RedditSubreddit,
  REDDIT_FIXTURES,
} from "./fixtures.js";

const ID = "reddit";
const API = "https://oauth.reddit.com";
const SCOPES = ["identity", "history", "mysubreddits"] as const;

export const redditAdapter: IntegrationAdapter = {
  metadata: {
    id: ID,
    name: "Reddit",
    tier: "A",
    authKind: "oauth-pkce",
    scopes: SCOPES,
    categories: ["social"],
    whatYouGet: "Your saved posts and the communities you're part of, in Social & interests.",
    requirements: [
      'Create an "installed app" at reddit.com/prefs/apps.',
      "Set <app-origin>/oauth-callback.html as the redirect uri.",
      "Set NEXT_PUBLIC_REDDIT_CLIENT_ID — installed apps exchange the code with an empty secret, no proxy needed.",
    ],
  },
  oauth: {
    clientId: process.env.NEXT_PUBLIC_REDDIT_CLIENT_ID,
    authorizationEndpoint: "https://www.reddit.com/api/v1/authorize",
    tokenEndpoint: "https://www.reddit.com/api/v1/access_token",
    scopes: SCOPES,
    tokenExchange: "public",
    basicAuthForToken: true,
    extraAuthParams: { duration: "permanent" },
  },
  fixtures: () => REDDIT_FIXTURES,

  async import(ctx: ImportContext): Promise<ImportOutcome> {
    ctx.progress({ label: "Checking who you are on Reddit…", done: 0, total: 3 });
    const me = await getJson<RedditMe>(ID, ctx.api, `${API}/api/v1/me`);

    ctx.progress({ label: "Fetching your saved posts…", done: 1, total: 3 });
    const before = ctx.cursor ? `&before=${encodeURIComponent(ctx.cursor)}` : "";
    const saved = await getJson<RedditListing<RedditSavedPost>>(
      ID,
      ctx.api,
      `${API}/user/${me.name}/saved?limit=100&raw_json=1${before}`,
    );

    const savedDoc = ctx.resolve("social/saved-posts.ttl");
    const posts = asStore(await ctx.read("social/saved-posts.ttl"));
    for (const child of saved.data.children) {
      const p = child.data;
      const post = new SocialMediaPosting(`${savedDoc}#post-${p.id}`, posts, DataFactory).mark();
      post.headline = p.title;
      post.identifier = p.name;
      post.isPartOf = `r/${p.subreddit}`;
      post.sourceUrl = `https://www.reddit.com${p.permalink}`;
      post.datePublished = new Date(p.created_utc * 1000);
    }
    await ctx.write({
      slug: "social/saved-posts.ttl",
      category: "social",
      forClass: CLASSES.SocialMediaPosting,
      dataset: posts,
    });

    ctx.progress({ label: "Fetching your communities…", done: 2, total: 3 });
    const subs = await getJson<RedditListing<RedditSubreddit>>(
      ID,
      ctx.api,
      `${API}/subreddits/mine/subscriber?limit=100`,
    );

    const subsDoc = ctx.resolve("social/communities.ttl");
    const groups = new Store();
    for (const child of subs.data.children) {
      const s = child.data;
      const group = new Group(`${subsDoc}#sub-${s.display_name}`, groups, DataFactory).mark();
      group.name = s.title || s.display_name;
      group.identifier = s.display_name;
      group.description = s.public_description || undefined;
      group.sourceUrl = `https://www.reddit.com${s.url}`;
    }
    await ctx.write({
      slug: "social/communities.ttl",
      category: "social",
      forClass: CLASSES.Group,
      dataset: groups,
    });

    ctx.progress({ label: "Done", done: 3, total: 3 });
    const newest = saved.data.children[0]?.data.name;
    return { cursor: newest ?? ctx.cursor };
  },
};

