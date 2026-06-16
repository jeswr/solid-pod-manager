/**
 * Type-Index write path — make sure a set of `(forClass, container)` pairs is
 * registered, bootstrapping a private index when the profile has none (CSS
 * seeds none; DESIGN.md §9). Idempotent: existing registrations are left
 * untouched, so re-running an import never duplicates index entries.
 *
 * PRIVACY (task #87): the `solid:privateTypeIndex` link lives in the
 * owner-private Preferences Document (`space:preferencesFile`), NEVER on the
 * world-readable WebID card. This module creates/links the private index there,
 * and MIGRATES a legacy card link (move to prefs + remove from the card) on the
 * next write. All RDF goes through the typed wrappers (house rule).
 */
import { DataFactory, Store } from "n3";
import type { DatasetCore } from "@rdfjs/types";
import { RdfFetchError } from "@jeswr/fetch-rdf";
import { freshRdf } from "./rdf-read.js";
import { ResourceWriteError } from "./errors.js";
import { writeResource } from "./pod-data.js";
import { ensurePreferencesFile, readPreferences } from "./preferences.js";
import {
  ProfileTypeIndexAnchor,
  TypeIndexDataset,
  TypeIndexDocument,
  TypeRegistration,
  resolvePrivateIndex,
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
  /** True when a legacy card `privateTypeIndex` link was migrated to prefs. */
  migrated: boolean;
}

const PREFIXES = { solid: "http://www.w3.org/ns/solid/terms#" };

/**
 * Ensure every desired registration exists in the user's PRIVATE type index
 * (imported account data is private by default).
 *
 * The private index is discovered the spec-compliant way and, when absent,
 * bootstrapped at `settings/privateTypeIndex.ttl` and linked from the
 * owner-private PREFERENCES FILE (not the public card). A legacy card link is
 * migrated to prefs (and removed from the card) here. See {@link
 * migratePrivateIndexLink} for the migration, which runs first.
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

  // Resolve (and migrate/bootstrap) the private index link — always in the
  // preferences file. This reads + revalidates the card internally.
  const { indexUrl, bootstrapped, migrated } = await ensurePrivateIndexLink({
    webId,
    podRoot,
    fetchImpl,
  });

  // Read the index. A linked-but-missing index (a dangling legacy pointer) is
  // tolerated: mint a fresh, typed index document in memory and create it on the
  // write below (create-and-link robustness — the index is convention, not
  // server-maintained; type-index skill).
  let indexDs: DatasetCore;
  let indexEtag: string | null;
  let indexMissing = false;
  try {
    const read = await freshRdf(indexUrl, fetchImpl);
    indexDs = read.dataset;
    indexEtag = read.etag;
  } catch (e) {
    if (e instanceof RdfFetchError && e.status === 404) {
      indexDs = new Store();
      new TypeIndexDocument(indexUrl, indexDs, DataFactory).markUnlistedIndex();
      indexEtag = null;
      indexMissing = true;
    } else {
      throw e;
    }
  }
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

  // Write when we added registrations OR when we just minted a missing index
  // doc (so the dangling link now resolves to a real, typed document).
  if (added > 0 || indexMissing) {
    try {
      await writeResource(indexUrl, indexDs, {
        etag: indexEtag,
        // A freshly-minted (missing) index is create-only so a concurrent writer
        // that created it first is not clobbered.
        createOnly: indexMissing,
        fetchImpl,
        prefixes: PREFIXES,
      });
    } catch (e) {
      // 412 on a create-only mint = another client created the index between our
      // 404 read and this write. The index now exists; our registrations (if
      // any) will be reconciled on the next idempotent run, so this is not fatal.
      if (!(indexMissing && e instanceof ResourceWriteError && e.status === 412)) throw e;
    }
  }
  return { indexUrl, added, bootstrapped, migrated };
}

/** The private index URL plus what the link operation did. */
interface PrivateIndexLink {
  indexUrl: string;
  /** A fresh index document was created + linked. */
  bootstrapped: boolean;
  /** A legacy card link was migrated to the preferences file. */
  migrated: boolean;
}

/**
 * Ensure the private type index is linked from the preferences file, returning
 * its URL. The single place the private-index link is created/moved:
 *
 *   1. {@link migratePrivateIndexLink} first — if the card carries a legacy
 *      `solid:privateTypeIndex`, move it into the prefs file and REMOVE it from
 *      the card (idempotent: a second run is a no-op).
 *   2. Re-resolve the private index the spec-compliant way (prefs first). If
 *      found, reuse it.
 *   3. Otherwise BOOTSTRAP a fresh `settings/privateTypeIndex.ttl`, create the
 *      prefs file if needed (owner-only WAC), and link the index from prefs.
 *
 * @param fetchImpl - test-only override; omit in production.
 */
