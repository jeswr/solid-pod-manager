/**
 * Google Photos → Media. Library **metadata** (filename, type, dimensions,
 * capture time and the hosted asset URL — never the bytes) as
 * `schema:ImageObject` / `schema:VideoObject`.
 *
 * Tier B: the Photos Library API requires Google OAuth-app verification plus a
 * restricted-scope security assessment before the client may serve real users.
 * Google web clients are confidential, so live mode runs the code→token
 * exchange through the maintainer's token proxy. Demoable now against fixtures.
 */
import { DataFactory, Store } from "n3";
import { getJson } from "../core/fixture-fetch.js";
import type { ImportContext, ImportOutcome, IntegrationAdapter } from "../core/types.js";
import { CLASSES, MediaItem } from "../core/vocab.js";
import { type GPhotosMediaItemsList, GOOGLE_PHOTOS_FIXTURES } from "./fixtures.js";

const ID = "google-photos";
const API = "https://photoslibrary.googleapis.com/v1";
const SCOPES = ["https://www.googleapis.com/auth/photoslibrary.readonly"] as const;

export const googlePhotosAdapter: IntegrationAdapter = {
  metadata: {
    id: ID,
    name: "Google Photos",
    tier: "B",
    authKind: "oauth-pkce",
    scopes: SCOPES,
    categories: ["media"],
    whatYouGet:
      "An index of your photo library — filenames, types, dimensions and capture dates (never the photo bytes) — into Media.",
    requirements: [
      "Photos Library API approval: Google requires OAuth verification plus a restricted-scope security assessment before the app can serve real users.",
      "Create a Web OAuth client at console.cloud.google.com and add <app-origin>/oauth-callback.html as an authorised redirect URI.",
      "Google web clients are confidential, so set NEXT_PUBLIC_GOOGLE_PHOTOS_CLIENT_ID and deploy the token proxy at NEXT_PUBLIC_GOOGLE_PHOTOS_TOKEN_PROXY.",
    ],
  },
  oauth: {
    clientId: process.env.NEXT_PUBLIC_GOOGLE_PHOTOS_CLIENT_ID,
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    scopes: SCOPES,
    tokenExchange: "proxy",
    tokenProxyUrl: process.env.NEXT_PUBLIC_GOOGLE_PHOTOS_TOKEN_PROXY,
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
  fixtures: () => GOOGLE_PHOTOS_FIXTURES,

  async import(ctx: ImportContext): Promise<ImportOutcome> {
    ctx.progress({ label: "Indexing your photo library…", done: 0, total: 1 });
    const list = await getJson<GPhotosMediaItemsList>(ID, ctx.api, `${API}/mediaItems?pageSize=100`);

    const doc = ctx.resolve("media/photos.ttl");
    const items = new Store();
    for (const m of list.mediaItems ?? []) {
      const isVideo = m.mimeType.startsWith("video/");
      const item = new MediaItem(`${doc}#media-${m.id}`, items, DataFactory).mark(
        isVideo ? CLASSES.VideoObject : CLASSES.ImageObject,
      );
      item.name = m.filename;
      item.identifier = m.id;
      item.description = m.description || undefined;
      item.sourceUrl = m.productUrl;
      item.contentUrl = m.baseUrl;
      item.encodingFormat = m.mimeType;
      const w = Number.parseInt(m.mediaMetadata.width, 10);
      const h = Number.parseInt(m.mediaMetadata.height, 10);
      if (Number.isFinite(w)) item.width = w;
      if (Number.isFinite(h)) item.height = h;
      if (m.mediaMetadata.creationTime) item.dateCreated = new Date(m.mediaMetadata.creationTime);
    }
    await ctx.write({
      slug: "media/photos.ttl",
      category: "media",
      // Register the dominant class; a mixed photo+video container still surfaces in Media.
      forClass: CLASSES.ImageObject,
      dataset: items,
    });

    ctx.progress({ label: "Done", done: 1, total: 1 });
    return {};
  },
};
