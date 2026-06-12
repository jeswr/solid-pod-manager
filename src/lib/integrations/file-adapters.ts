/**
 * The **file-import** adapter registry — the export-file analogue of the
 * OAuth `ADAPTERS` list in `registry.ts`. Each of the 10 Tier-C catalog entries
 * has a parser that turns the platform's official data export into pod RDF.
 *
 * A Tier-B entry may ALSO appear here (Garmin): when the platform's OAuth API
 * is approval-gated but its self-serve data export already works, the file
 * adapter complements the OAuth adapter under the same catalog id and the
 * connect page shows both paths.
 */
import { amazonOrdersFileAdapter } from "./amazon-orders/file-adapter.js";
import { appleHealthFileAdapter } from "./apple-health/file-adapter.js";
import { bankStatementsFileAdapter } from "./bank-statements/file-adapter.js";
import { chatgptFileAdapter } from "./chatgpt/file-adapter.js";
import { garminFileAdapter } from "./garmin/file-adapter.js";
import { goodreadsFileAdapter } from "./goodreads/file-adapter.js";
import { googleTakeoutFileAdapter } from "./google-takeout/file-adapter.js";
import { netflixFileAdapter } from "./netflix/file-adapter.js";
import { steamFileAdapter } from "./steam/file-adapter.js";
import { uberFileAdapter } from "./uber/file-adapter.js";
import { whatsappFileAdapter } from "./whatsapp/file-adapter.js";
import type { FileImportAdapter } from "./core/file-import.js";

/** The 10 Tier-C file-import adapters plus the Tier-B hybrids (Garmin). */
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
  garminFileAdapter,
];

const byId = new Map(FILE_ADAPTERS.map((a) => [a.metadata.id, a]));

/** The file-import adapter for a catalog id (Tier C, or a Tier-B hybrid), if one exists. */
export function fileAdapterById(id: string): FileImportAdapter | undefined {
  return byId.get(id);
}
