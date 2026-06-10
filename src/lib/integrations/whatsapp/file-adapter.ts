/**
 * WhatsApp → Social & interests (Tier-C file import).
 *
 * WhatsApp's "Export chat (without media)" produces a `.txt` transcript, one
 * message per line in one of two locale shapes:
 *
 *   `[14/02/2023, 09:30:15] Alice: Hello there`        (iOS, bracketed)
 *   `2/14/23, 9:30 AM - Alice: Hello there`            (Android, dash)
 *
 * Continuation lines (a multi-line message) belong to the previous message. We
 * parse natively and write each message as a `schema:Message` in Social, with
 * the sender name as a literal (never an invented IRI) and the timestamp as
 * `dateCreated`. System lines without a `Sender:` (e.g. "Messages and calls are
 * end-to-end encrypted") are skipped.
 */
import { DataFactory, Store } from "n3";
import type { FileImportAdapter, FileImportContext, ImportFile } from "../core/file-import.js";
import { recordFragment } from "../core/slug.js";
import type { IntegrationMetadata } from "../core/types.js";
import { CLASSES, Message } from "../core/vocab.js";

const ID = "whatsapp";

const metadata: IntegrationMetadata = {
  id: ID,
  name: "WhatsApp",
  tier: "C",
  authKind: "export-file",
  scopes: [],
  categories: ["social"],
  whatYouGet: "Your exported chat history, saved as messages in Social & interests.",
  requirements: [],
};

export interface ChatMessage {
  readonly when?: Date;
  readonly sender: string;
  readonly text: string;
}

export const whatsappFileAdapter: FileImportAdapter = {
  metadata,
  accept: ".txt,text/plain",
  fileHint:
    "In WhatsApp, open a chat → ⋯ → More → Export chat → Without media. Select the resulting _chat.txt.",

  async importFile(file: ImportFile, ctx: FileImportContext): Promise<void> {
    ctx.progress({ label: "Reading your chat…", done: 0, total: 1 });
    const messages = parseWhatsappChat(await file.text(), ctx.maxRows);

    const doc = ctx.resolve("social/whatsapp-chat.ttl");
    const store = new Store();
    let i = 0;
    for (const msg of messages) {
      const key = `${i}|${msg.sender}|${msg.when?.toISOString() ?? ""}`;
      const frag = recordFragment(msg.sender, key);
      const m = new Message(`${doc}#msg-${frag}`, store, DataFactory).mark();
      m.sender = msg.sender;
      m.text = msg.text;
      if (msg.when) m.dateCreated = msg.when;
      i++;
    }

    ctx.progress({ label: "Saving to your pod…", done: 1, total: 1 });
    if (store.size === 0) return;
    await ctx.write({
      slug: "social/whatsapp-chat.ttl",
      category: "social",
      forClass: CLASSES.Message,
      dataset: store,
    });
  },
};

// `[14/02/2023, 09:30:15] Alice: Hi`  — iOS bracketed form.
const IOS = /^\[(\d{1,2})[/.](\d{1,2})[/.](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp][Mm]))?\]\s*([^:]+):\s?([\s\S]*)$/;
// `2/14/23, 9:30 AM - Alice: Hi`  — Android dash form.
const ANDROID = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp][Mm]))?\s+-\s+([^:]+):\s?([\s\S]*)$/;

/** Parse a WhatsApp transcript into messages, joining continuation lines. */
export function parseWhatsappChat(text: string, limit = Number.POSITIVE_INFINITY): ChatMessage[] {
  const lines = text.split(/\r\n|\r|\n/);
  const out: ChatMessage[] = [];
  let current: { when?: Date; sender: string; parts: string[] } | undefined;

  const flush = () => {
    if (current && out.length < limit) {
      out.push({ when: current.when, sender: current.sender, text: current.parts.join("\n") });
    }
    current = undefined;
  };

  for (const line of lines) {
    // Strip the LRM/bidi marks WhatsApp sometimes prepends.
    const clean = line.replace(/^[‎‏‪-‮]+/, "");
    const m = clean.match(IOS) ?? clean.match(ANDROID);
    if (m) {
      flush();
      if (out.length >= limit) break;
      const [, a, b, y, h, mi, s, ampm, sender, body] = m;
      current = { when: buildDate(a, b, y, h, mi, s, ampm), sender: sender.trim(), parts: [body] };
    } else if (current) {
      current.parts.push(clean);
    }
    // else: a leading system line before any message — ignore.
  }
  flush();
  return out;
}

function buildDate(
  a: string,
  b: string,
  y: string,
  h: string,
  mi: string,
  s: string | undefined,
  ampm: string | undefined,
): Date | undefined {
  let year = Number(y);
  if (year < 100) year += 2000;
  // Day-first vs month-first is locale-dependent; prefer D/M when the first
  // part can't be a month, else assume the bracketed iOS D/M default.
  let day = Number(a);
  let month = Number(b);
  if (month > 12 && day <= 12) [day, month] = [month, day];
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  let hour = Number(h);
  if (ampm) {
    const pm = /p/i.test(ampm);
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }
  const d = new Date(Date.UTC(year, month - 1, day, hour, Number(mi), s ? Number(s) : 0));
  return Number.isNaN(d.getTime()) ? undefined : d;
}
