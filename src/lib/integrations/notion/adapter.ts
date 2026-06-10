/**
 * Notion → Documents. `POST /v1/search` lists everything the integration can
 * see: pages become `schema:TextDigitalDocument`, databases become
 * `schema:Dataset`. Every call needs the `Notion-Version` header.
 *
 * Live-mode honesty: Notion's token endpoint requires HTTP Basic auth with
 * the client secret (no public PKCE) — live mode needs the maintainer's
 * token proxy. Snapshot semantics (search has page cursors, not change
 * cursors).
 */
import { DataFactory, Store } from "n3";
import { postJson } from "../core/fixture-fetch.js";
import type { ImportContext, ImportOutcome, IntegrationAdapter } from "../core/types.js";
import { CLASSES, DataCollection, DigitalDocument } from "../core/vocab.js";
import { type NotionPage, type NotionSearchAnswer, NOTION_FIXTURES } from "./fixtures.js";

const ID = "notion";
const API = "https://api.notion.com/v1";

export const notionAdapter: IntegrationAdapter = {
  metadata: {
    id: ID,
    name: "Notion",
    tier: "A",
    authKind: "oauth-pkce",
    scopes: [], // Notion grants are per-workspace page selection, not scopes.
    categories: ["documents"],
    whatYouGet: "Your pages and databases (titles, links, edit dates) into Documents.",
    requirements: [
      "Create a public integration at notion.so/my-integrations.",
      "Add <app-origin>/oauth-callback.html as a redirect URI.",
      "Set NEXT_PUBLIC_NOTION_CLIENT_ID.",
      "Notion's token endpoint requires Basic auth with the client secret: deploy the token-exchange proxy and set NEXT_PUBLIC_NOTION_TOKEN_PROXY.",
    ],
  },
  oauth: {
    clientId: process.env.NEXT_PUBLIC_NOTION_CLIENT_ID,
    authorizationEndpoint: "https://api.notion.com/v1/oauth/authorize",
    tokenEndpoint: "https://api.notion.com/v1/oauth/token",
    scopes: [],
    tokenExchange: "proxy",
    tokenProxyUrl: process.env.NEXT_PUBLIC_NOTION_TOKEN_PROXY,
    extraAuthParams: { owner: "user" },
  },
  apiHeaders: { "notion-version": "2022-06-28" },
  fixtures: () => NOTION_FIXTURES,

  async import(ctx: ImportContext): Promise<ImportOutcome> {
    ctx.progress({ label: "Searching your Notion workspace…", done: 0, total: 2 });
    const search = await postJson<NotionSearchAnswer>(ID, ctx.api, `${API}/search`, {
      page_size: 100,
    });

    const pagesDoc = ctx.resolve("documents/pages.ttl");
    const dbDoc = ctx.resolve("documents/databases.ttl");
    const pages = new Store();
    const databases = new Store();

    for (const result of search.results) {
      if (result.object === "page") {
        const page = new DigitalDocument(`${pagesDoc}#page-${result.id}`, pages, DataFactory).mark(
          CLASSES.TextDigitalDocument,
        );
        page.name = pageTitle(result);
        page.identifier = result.id;
        page.sourceUrl = result.url;
        page.dateCreated = new Date(result.created_time);
        page.dateModified = new Date(result.last_edited_time);
      } else {
        const db = new DataCollection(`${dbDoc}#db-${result.id}`, databases, DataFactory).mark();
        db.name = plain(result.title) ?? "Untitled database";
        db.identifier = result.id;
        db.description = plain(result.description);
        db.sourceUrl = result.url;
        db.dateCreated = new Date(result.created_time);
        db.dateModified = new Date(result.last_edited_time);
      }
    }

    ctx.progress({ label: "Saving pages and databases…", done: 1, total: 2 });
    await ctx.write({
      slug: "documents/pages.ttl",
      category: "documents",
      forClass: CLASSES.TextDigitalDocument,
      dataset: pages,
    });
    await ctx.write({
      slug: "documents/databases.ttl",
      category: "documents",
      forClass: CLASSES.Dataset,
      dataset: databases,
    });

    ctx.progress({ label: "Done", done: 2, total: 2 });
    return {};
  },
};

/** A page's title property is whichever property has `type: "title"`. */
function pageTitle(page: NotionPage): string {
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title" && prop.title) {
      const text = plain(prop.title);
      if (text) return text;
    }
  }
  return "Untitled";
}

function plain(rich: { plain_text: string }[] | undefined): string | undefined {
  const joined = (rich ?? []).map((r) => r.plain_text).join("");
  return joined.length > 0 ? joined : undefined;
}
