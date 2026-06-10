/**
 * Goodreads → Documents (Tier-C file import).
 *
 * Goodreads "Export Library" gives `goodreads_library_export.csv`. The
 * load-bearing columns are `Book Id, Title, Author, ISBN, ISBN13, My Rating,
 * Exclusive Shelf, Date Read, Date Added`. ISBNs are wrapped by Goodreads as
 * `="0123456789"` to stop spreadsheets mangling them — we strip that wrapper.
 * Each book becomes a `schema:Book` in Documents, with the reader's rating and
 * shelf (read / currently-reading / to-read).
 *
 * Parsed natively (no dependency).
 */
import { DataFactory, Store } from "n3";
import { parseCsv } from "../core/csv.js";
import type { FileImportAdapter, FileImportContext, ImportFile } from "../core/file-import.js";
import { recordFragment } from "../core/slug.js";
import type { IntegrationMetadata } from "../core/types.js";
import { Book, CLASSES } from "../core/vocab.js";

const ID = "goodreads";

const metadata: IntegrationMetadata = {
  id: ID,
  name: "Goodreads",
  tier: "C",
  authKind: "export-file",
  scopes: [],
  categories: ["documents"],
  whatYouGet: "Your reading library and ratings, saved as books in Documents.",
  requirements: [],
};

export const goodreadsFileAdapter: FileImportAdapter = {
  metadata,
  accept: ".csv,text/csv",
  fileHint:
    "Goodreads → My Books → Import and export → Export Library. Select goodreads_library_export.csv.",

  async importFile(file: ImportFile, ctx: FileImportContext): Promise<void> {
    ctx.progress({ label: "Reading your library…", done: 0, total: 1 });
    const { rows } = parseCsv(await file.text());

    const doc = ctx.resolve("documents/goodreads-library.ttl");
    const store = new Store();
    let count = 0;
    for (const row of rows) {
      if (count >= ctx.maxRows) break;
      const title = row.Title?.trim();
      if (!title) continue;
      const bookId = row["Book Id"]?.trim();
      const frag = recordFragment(title, bookId || `${title}|${row.Author ?? ""}`);
      const book = new Book(`${doc}#book-${frag}`, store, DataFactory).mark();
      book.name = title;
      if (bookId) book.identifier = bookId;
      const author = row.Author?.trim();
      if (author) book.author = author;
      const isbn = cleanIsbn(row.ISBN13) || cleanIsbn(row.ISBN);
      if (isbn) book.isbn = isbn;
      const rating = Number.parseInt(row["My Rating"] ?? "", 10);
      if (Number.isFinite(rating) && rating > 0) book.ratingValue = rating;
      const shelf = row["Exclusive Shelf"]?.trim();
      if (shelf) book.readingStatus = shelf;
      const added = parseDateOnly(row["Date Added"]);
      if (added) book.dateCreated = added;
      count++;
    }

    ctx.progress({ label: "Saving to your pod…", done: 1, total: 1 });
    await ctx.write({
      slug: "documents/goodreads-library.ttl",
      category: "documents",
      forClass: CLASSES.Book,
      dataset: store,
    });
  },
};

/** Goodreads wraps ISBNs as `="0123456789"`; unwrap and validate digits. */
export function cleanIsbn(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const inner = raw.trim().replace(/^="?|"?$/g, "").trim();
  return /^[0-9Xx]{10,13}$/.test(inner) ? inner : undefined;
}

/** Goodreads dates are `YYYY/MM/DD`. */
export function parseDateOnly(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const m = raw.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!m) return undefined;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? undefined : d;
}
