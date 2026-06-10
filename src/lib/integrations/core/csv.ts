/**
 * A small, dependency-free CSV parser for Tier-C export files.
 *
 * Export CSVs (Netflix, Amazon, Uber, Goodreads, bank statements, …) are
 * RFC-4180-ish but messy: quoted fields with embedded commas, embedded
 * newlines and doubled `""` escapes, `\r\n` or bare `\n` line endings, a
 * trailing newline, and the occasional UTF-8 BOM. A purpose-built parser is
 * smaller and safer here than pulling a dependency: it never executes input,
 * only ever returns string cells (which become RDF literals downstream).
 *
 * The input is treated as fully untrusted. There is no formula/`=`-prefix
 * "CSV injection" risk because we never write these cells back into a
 * spreadsheet or a shell — they become inert RDF string literals.
 */

/** A parsed CSV: the header row plus each data row keyed by column name. */
export interface ParsedCsv {
  /** Column names from the first row, trimmed (BOM stripped). */
  readonly headers: readonly string[];
  /** Data rows; each maps a header to its (possibly empty) cell value. */
  readonly rows: readonly Readonly<Record<string, string>>[];
}

/**
 * Tokenise CSV text into a matrix of string cells. Handles quoting, embedded
 * commas/newlines, `""` escapes and CRLF/LF/CR line endings. A leading UTF-8
 * BOM is stripped. Blank trailing lines are dropped.
 */
export function parseCsvRows(text: string, delimiter = ","): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = src.length;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === delimiter) {
      endField();
      i += 1;
      continue;
    }
    if (c === "\r") {
      // Treat CRLF and bare CR as one line break.
      endRow();
      i += src[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (c === "\n") {
      endRow();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  // Flush the final field/row unless the input ended on a clean line break.
  if (field.length > 0 || row.length > 0) endRow();

  // Drop a single empty trailing row produced by a final newline.
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/**
 * Parse CSV text into headers + keyed rows. The first non-empty line is the
 * header. Cells are trimmed of surrounding whitespace. Rows with fewer cells
 * than headers are padded with empty strings; extra cells are ignored.
 */
export function parseCsv(text: string, delimiter = ","): ParsedCsv {
  const matrix = parseCsvRows(text, delimiter);
  if (matrix.length === 0) return { headers: [], rows: [] };
  const headers = matrix[0].map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let r = 1; r < matrix.length; r++) {
    const cells = matrix[r];
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = (cells[c] ?? "").trim();
    }
    rows.push(obj);
  }
  return { headers, rows };
}
