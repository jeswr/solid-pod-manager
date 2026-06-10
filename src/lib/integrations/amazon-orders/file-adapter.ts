/**
 * Amazon orders → Finance (Tier-C file import).
 *
 * Amazon's "Request my data → Your Orders" export delivers a CSV (commonly
 * `Retail.OrderHistory.1.csv`). Column names have shifted across Amazon's
 * export generations and locales, so we resolve each field through a list of
 * known header aliases rather than a single fixed name. Each order line becomes
 * a `schema:Invoice` in Finance, with the product as the invoice description,
 * the order id as identifier, the total as `totalPaymentDue`, and the order
 * date as `dateCreated`.
 *
 * Parsed natively (no dependency). The newest Amazon export is plain CSV; only
 * the very old "order reports" came zipped — we accept the CSV directly.
 */
import { DataFactory, Store } from "n3";
import { parseCsv } from "../core/csv.js";
import type { FileImportAdapter, FileImportContext, ImportFile } from "../core/file-import.js";
import { recordFragment } from "../core/slug.js";
import type { IntegrationMetadata } from "../core/types.js";
import { CLASSES, Invoice } from "../core/vocab.js";

const ID = "amazon-orders";

const metadata: IntegrationMetadata = {
  id: ID,
  name: "Amazon orders",
  tier: "C",
  authKind: "export-file",
  scopes: [],
  categories: ["finance"],
  whatYouGet: "Your order history, saved as receipts in Finance.",
  requirements: [],
};

/** Header aliases across Amazon export generations / locales. */
const FIELD = {
  orderId: ["Order ID", "Order Id", "order id", "OrderID"],
  date: ["Order Date", "Ship Date", "order date"],
  product: ["Product Name", "Title", "product name", "Item"],
  total: ["Total Owed", "Item Total", "Total Charged", "total owed"],
  currency: ["Currency", "currency"],
  status: ["Order Status", "Shipment Status", "order status"],
} as const;

function pick(row: Record<string, string>, names: readonly string[]): string | undefined {
  for (const n of names) {
    const v = row[n];
    if (v != null && v.trim() !== "") return v.trim();
  }
  return undefined;
}

export const amazonOrdersFileAdapter: FileImportAdapter = {
  metadata,
  accept: ".csv,text/csv",
  fileHint:
    "Amazon → Account → Request your data → Your Orders. From the export, select the order-history CSV (e.g. Retail.OrderHistory.1.csv).",

  async importFile(file: ImportFile, ctx: FileImportContext): Promise<void> {
    ctx.progress({ label: "Reading your orders…", done: 0, total: 1 });
    const { rows } = parseCsv(await file.text());

    const doc = ctx.resolve("finance/amazon-orders.ttl");
    const store = new Store();
    let count = 0;
    for (const row of rows) {
      if (count >= ctx.maxRows) break;
      const product = pick(row, FIELD.product);
      const orderId = pick(row, FIELD.orderId);
      if (!product && !orderId) continue;
      const key = `${orderId ?? ""}|${product ?? ""}|${pick(row, FIELD.date) ?? ""}`;
      const frag = recordFragment(product ?? orderId ?? "order", key);
      const inv = new Invoice(`${doc}#order-${frag}`, store, DataFactory).mark();
      inv.name = product ?? `Order ${orderId}`;
      inv.provider = "Amazon";
      if (orderId) inv.identifier = orderId;
      const total = pick(row, FIELD.total);
      if (total) inv.totalPaymentDue = total;
      const currency = pick(row, FIELD.currency);
      if (currency) inv.priceCurrency = currency;
      const status = pick(row, FIELD.status);
      if (status) inv.paymentStatus = status;
      const date = parseDate(pick(row, FIELD.date));
      if (date) inv.dateCreated = date;
      count++;
    }

    ctx.progress({ label: "Saving to your pod…", done: 1, total: 1 });
    await ctx.write({
      slug: "finance/amazon-orders.ttl",
      category: "finance",
      forClass: CLASSES.Invoice,
      dataset: store,
    });
  },
};

/** Parse ISO (`2023-02-14`) or `M/D/YYYY` dates from the Amazon export. */
export function parseDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const us = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (us) {
    let year = Number(us[3]);
    if (year < 100) year += 2000;
    const d = new Date(Date.UTC(year, Number(us[1]) - 1, Number(us[2])));
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}
