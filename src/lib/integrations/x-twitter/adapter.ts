/**
 * X (Twitter) → Social & interests. Your own posts (`/2/users/me/tweets`) as
 * `schema:SocialMediaPosting`.
 *
 * Tier B: X gates the v2 user-timeline endpoints behind a **paid API tier**
 * with elevated access — the OAuth flow itself is standard PKCE (X supports
 * secretless public clients, so `tokenExchange: "public"`), but no real user
 * can be served until the maintainer holds a paid subscription. Demoable now
 * against recorded fixtures.
 */
import { DataFactory, Store } from "n3";
import { getJson } from "../core/fixture-fetch.js";
import type { ImportContext, ImportOutcome, IntegrationAdapter } from "../core/types.js";
import { CLASSES, SocialMediaPosting } from "../core/vocab.js";
import { type XTweetsAnswer, X_TWITTER_FIXTURES } from "./fixtures.js";

const ID = "x-twitter";
const API = "https://api.twitter.com/2";
const SCOPES = ["tweet.read", "users.read", "offline.access"] as const;

export const xTwitterAdapter: IntegrationAdapter = {
  metadata: {
    id: ID,
    name: "X (Twitter)",
    tier: "B",
    authKind: "oauth-pkce",
    scopes: SCOPES,
    categories: ["social"],
    whatYouGet: "Your posts, saved into Social & interests.",
    requirements: [
      "Paid X API tier + elevated access: X's v2 timeline endpoints require a paid subscription before any real user can be served.",
      "Create an app at developer.twitter.com, enable OAuth 2.0 with PKCE, and add <app-origin>/oauth-callback.html as a callback URI.",
      "X supports secretless PKCE for public clients, so live mode needs only NEXT_PUBLIC_X_TWITTER_CLIENT_ID — no token proxy.",
    ],
  },
  oauth: {
    clientId: process.env.NEXT_PUBLIC_X_TWITTER_CLIENT_ID,
    authorizationEndpoint: "https://twitter.com/i/oauth2/authorize",
    tokenEndpoint: "https://api.twitter.com/2/oauth2/token",
    scopes: SCOPES,
    tokenExchange: "public",
  },
  fixtures: () => X_TWITTER_FIXTURES,

  async import(ctx: ImportContext): Promise<ImportOutcome> {
    ctx.progress({ label: "Fetching your posts…", done: 0, total: 1 });
    const answer = await getJson<XTweetsAnswer>(
      ID,
      ctx.api,
      `${API}/users/me/tweets?max_results=100&tweet.fields=created_at,public_metrics`,
    );

    const doc = ctx.resolve("social/posts.ttl");
    const posts = new Store();
    for (const t of answer.data) {
      const post = new SocialMediaPosting(`${doc}#post-${t.id}`, posts, DataFactory).mark();
      post.identifier = t.id;
      post.headline = t.text;
      post.description = t.text;
      post.isPartOf = "X";
      post.sourceUrl = `https://x.com/i/web/status/${t.id}`;
      post.datePublished = new Date(t.created_at);
    }
    await ctx.write({
      slug: "social/posts.ttl",
      category: "social",
      forClass: CLASSES.SocialMediaPosting,
      dataset: posts,
    });

    ctx.progress({ label: "Done", done: 1, total: 1 });
    return {};
  },
};
