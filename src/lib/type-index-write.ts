/**
 * Type-Index write path — make sure a set of `(forClass, container)` pairs is
 * registered, bootstrapping a private index when the profile has none (CSS
 * seeds none; DESIGN.md §9). Idempotent: existing registrations are left
 * untouched, so re-running an import never duplicates index entries.
 *
 * All RDF goes through the typed wrappers in `type-index.ts` — never inline
 * quads (house rule).
 */
import { fetchRdf } from "@jeswr/fetch-rdf";
import { DataFactory, Store } from "n3";
import { ResourceWriteError } from "./errors.js";
import { writeResource } from "./pod-data.js";
import {
  ProfileTypeIndexAnchor,
  TypeIndexDataset,
  TypeIndexDocument,
  TypeRegistration,
  typeIndexLinks,
} from "./type-index.js";

/** A registration the caller wants present: class → container. */
export interface DesiredRegistration {
  forClass: string;
  /** Container URL (must end in `/`). */
  container: string;
}

export interface EnsureRegistrationsResult {
  /** The index document the registrations live in. */
  indexUrl: string;
  /** How many registrations were newly added (0 = all already present). */
  added: number;
  /** True when a fresh private index was created and linked. */
  bootstrapped: boolean;
}

const PREFIXES = { solid: "http://www.w3.org/ns/solid/terms#" };

/**
 * Ensure every desired registration exists in the user's type index.
 *
 * Prefers the private index (imported account data is private by default);
 * falls back to the public one; bootstraps `settings/privateTypeIndex.ttl`
 * under the pod root — and links it from the profile — when neither exists.
 *
 * @param fetchImpl - test-only override; **omit in production** so the
 *   auth-patched global fetch runs.
 */
export async function ensureTypeRegistrations(opts: {
  webId: string;
  podRoot: string;
  registrations: DesiredRegistration[];
  fetchImpl?: typeof fetch;
}): Promise<EnsureRegistrationsResult> {
  const { webId, podRoot, registrations, fetchImpl } = opts;
  const fetchOpt = fetchImpl ? { fetch: fetchImpl } : undefined;

  const { dataset: profileDs, etag: profileEtag } = await fetchRdf(webId, fetchOpt);
  const links = typeIndexLinks(webId, profileDs);
  let indexUrl = links.privateIndex ?? links.publicIndex;
  let bootstrapped = false;

  if (!indexUrl) {
    indexUrl = new URL("settings/privateTypeIndex.ttl", podRoot).toString();
    await createIndexDocument(indexUrl, fetchImpl);
    // Link it from the profile (read-modify-write, ETag-guarded).
    const anchor = new ProfileTypeIndexAnchor(webId, profileDs, DataFactory);
    anchor.privateIndex = indexUrl;
    await writeResource(documentUrl(webId), profileDs, {
      etag: profileEtag,
      fetchImpl,
    });
    bootstrapped = true;
  }

  const { dataset: indexDs, etag: indexEtag } = await fetchRdf(indexUrl, fetchOpt);
  const index = new TypeIndexDataset(indexDs, DataFactory);

  let added = 0;
  for (const desired of registrations) {
    const exists = index
      .locate(desired.forClass)
      .some((l) => l.container === desired.container);
    if (exists) continue;
    const reg = new TypeRegistration(
      `${indexUrl}#reg-${fragmentFor(desired)}`,
      indexDs,
      DataFactory,
    );
    reg.markRegistration();
    reg.forClass = desired.forClass;
    reg.instanceContainer = desired.container;
    added += 1;
  }

  if (added > 0) {
    await writeResource(indexUrl, indexDs, {
      etag: indexEtag,
      fetchImpl,
      prefixes: PREFIXES,
    });
  }
  return { indexUrl, added, bootstrapped };
}

/** Mint a fresh, empty private type index. Tolerates "already exists" (412). */
async function createIndexDocument(
  indexUrl: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const store = new Store();
  new TypeIndexDocument(indexUrl, store, DataFactory).markUnlistedIndex();
  try {
    await writeResource(indexUrl, store, {
      createOnly: true,
      fetchImpl,
      prefixes: PREFIXES,
    });
  } catch (e) {
    // 412 under If-None-Match:* = the document already exists (e.g. created
    // out-of-band but never linked) — that is fine, we link and reuse it.
    if (e instanceof ResourceWriteError && e.status === 412) return;
    throw e;
  }
}

/** The profile *document* URL a WebID lives in (fragment stripped). */
function documentUrl(webId: string): string {
  const u = new URL(webId);
  u.hash = "";
  return u.toString();
}

/** Deterministic fragment for a registration (FNV-1a over class|container). */
function fragmentFor(reg: DesiredRegistration): string {
  const input = `${reg.forClass}|${reg.container}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
