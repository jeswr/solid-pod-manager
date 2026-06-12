/**
 * ChatGPT → Documents (Tier-C file import).
 *
 * ChatGPT's "Export data" email contains `conversations.json`: an array of
 * conversation objects `{ title, create_time, mapping }`, where `mapping` is a
 * map of node-id → `{ message: { author: { role }, content: { parts },
 * create_time } }` forming the message tree. We flatten each conversation to a
 * readable transcript and write it as one `schema:TextDigitalDocument` in
 * Documents (the same class Notion's live adapter uses for pages).
 *
 * Parsed with `JSON.parse` (no dependency). The JSON is fully untrusted: we
 * only ever read strings out of it and coerce them to RDF literals — never
 * `eval`, never build a URL to fetch.
 */
import { DataFactory, Store } from "n3";
import type { FileImportAdapter, FileImportContext, ImportFile } from "../core/file-import.js";
import { recordFragment } from "../core/slug.js";
import type { IntegrationMetadata } from "../core/types.js";
import { CLASSES, TextDocument } from "../core/vocab.js";

const ID = "chatgpt";

const metadata: IntegrationMetadata = {
  id: ID,
  name: "ChatGPT",
  tier: "C",
  authKind: "export-file",
  scopes: [],
  categories: ["documents"],
  whatYouGet: "Your conversations, saved as text documents in Documents.",
  requirements: [],
};

/** A single conversation flattened to a title + transcript. */
export interface FlatConversation {
  readonly title: string;
  readonly created?: Date;
  readonly transcript: string;
  readonly key: string;
}

export const chatgptFileAdapter: FileImportAdapter = {
  metadata,
  accept: ".json,application/json",
  fileHint:
    "ChatGPT → Settings → Data controls → Export data. Unzip the emailed archive and select conversations.json.",
  exportUrl: "https://chatgpt.com",

  async importFile(file: ImportFile, ctx: FileImportContext): Promise<void> {
    ctx.progress({ label: "Reading your conversations…", done: 0, total: 1 });
    const conversations = parseChatgptExport(await file.text(), ctx.maxRows);

    const doc = ctx.resolve("documents/chatgpt-conversations.ttl");
    const store = new Store();
    for (const conv of conversations) {
      const frag = recordFragment(conv.title, conv.key);
      const td = new TextDocument(`${doc}#chat-${frag}`, store, DataFactory).mark();
      td.name = conv.title;
      td.text = conv.transcript;
      if (conv.created) td.dateCreated = conv.created;
    }

    ctx.progress({ label: "Saving to your pod…", done: 1, total: 1 });
    await ctx.write({
      slug: "documents/chatgpt-conversations.ttl",
      category: "documents",
      forClass: CLASSES.TextDigitalDocument,
      dataset: store,
    });
  },
};

// `unknown`-narrowing helpers keep the untrusted JSON fully typed-safe.
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Parse `conversations.json` into flattened conversations (bounded by `limit`). */
export function parseChatgptExport(text: string, limit = Number.POSITIVE_INFINITY): FlatConversation[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  // The export is an array; some variants wrap it as { conversations: [...] }.
  const list = Array.isArray(data)
    ? data
    : isObject(data) && Array.isArray(data.conversations)
      ? data.conversations
      : [];

  const out: FlatConversation[] = [];
  let idx = 0;
  for (const raw of list) {
    if (out.length >= limit) break;
    if (!isObject(raw)) continue;
    const title = asString(raw.title)?.trim() || "Untitled conversation";
    const created = numberToDate(raw.create_time);
    const transcript = flattenMapping(raw.mapping);
    out.push({
      title,
      created,
      transcript,
      key: asString(raw.id) ?? asString(raw.conversation_id) ?? `${title}|${idx}`,
    });
    idx++;
  }
  return out;
}

/** Walk the node map and join messages in create_time order as `Role: text`. */
function flattenMapping(mapping: unknown): string {
  if (!isObject(mapping)) return "";
  const lines: { t: number; line: string }[] = [];
  for (const node of Object.values(mapping)) {
    if (!isObject(node)) continue;
    const message = node.message;
    if (!isObject(message)) continue;
    const role = isObject(message.author) ? asString(message.author.role) : undefined;
    if (role === "system" || role === "tool") continue;
    const text = extractParts(message.content);
    if (!text) continue;
    const t = typeof message.create_time === "number" ? message.create_time : 0;
    lines.push({ t, line: `${role === "assistant" ? "ChatGPT" : "You"}: ${text}` });
  }
  lines.sort((a, b) => a.t - b.t);
  return lines.map((l) => l.line).join("\n\n");
}

/** Pull the textual parts out of a message `content` object. */
function extractParts(content: unknown): string {
  if (!isObject(content)) return "";
  const parts = content.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => (typeof p === "string" ? p : isObject(p) && asString(p.text) ? asString(p.text) : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function numberToDate(v: unknown): Date | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  // ChatGPT create_time is Unix seconds (float).
  const d = new Date(v * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
