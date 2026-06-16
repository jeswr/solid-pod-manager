// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Type-Index management — the read+write model behind the management UI.
 *
 * `type-index.ts` reads registrations and `type-index-write.ts` bootstraps
 * container registrations for the first-party apps. This module is the
 * **user-facing manager**: enumerate every registration across the public and
 * private indexes (tagged with which index + which registration subject it came
 * from, so the UI can target a removal), add an arbitrary registration, and
 * remove one — a SolidOS capability (view/register/repair the type index).
 *
 * All RDF goes through the typed wrappers in `type-index.ts`; writes are
 * read-modify-write with conditional `If-Match` (preserve the rest of the index,
 * fail-closed on a concurrent edit).
 */
import { DataFactory } from "n3";
import { freshRdf } from "./rdf-read.js";
import { writeResource } from "./pod-data.js";
import {
  ProfileTypeIndexAnchor,
  TypeIndexDataset,
  TypeRegistration,
  resolvePrivateIndex,
  type RegisteredLocation,
} from "./type-index.js";

const SOLID = "http://www.w3.org/ns/solid/terms#";
const PREFIXES = { solid: SOLID } as const;

/** Which of the two indexes a registration lives in. */
export type IndexKind = "public" | "private";

/**
 * A managed registration: a {@link RegisteredLocation} plus the bookkeeping the
 * UI needs to act on it — which index document it lives in and the subject IRI
 * of its `solid:TypeRegistration` (so a removal targets exactly that entry).
 */
export interface ManagedRegistration extends RegisteredLocation {
  indexKind: IndexKind;
  indexUrl: string;
  /** The `solid:TypeRegistration` subject IRI. */
  subject: string;
}

/** The full management view: per-index URL + the flattened registration list. */
export interface ManagedTypeIndex {
  publicIndex?: string;
  privateIndex?: string;
  registrations: ManagedRegistration[];
}

/**
 * Enumerate every registration across the user's public + private indexes.
 *
 * The profile dataset must already be fetched (it carries the index links).
 * A missing/unreadable index contributes nothing (it is not an error — CSS
 * seeds none).
 *
 * @param fetchImpl - test-only override; **omit in production** so the
 *   auth-patched global fetch runs.
 */
export async function listAllRegistrations(
  webId: string,
  profile: import("@rdfjs/types").DatasetCore,
  fetchImpl?: typeof fetch,
): Promise<ManagedTypeIndex> {
  // The public index is on the card; the private index is resolved the
  // spec-compliant way (preferences file first, legacy card fallback) so the
  // manager shows the index wherever it actually lives (task #87).
  const publicIndex = new ProfileTypeIndexAnchor(webId, profile, DataFactory).publicIndex;
  const { privateIndex } = await resolvePrivateIndex(webId, profile, fetchImpl);
  const links = { publicIndex, privateIndex };
  const out: ManagedRegistration[] = [];

  for (const [kind, url] of [
    ["public", links.publicIndex],
    ["private", links.privateIndex],
  ] as const) {
    if (!url) continue;
    const ds = await readIndexDataset(url, fetchImpl);
    if (!ds) continue;
    const index = new TypeIndexDataset(ds, DataFactory);
    for (const reg of index.registrations) {
      const forClass = reg.forClass;
      if (!forClass) continue;
      out.push({
        forClass,
        instance: reg.instance,
        container: reg.instanceContainer,
        indexKind: kind,
        indexUrl: url,
        subject: reg.value,
      });
    }
  }

  return {
    publicIndex: links.publicIndex,
    privateIndex: links.privateIndex,
    registrations: out,
  };
}

/** Read an index document into a raw dataset, tolerating absence (404/403). */
async function readIndexDataset(
  url: string,
  fetchImpl?: typeof fetch,
): Promise<import("@rdfjs/types").DatasetCore | undefined> {
  try {
    const { dataset } = await freshRdf(url, fetchImpl);
    return dataset;
  } catch (e) {
    const status = (e as { status?: number } | undefined)?.status;
    if (status === 404 || status === 403) return undefined;
    throw e;
  }
}

/** A registration the user is adding through the manager. */
export interface NewRegistration {
  forClass: string;
  /** `solid:instanceContainer` target (a container URL, ends in `/`). */
  container?: string;
  /** `solid:instance` target (a single resource URL). */
  instance?: string;
}

/**
 * Add a registration to an existing index document (read-modify-write).
 *
 * Idempotent: an identical `(forClass, instance|container)` entry already
 * present is a no-op (returns `added: false`). Exactly one of
 * `container`/`instance` must be supplied.
 *
 * @param fetchImpl - test-only override; omit in production.
 */
export async function addRegistration(opts: {
  indexUrl: string;
  registration: NewRegistration;
  fetchImpl?: typeof fetch;
}): Promise<{ added: boolean; subject: string }> {
  const { indexUrl, registration, fetchImpl } = opts;
  const { instance, forClass } = registration;
  if (Boolean(registration.container) === Boolean(instance)) {
    throw new TypeError("Provide exactly one of container or instance.");
  }
  // `solid:instanceContainer` targets MUST be container URLs (trailing slash).
  // Normalise here so a missing slash never mints a broken registration.
  const container = registration.container
    ? registration.container.endsWith("/")
      ? registration.container
      : `${registration.container}/`
    : undefined;

  const { dataset, etag } = await freshRdf(indexUrl, fetchImpl);
  const index = new TypeIndexDataset(dataset, DataFactory);

  const exists = index
    .locate(forClass)
    .some((l) => l.container === container && l.instance === instance);
  const subject = `${indexUrl}#reg-${fragmentFor(forClass, container ?? instance ?? "")}`;
  if (exists) return { added: false, subject };

  const reg = new TypeRegistration(subject, dataset, DataFactory);
  reg.markRegistration();
  reg.forClass = forClass;
  if (container) reg.instanceContainer = container;
  if (instance) reg.instance = instance;

  await writeResource(indexUrl, dataset, { etag, fetchImpl, prefixes: PREFIXES });
  return { added: true, subject };
}

/**
 * Remove a registration (every triple about its subject) from an index
 * document (read-modify-write). Idempotent — a missing subject is a no-op.
 *
 * @param fetchImpl - test-only override; omit in production.
 */
export async function removeRegistration(opts: {
  indexUrl: string;
  subject: string;
  fetchImpl?: typeof fetch;
}): Promise<{ removed: boolean }> {
  const { indexUrl, subject, fetchImpl } = opts;
  const { dataset, etag } = await freshRdf(indexUrl, fetchImpl);

  const subjectTerm = DataFactory.namedNode(subject);
  const toDelete = [...dataset.match(subjectTerm, null, null)];
  if (toDelete.length === 0) return { removed: false };
  for (const q of toDelete) dataset.delete(q);

  await writeResource(indexUrl, dataset, { etag, fetchImpl, prefixes: PREFIXES });
  return { removed: true };
}

/** Deterministic fragment for a registration (FNV-1a over class|target). */
function fragmentFor(forClass: string, target: string): string {
  const input = `${forClass}|${target}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
