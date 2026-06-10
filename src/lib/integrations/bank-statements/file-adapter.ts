/**
 * Bank statements → Finance (Tier-C file import).
 *
 * Banks have no common schema, so we support the two near-universal export
 * formats with native parsers (no dependency):
 *
 *   - **CSV** — we detect the date / description / amount columns from a broad
 *     list of header aliases (and a single signed `Amount` column, or separate
 *     `Debit`/`Credit` columns).
 *   - **OFX / QFX** — the SGML-ish `<STMTTRN>…<TRNAMT>…<NAME>…</STMTTRN>` blocks
 *     that Quicken/Money exports use; parsed with a tiny tag reader.
 *
 * Each transaction becomes a `schema:Invoice` in Finance: description as name,
 * signed amount text on `totalPaymentDue` (negative = money out), posting date
 * on `dateCreated`. The file is untrusted — values become inert RDF literals.
 */
import { DataFactory, Store } from "n3";
import { parseCsv } from "../core/csv.js";
import type { FileImportAdapter, FileImportContext, ImportFile } from "../core/file-import.js";
import { recordFragment } from "../core/slug.js";
import type { IntegrationMetadata } from "../core/types.js";
import { CLASSES, Invoice } from "../core/vocab.js";

const ID = "bank-statements";

const metadata: IntegrationMetadata = {
  id: ID,
  name: "Bank statements",
  tier: "C",
  authKind: "export-file",
  scopes: [],
  categories: ["finance"],
  whatYouGet: "Your transactions, saved as records in Finance.",
  requirements: [],
};

export interface Transaction {
  readonly date?: Date;
  readonly description: string;
  /** Signed amount text ("-12.50" for money out), as it should appear. */
  readonly amount: string;
  readonly currency?: string;
}

export const bankStatementsFileAdapter: FileImportAdapter = {
  metadata,
  accept: ".csv,.ofx,.qfx,text/csv,application/x-ofx",
  fileHint:
    "Download a statement from your bank as CSV or OFX/QFX (most banks offer 'Export transactions'). Select that file.",

  async importFile(file: ImportFile, ctx: FileImportContext): Promise<void> {
    ctx.progress({ label: "Reading your statement…", done: 0, total: 1 });
    const text = await file.text();
    const isOfx = /\.(ofx|qfx)$/i.test(file.name) || /<STMTTRN>/i.test(text);
    const txns = isOfx ? parseOfx(text, ctx.maxRows) : parseBankCsv(text, ctx.maxRows);

    const doc = ctx.resolve("finance/bank-transactions.ttl");
    const store = new Store();
    let i = 0;
    for (const txn of txns) {
      const key = `${i}|${txn.date?.toISOString() ?? ""}|${txn.amount}|${txn.description}`;
      const frag = recordFragment(txn.description || "transaction", key);
      const inv = new Invoice(`${doc}#txn-${frag}`, store, DataFactory).mark();
      inv.name = txn.description || "Transaction";
      inv.totalPaymentDue = txn.amount;
      if (txn.currency) inv.priceCurrency = txn.currency;
      if (txn.date) inv.dateCreated = txn.date;
      i++;
    }

    ctx.progress({ label: "Saving to your pod…", done: 1, total: 1 });
    await ctx.write({
      slug: "finance/bank-transactions.ttl",
      category: "finance",
      forClass: CLASSES.Invoice,
      dataset: store,
    });
  },
};

const DATE_HEADERS = ["date", "transaction date", "posting date", "posted date", "value date"];
const DESC_HEADERS = ["description", "name", "payee", "memo", "details", "narrative", "transaction"];
const AMOUNT_HEADERS = ["amount", "value"];
const DEBIT_HEADERS = ["debit", "withdrawal", "paid out", "money out"];
const CREDIT_HEADERS = ["credit", "deposit", "paid in", "money in"];

/** Parse a generic bank CSV, detecting the relevant columns by header. */
export function parseBankCsv(text: string, limit = Number.POSITIVE_INFINITY): Transaction[] {
  const { headers, rows } = parseCsv(text);
  const lower = headers.map((h) => h.toLowerCase());
  const find = (cands: string[]) => {
    const i = lower.findIndex((h) => cands.includes(h));
    return i === -1 ? undefined : headers[i];
  };
  const dateCol = find(DATE_HEADERS);
  const descCol = find(DESC_HEADERS);
  const amountCol = find(AMOUNT_HEADERS);
  const debitCol = find(DEBIT_HEADERS);
  const creditCol = find(CREDIT_HEADERS);

  const out: Transaction[] = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    const amount = resolveAmount(row, amountCol, debitCol, creditCol);
    if (amount === undefined) continue;
    out.push({
      date: dateCol ? parseFlexibleDate(row[dateCol]) : undefined,
      description: (descCol ? row[descCol] : "") || "Transaction",
      amount,
    });
  }
  return out;
}

function resolveAmount(
  row: Record<string, string>,
  amountCol: string | undefined,
  debitCol: string | undefined,
  creditCol: string | undefined,
): string | undefined {
  if (amountCol && row[amountCol]?.trim()) {
    return normaliseAmount(row[amountCol]);
  }
  const debit = debitCol ? cleanNumber(row[debitCol]) : undefined;
  const credit = creditCol ? cleanNumber(row[creditCol]) : undefined;
  if (debit !== undefined && debit !== 0) return `-${Math.abs(debit)}`;
  if (credit !== undefined && credit !== 0) return `${Math.abs(credit)}`;
  return undefined;
}

/** Strip currency symbols/commas; keep the sign and decimals as text. */
export function normaliseAmount(raw: string): string | undefined {
  const cleaned = raw.replace(/[^0-9.\-()]/g, "").trim();
  if (!cleaned) return undefined;
  // Parenthesised negatives: (12.50) → -12.50.
  const paren = cleaned.match(/^\((.+)\)$/);
  const body = paren ? `-${paren[1]}` : cleaned;
  return Number.isFinite(Number(body)) ? body : undefined;
}

function cleanNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** Parse the OFX/QFX `<STMTTRN>` blocks. */
export function parseOfx(text: string, limit = Number.POSITIVE_INFINITY): Transaction[] {
  const out: Transaction[] = [];
  const blocks = text.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) ?? [];
  const currency = tag(text, "CURDEF");
  for (const block of blocks) {
    if (out.length >= limit) break;
    const amount = tag(block, "TRNAMT");
    if (!amount) continue;
    const name = tag(block, "NAME") ?? tag(block, "MEMO") ?? "Transaction";
    out.push({
      date: parseOfxDate(tag(block, "DTPOSTED")),
      description: name,
      amount: amount.trim(),
      currency,
    });
  }
  return out;
}

/** Read an OFX tag value (`<TAG>value` up to the next `<` or newline). */
function tag(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, "i"));
  return m ? m[1].trim() || undefined : undefined;
}

/** OFX dates are `YYYYMMDD` (optionally followed by HHMMSS / tz). */
export function parseOfxDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const m = raw.trim().match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return undefined;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Parse ISO, `D/M/Y` or `M/D/Y` dates leniently. */
export function parseFlexibleDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const parts = trimmed.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/);
  if (parts) {
    let year = Number(parts[3]);
    if (year < 100) year += 2000;
    // Default D/M (most non-US banks); swap when only the second can be a month.
    let day = Number(parts[1]);
    let month = Number(parts[2]);
    if (month > 12 && day <= 12) [day, month] = [month, day];
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
    const d = new Date(Date.UTC(year, month - 1, day));
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}
