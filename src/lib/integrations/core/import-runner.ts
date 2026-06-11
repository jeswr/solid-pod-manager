/**
 * The import runner — the one place integration data enters the pod.
 *
 *   adapter.import() → ctx.write(doc) → pod-data.writeResource (PUT Turtle)
 *   …then ensureTypeRegistrations so the data appears under My data.
 *
 * Demo vs live is decided here: demo wires the adapter's fixtures through the
 * typed fake fetch; live wraps the real fetch with the (in-memory) token.
 * Documents land at `<podRoot>integrations/<adapterId>/<slug>` — deterministic
 * URLs, so a re-import overwrites in place (idempotent).
 */
import { RdfFetchError } from "@jeswr/fetch-rdf";
import { writeResource } from "../../pod-data.js";
import { freshRdf } from "../../rdf-read.js";
import {
  type DesiredRegistration,
  ensureTypeRegistrations,
} from "../../type-index-write.js";
import { IntegrationSyncError } from "./errors.js";
import { fixtureFetch } from "./fixture-fetch.js";
import type {
  ImportProgress,
  IntegrationAdapter,
  TokenSet,
  WrittenDoc,
} from "./types.js";
import { VOCAB_PREFIXES } from "./vocab.js";

export type ImportMode = "live" | "demo";

export interface RunImportOptions {
  adapter: IntegrationAdapter;
  webId: string;
  /** The active storage root (ends with `/`). */
  podRoot: string;
  mode: ImportMode;
  /** Required for live mode. */
  token?: TokenSet;
  /** Cursor from the previous import (incremental, where supported). */
  cursor?: string;
  onProgress?: (p: ImportProgress) => void;
  /** Test-only pod fetch override; **omit in production**. */
  podFetch?: typeof fetch;
  /** Test-only source-API fetch override for live mode. */
  apiFetch?: typeof fetch;
}

export interface ImportReport {
  adapterId: string;
  mode: ImportMode;
  written: WrittenDoc[];
  /** Distinct category ids that received data (for the success screen). */
  categories: string[];
  /** Cursor to persist for the next incremental import, if any. */
  cursor?: string;
  /** The type-index document used/created. */
  indexUrl: string;
}

/** Root container for one adapter's documents. */
export function adapterContainerUrl(podRoot: string, adapterId: string): string {
  return new URL(`integrations/${adapterId}/`, podRoot).toString();
}

export async function runImport(opts: RunImportOptions): Promise<ImportReport> {
  const { adapter, mode } = opts;
  const id = adapter.metadata.id;

  const api =
    mode === "demo"
      ? fixtureFetch(id, adapter.fixtures())
      : tokenFetch(id, adapter, opts.token, opts.apiFetch);

  const root = adapterContainerUrl(opts.podRoot, id);
  const written: WrittenDoc[] = [];

  const outcome = await adapter.import({
    api,
    cursor: opts.cursor,
    resolve: (slug) => new URL(slug, root).toString(),
    read: async (slug) => {
      const url = new URL(slug, root).toString();
      try {
        const { dataset } = await freshRdf(url, opts.podFetch);
        return dataset;
      } catch (e) {
        if (e instanceof RdfFetchError && e.status === 404) return undefined;
        throw e;
      }
    },
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

  const { indexUrl } = await ensureTypeRegistrations({
    webId: opts.webId,
    podRoot: opts.podRoot,
    registrations: registrationsFor(written),
    fetchImpl: opts.podFetch,
  });

  return {
    adapterId: id,
    mode,
    written,
    categories: [...new Set(written.map((w) => w.category))],
    cursor: outcome.cursor,
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

/**
 * Live-mode source fetch: injects the bearer token + the adapter's static API
 * headers. The token goes to the platform's API host and nowhere else.
 */
function tokenFetch(
  adapterId: string,
  adapter: IntegrationAdapter,
  token: TokenSet | undefined,
  fetchImpl?: typeof fetch,
): typeof fetch {
  if (!token) {
    throw new IntegrationSyncError(adapterId, "Live import requires a token — authorize first.");
  }
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token.accessToken}`);
    for (const [k, v] of Object.entries(adapter.apiHeaders ?? {})) headers.set(k, v);
    const next: RequestInit = { ...init, headers };
    return fetchImpl ? fetchImpl(input as RequestInfo, next) : fetch(input as RequestInfo, next);
  };
  return impl as typeof fetch;
}
