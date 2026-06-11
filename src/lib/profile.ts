/**
 * Profile reading — the WebID profile as a plain, serialisable shape the UI
 * can render directly (the UI layer never touches RDF; AGENTS.md Part 2
 * §Layering). Built on `@solid/object`'s `WebIdDataset` + the `ProfileAgent`
 * rendering fallback chains.
 */
import { WebIdDataset } from "@solid/object";
import { DataFactory } from "n3";
import { freshRdf } from "./rdf-read.js";
import { ProfileAgent } from "./profile-agent.js";
import { NoStorageError } from "./errors.js";

/** A rendered profile — everything the UI needs, no RDF terms. */
export interface PodProfile {
  webId: string;
  /** Display name with the full fallback chain; never empty (falls back to WebID). */
  displayName: string;
  avatarUrl?: string;
  bio?: string;
  /** Every `pim:storage` advertised. The user chooses when there are several. */
  storages: string[];
  /** Every `solid:oidcIssuer` on the profile. */
  issuers: string[];
}

/**
 * Build a {@link PodProfile} from an already-parsed profile dataset.
 *
 * Pure (no I/O) so it is trivially testable with a `parseRdf` fixture. Survives
 * bare CSS profiles: missing name/photo/storage are not errors here — callers
 * that *need* storage use {@link requireStorage}.
 */
export function readProfile(
  webId: string,
  dataset: import("@rdfjs/types").DatasetCore,
): PodProfile {
  const agent = new ProfileAgent(webId, dataset, DataFactory);
  const main = new WebIdDataset(dataset, DataFactory).mainSubject;
  return {
    webId,
    displayName: agent.displayName,
    avatarUrl: agent.avatarUrl ?? undefined,
    bio: agent.bio ?? undefined,
    storages: [...agent.storageUrls],
    issuers: [...(main?.oidcIssuer ?? [])],
  };
}

/**
 * Fetch + render a WebID profile.
 *
 * @param fetchImpl - test-only override. **Omit in production** so the
 *   auth-patched global fetch runs (AGENTS.md §Reading data).
 */
export async function fetchProfile(
  webId: string,
  fetchImpl?: typeof fetch,
): Promise<PodProfile> {
  const { dataset } = await freshRdf(webId, fetchImpl);
  return readProfile(webId, dataset);
}

/**
 * The single storage to browse. Throws {@link NoStorageError} when the profile
 * advertises none. With several, the caller (UI) must let the user pick — this
 * helper deliberately does not choose; it returns them all and the caller picks
 * the active one. Provided for the common single-storage path.
 */
export function requireStorage(profile: PodProfile): string {
  if (profile.storages.length === 0) throw new NoStorageError(profile.webId);
  return profile.storages[0];
}
