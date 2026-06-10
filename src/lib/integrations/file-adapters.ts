/**
 * The Tier-C **file-import** adapter registry — the export-file analogue of the
 * OAuth `ADAPTERS` list in `registry.ts`. Each of the 10 Tier-C catalog entries
 * has a parser that turns the platform's official data export into pod RDF.
 */
import { amazonOrdersFileAdapter } from "./amazon-orders/file-adapter.js";
import { appleHealthFileAdapter } from "./apple-health/file-adapter.js";
import { bankStatementsFileAdapter } from "./bank-statements/file-adapter.js";
import { chatgptFileAdapter } from "./chatgpt/file-adapter.js";
import { goodreadsFileAdapter } from "./goodreads/file-adapter.js";
import { googleTakeoutFileAdapter } from "./google-takeout/file-adapter.js";
import { netflixFileAdapter } from "./netflix/file-adapter.js";
import { steamFileAdapter } from "./steam/file-adapter.js";
import { uberFileAdapter } from "./uber/file-adapter.js";
import { whatsappFileAdapter } from "./whatsapp/file-adapter.js";
import type { FileImportAdapter } from "./core/file-import.js";

/** All 10 Tier-C file-import adapters. */
export const FILE_ADAPTERS: readonly FileImportAdapter[] = [
  netflixFileAdapter,
  amazonOrdersFileAdapter,
  uberFileAdapter,
  appleHealthFileAdapter,
  whatsappFileAdapter,
  goodreadsFileAdapter,
  steamFileAdapter,
  chatgptFileAdapter,
  bankStatementsFileAdapter,
  googleTakeoutFileAdapter,
];

const byId = new Map(FILE_ADAPTERS.map((a) => [a.metadata.id, a]));

/** The file-import adapter for a Tier-C catalog id, if one exists. */
export function fileAdapterById(id: string): FileImportAdapter | undefined {
  return byId.get(id);
}
