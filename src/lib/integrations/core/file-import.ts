/**
 * The Tier-C **file-import** runner — the second place integration data enters
 * the pod, beside the OAuth `import-runner`. It deliberately reuses the same
 * write stack (no parallel fork):
 *
 *   adapter.importFile(file, ctx) → ctx.write(doc) → pod-data.writeResource
 *   …then ensureTypeRegistrations so the data appears under "My data".
 *
 * Where the OAuth path pulls JSON from a platform API, a Tier-C adapter parses
 * a file the user uploaded from the platform's official data export (Netflix
 * viewing CSV, ChatGPT conversations.json, …). Everything after parsing —
 * deterministic slugs under `<podRoot>integrations/<id>/`, idempotent
 * overwrite, type-index registration, the WrittenDoc/category report — is
 * identical to the OAuth runner.
 *
 * Security: the uploaded file is fully untrusted. We only ever read its **text**
 * (the parser never `eval`s, never builds a URL to fetch with the user's auth);
 * parsed values become inert RDF literals. We cap the file size and the number
 * of rows so a hostile or accidental multi-GB export can't exhaust memory or
 * write an unbounded pod document. Writes are confined to the adapter's own
 * container under the user's pod root (the slug-escape guard below).
 */
import { IntegrationSyncError } from "./errors.js";
import {
  adapterContainerUrl,
  type ImportReport,
} from "./import-runner.js";
import { writeResource } from "../../pod-data.js";
import {
  type DesiredRegistration,
  ensureTypeRegistrations,
} from "../../type-index-write.js";
import type {
  ImportProgress,
  IntegrationMetadata,
  NormalisedDoc,
  WrittenDoc,
} from "./types.js";
import { VOCAB_PREFIXES } from "./vocab.js";

/**
 * Hard caps for untrusted uploads. A real export is a few MB at most; these
 * are generous ceilings that still bound memory and the written document size.
 */
export const MAX_FILE_BYTES = 64 * 1024 * 1024; // 64 MiB
export const MAX_ROWS = 100_000;

/** A subset of the browser `File` API the parsers actually need (test-friendly). */
export interface ImportFile {
  readonly name: string;
  readonly size: number;
  /** The file type hint from the browser (may be empty / unreliable). */
  readonly type: string;
  /** Decode the file as UTF-8 text. */
  text(): Promise<string>;
}

/** What a file-import adapter hands the runner to write (mirrors the OAuth ctx). */
export interface FileImportContext {
  /** Resolve a slug to the absolute pod URL it will be written at (for fragment IRIs). */
  resolve(slug: string): string;
  /** Serialise + PUT a normalised document into the pod. */
  write(doc: NormalisedDoc): Promise<WrittenDoc>;
  /** Report progress to the UI. */
  progress(p: ImportProgress): void;
  /** Shared row cap so adapters bound their own loops consistently. */
  readonly maxRows: number;
}

/**
 * A Tier-C adapter: catalog metadata, the file types it accepts, and a parser
 * that turns one uploaded export file into pod documents via `ctx.write`.
 */
export interface FileImportAdapter {
  readonly metadata: IntegrationMetadata;
  /**
   * The `accept` attribute for the file input (e.g. `".csv,text/csv"`). Honest
   * about what the parser actually reads — for ZIP exports we accept the inner
   * extracted file, never the archive itself.
   */
  readonly accept: string;
  /**
   * Human guidance shown above the picker — exactly which file to select,
   * including any "unzip first and choose X" step for archive exports.
   */
  readonly fileHint: string;
  /**
   * The platform's own "download your data" page, rendered as a prominent
   * external link on the connect screen. **Absent** when there is no single
   * web URL to send the user to (in-app exports like WhatsApp/Apple Health,
   * or bank-specific statement downloads) — the UI must handle absence.
   * The `fileHint` still carries the which-file guidance either way.
   */
  readonly exportUrl?: string;
  /** Parse the uploaded file and write normalised documents. */
  importFile(file: ImportFile, ctx: FileImportContext): Promise<void>;
}

export interface RunFileImportOptions {
  adapter: FileImportAdapter;
  file: ImportFile;
  webId: string;
  /** The active storage root (ends with `/`). */
  podRoot: string;
  onProgress?: (p: ImportProgress) => void;
  /** Test-only pod fetch override; **omit in production**. */
  podFetch?: typeof fetch;
}

/**
 * Run one file import end-to-end: validate the upload, let the adapter parse +
 * write, then ensure type-index registrations. Returns the same
 * {@link ImportReport} shape the OAuth runner does, so the UI is shared.
 */
export async function runFileImport(
  opts: RunFileImportOptions,
): Promise<ImportReport> {
  const { adapter, file } = opts;
  const id = adapter.metadata.id;

  if (file.size > MAX_FILE_BYTES) {
    throw new IntegrationSyncError(
      id,
      `That file is ${formatBytes(file.size)} — larger than the ${formatBytes(MAX_FILE_BYTES)} import limit. Please split the export.`,
    );
  }

  const root = adapterContainerUrl(opts.podRoot, id);
  const written: WrittenDoc[] = [];

  await adapter.importFile(file, {
    maxRows: MAX_ROWS,
    resolve: (slug) => new URL(slug, root).toString(),
    progress: (p) => opts.onProgress?.(p),
    write: async (doc) => {
      const url = new URL(doc.slug, root).toString();
      if (!url.startsWith(root)) {
        throw new IntegrationSyncError(id, `Slug escapes the adapter container: ${doc.slug}`);
      }
      await writeResource(url, doc.dataset, {
        fetchImpl: opts.podFetch,
        prefixes: { ...VOCAB_PREFIXES },
      });
      const w: WrittenDoc = {
        url,
        category: doc.category,
        forClass: doc.forClass,
        skipRegistration: doc.skipRegistration,
      };
      written.push(w);
      return w;
    },
  });

  if (written.length === 0) {
    throw new IntegrationSyncError(
      id,
      "No importable records were found in that file. Double-check you selected the right export file.",
    );
  }

  const { indexUrl } = await ensureTypeRegistrations({
    webId: opts.webId,
    podRoot: opts.podRoot,
    registrations: registrationsFor(written),
    fetchImpl: opts.podFetch,
  });

  return {
    adapterId: id,
    mode: "live",
    written,
    categories: [...new Set(written.map((w) => w.category))],
    indexUrl,
  };
}

/** Distinct (forClass, containing-container) pairs from the written docs. */
function registrationsFor(written: WrittenDoc[]): DesiredRegistration[] {
  const out = new Map<string, DesiredRegistration>();
  for (const w of written) {
    if (w.skipRegistration) continue;
    const container = w.url.slice(0, w.url.lastIndexOf("/") + 1);
    out.set(`${w.forClass}|${container}`, { forClass: w.forClass, container });
  }
  return [...out.values()];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
