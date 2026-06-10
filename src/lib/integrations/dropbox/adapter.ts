/**
 * Dropbox → Documents. File **metadata** (name, path, size, modified — never
 * the file bytes) as `schema:DigitalDocument`.
 *
 * Incremental: `list_folder` returns a cursor; the next import calls
 * `list_folder/continue` with it and merges only the changes — Dropbox's own
 * delta mechanism. Dropbox supports secretless PKCE, so live mode needs only
 * a client id.
 */
import { DataFactory } from "n3";
import { asStore } from "../core/dataset.js";
import { postJson } from "../core/fixture-fetch.js";
import type { ImportContext, ImportOutcome, IntegrationAdapter } from "../core/types.js";
import { CLASSES, DigitalDocument } from "../core/vocab.js";
import { DROPBOX_FIXTURES, type DropboxListFolderAnswer } from "./fixtures.js";

const ID = "dropbox";
const API = "https://api.dropboxapi.com/2";
const SCOPES = ["files.metadata.read", "account_info.read"] as const;

export const dropboxAdapter: IntegrationAdapter = {
  metadata: {
    id: ID,
    name: "Dropbox",
    tier: "A",
    authKind: "oauth-pkce",
    scopes: SCOPES,
    categories: ["documents"],
    whatYouGet:
      "An index of your files — names, folders, sizes and edit dates (never the file contents) — into Documents.",
    requirements: [
      "Create an app at dropbox.com/developers/apps (scoped access, files.metadata.read).",
      "Add <app-origin>/oauth-callback.html as a redirect URI.",
      "Set NEXT_PUBLIC_DROPBOX_CLIENT_ID — Dropbox supports secretless PKCE, no proxy needed.",
    ],
  },
  oauth: {
    clientId: process.env.NEXT_PUBLIC_DROPBOX_CLIENT_ID,
    authorizationEndpoint: "https://www.dropbox.com/oauth2/authorize",
    tokenEndpoint: "https://api.dropboxapi.com/oauth2/token",
    scopes: SCOPES,
    tokenExchange: "public",
    extraAuthParams: { token_access_type: "online" },
  },
  fixtures: () => DROPBOX_FIXTURES,

  async import(ctx: ImportContext): Promise<ImportOutcome> {
    ctx.progress({ label: "Listing your files…", done: 0, total: 2 });
    const first: DropboxListFolderAnswer = ctx.cursor
      ? await postJson(ID, ctx.api, `${API}/files/list_folder/continue`, { cursor: ctx.cursor })
      : await postJson(ID, ctx.api, `${API}/files/list_folder`, {
          path: "",
          recursive: true,
          limit: 500,
        });

    const doc = ctx.resolve("documents/files.ttl");
    const dataset = asStore(await ctx.read("documents/files.ttl"));

    let answer = first;
    for (;;) {
      for (const entry of answer.entries) {
        if (entry[".tag"] !== "file") continue; // folders are structure, not documents
        const file = new DigitalDocument(
          `${doc}#file-${fragmentSafe(entry.id)}`,
          dataset,
          DataFactory,
        ).mark();
        file.name = entry.name;
        file.identifier = entry.id;
        file.description = entry.path_display;
        if (entry.size !== undefined) file.contentSize = humanSize(entry.size);
        if (entry.server_modified) file.dateModified = new Date(entry.server_modified);
      }
      if (!answer.has_more) break;
      answer = await postJson(ID, ctx.api, `${API}/files/list_folder/continue`, {
        cursor: answer.cursor,
      });
    }

    ctx.progress({ label: "Saving your file index…", done: 1, total: 2 });
    await ctx.write({
      slug: "documents/files.ttl",
      category: "documents",
      forClass: CLASSES.DigitalDocument,
      dataset,
    });

    ctx.progress({ label: "Done", done: 2, total: 2 });
    return { cursor: answer.cursor };
  },
};

/** Dropbox ids look like `id:a4ayc_80_…` — strip the colon for fragment use. */
function fragmentSafe(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "");
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