export async function ensurePrivateIndexLink(opts: {
  webId: string;
  podRoot: string;
  fetchImpl?: typeof fetch;
}): Promise<PrivateIndexLink> {
  const { webId, podRoot, fetchImpl } = opts;

  const migrated = await migratePrivateIndexLink({ webId, podRoot, fetchImpl });

  // Read-modify-write the card: revalidated read so the ETag is fresh.
  const { dataset: profileDs, etag: profileEtag } = await freshRdf(webId, fetchImpl);
  const resolved = await resolvePrivateIndex(webId, profileDs, fetchImpl);
  if (resolved.privateIndex) {
    return { indexUrl: resolved.privateIndex, bootstrapped: false, migrated };
  }

  // No private index anywhere — bootstrap one and link it from the prefs file.
  const indexUrl = new URL("settings/privateTypeIndex.ttl", podRoot).toString();
  await createIndexDocument(indexUrl, fetchImpl);
  const { preferencesFile } = await ensurePreferencesFile({
    webId,
    podRoot,
    profile: profileDs,
    profileEtag,
    fetchImpl,
  });
  await setPrivateIndexInPreferences(preferencesFile, indexUrl, fetchImpl);
  return { indexUrl, bootstrapped: true, migrated };
}

/**
 * Migrate a legacy `solid:privateTypeIndex` link off the world-readable card and
 * into the owner-private preferences file (task #87). Idempotent — a card with
 * no legacy link, or whose link already lives in prefs, is a no-op (returns
 * `false`).
 *
 * The move is done conditionally, foreign triples preserved:
 *   - copy the link into the prefs file (creating + WAC-locking it if absent);
 *   - remove ONLY the `solid:privateTypeIndex` triple from the card (every other
 *     card triple — name, storage, public index, inbox — is left untouched).
 *
 * The public type index stays on the card (it is meant to be public).
 *
 * @returns true when a migration was performed.
 */
export async function migratePrivateIndexLink(opts: {
  webId: string;
  podRoot: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const { webId, podRoot, fetchImpl } = opts;
  const { dataset: profileDs, etag: profileEtag } = await freshRdf(webId, fetchImpl);
  const cardAnchor = new ProfileTypeIndexAnchor(webId, profileDs, DataFactory);
  const legacy = cardAnchor.privateIndex;
  if (!legacy) return false; // nothing on the card → nothing to migrate (no-op)

  // Move it into the prefs file FIRST (create + WAC-lock if needed), so the link
  // is never momentarily absent from both documents.
  const { preferencesFile } = await ensurePreferencesFile({
    webId,
    podRoot,
    profile: profileDs,
    profileEtag,
    fetchImpl,
  });
  await setPrivateIndexInPreferences(preferencesFile, legacy, fetchImpl);

  // Re-read the card: ensurePreferencesFile may have written it (adding the
  // prefs link), invalidating our ETag. Then strip ONLY the legacy private-index
  // triple, preserving every other triple.
  const { dataset: freshCard, etag: freshEtag } = await freshRdf(webId, fetchImpl);
  const anchor = new ProfileTypeIndexAnchor(webId, freshCard, DataFactory);
  if (anchor.privateIndex === undefined) return true; // already stripped (re-run)
  anchor.privateIndex = undefined; // OptionalAs.object removes the triple
  await writeResource(documentUrl(webId), freshCard, { etag: freshEtag, fetchImpl });
  return true;
}

/**
 * Set `solid:privateTypeIndex` in the preferences file (read-modify-write,
 * conditional, foreign triples preserved). Idempotent — re-setting the same
 * value writes nothing.
 */
async function setPrivateIndexInPreferences(
  preferencesFile: string,
  indexUrl: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const prefs = await readPreferences(preferencesFile, fetchImpl);
  // The prefs file was just created/linked by ensurePreferencesFile, so a
  // missing read here is unexpected — fail loudly rather than silently skip.
  if (!prefs) throw new ResourceWriteError(preferencesFile, 404);
  const dataset: DatasetCore = prefs.dataset;
  const anchor = new ProfileTypeIndexAnchor(preferencesFile, dataset, DataFactory);
  if (anchor.privateIndex === indexUrl) return; // already set — no write
  anchor.privateIndex = indexUrl;
  await writeResource(preferencesFile, dataset, {
    etag: prefs.etag,
    fetchImpl,
    prefixes: PREFIXES,
  });
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
