/**
 * Pinterest → Media + Social. Your boards (`/v5/boards`) name the collections;
 * your pins (`/v5/pins`) are saved two ways — the pinned image as
 * `schema:ImageObject` (Media), and the pin as `schema:SocialMediaPosting`
 * (Social & interests), tagged with the board it lives on.
 *
 * Tier B: Pinterest requires a trial-access review (and then standard-access
 * approval) before the app may read a real user's pins/boards. Pinterest uses
 * a confidential OAuth client for code→token, so live mode runs through the
 * maintainer's token proxy. Demoable now against recorded fixtures.
 */
import { DataFactory, Store } from "n3";
import { getJson } from "../core/fixture-fetch.js";
import type { ImportContext, ImportOutcome, IntegrationAdapter } from "../core/types.js";
import { CLASSES, MediaItem, SocialMediaPosting } from "../core/vocab.js";
import { type BoardsAnswer, PINTEREST_FIXTURES, type PinsAnswer } from "./fixtures.js";

const ID = "pinterest";
const API = "https://api.pinterest.com/v5";
const SCOPES = ["boards:read", "pins:read"] as const;

export const pinterestAdapter: IntegrationAdapter = {
  metadata: {
    id: ID,
    name: "Pinterest",
    tier: "B",
    authKind: "oauth-pkce",
    scopes: SCOPES,
    categories: ["media", "social"],
    whatYouGet: "Your pins — the images into Media, the saves (by board) into Social & interests.",
    requirements: [
      "Pinterest trial-access review: Pinterest must approve the app for trial then standard access before it can read a real user's pins and boards.",
      "Create an app at developers.pinterest.com and add <app-origin>/oauth-callback.html as a redirect URI.",
      "Pinterest uses a confidential OAuth client, so set NEXT_PUBLIC_PINTEREST_CLIENT_ID and deploy the token proxy at NEXT_PUBLIC_PINTEREST_TOKEN_PROXY.",
    ],
  },
  oauth: {
    clientId: process.env.NEXT_PUBLIC_PINTEREST_CLIENT_ID,
    authorizationEndpoint: "https://www.pinterest.com/oauth/",
    tokenEndpoint: "https://api.pinterest.com/v5/oauth/token",
    scopes: SCOPES,
    tokenExchange: "proxy",
    tokenProxyUrl: process.env.NEXT_PUBLIC_PINTEREST_TOKEN_PROXY,
  },
  fixtures: () => PINTEREST_FIXTURES,

  async import(ctx: ImportContext): Promise<ImportOutcome> {
    ctx.progress({ label: "Fetching your boards…", done: 0, total: 3 });
    const boards = await getJson<BoardsAnswer>(ID, ctx.api, `${API}/boards?page_size=100`);
    const boardName = new Map(boards.items.map((b) => [b.id, b.name]));

    ctx.progress({ label: "Fetching your pins…", done: 1, total: 3 });
    const pins = await getJson<PinsAnswer>(ID, ctx.api, `${API}/pins?page_size=100`);

    const mediaDoc = ctx.resolve("media/pins.ttl");
    const socialDoc = ctx.resolve("social/pins.ttl");
    const media = new Store();
    const social = new Store();

    for (const p of pins.items) {
      const when = new Date(p.created_at);
      const board = boardName.get(p.board_id);
      const variant = p.media?.images ? Object.values(p.media.images)[0] : undefined;

      const image = new MediaItem(`${mediaDoc}#pin-${p.id}`, media, DataFactory).mark(
        CLASSES.ImageObject,
      );
      image.name = p.title || "Pin";
      image.identifier = p.id;
      image.description = p.description || undefined;
      image.contentUrl = variant?.url;
      image.sourceUrl = p.link ?? `https://www.pinterest.com/pin/${p.id}/`;
      image.encodingFormat = "image/jpeg";
      if (variant) {
        image.width = variant.width;
        image.height = variant.height;
      }
      image.datePublished = when;

      const post = new SocialMediaPosting(`${socialDoc}#pin-${p.id}`, social, DataFactory).mark();
      post.identifier = p.id;
      post.headline = p.title || undefined;
      post.description = p.description || undefined;
      post.isPartOf = board ? `Pinterest · ${board}` : "Pinterest";
      post.sourceUrl = p.link ?? `https://www.pinterest.com/pin/${p.id}/`;
      post.datePublished = when;
    }

    ctx.progress({ label: "Saving your pins…", done: 2, total: 3 });
    await ctx.write({
      slug: "media/pins.ttl",
      category: "media",
      forClass: CLASSES.ImageObject,
      dataset: media,
    });
    await ctx.write({
      slug: "social/pins.ttl",
      category: "social",
      forClass: CLASSES.SocialMediaPosting,
      dataset: social,
    });

    ctx.progress({ label: "Done", done: 3, total: 3 });
    return {};
  },
};
