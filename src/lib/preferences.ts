// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * The Preferences Document — the owner-private `pim:space#preferencesFile` the
 * type-index spec says the **private** type index should be linked from (NOT
 * the world-readable WebID card).
 *
 * THE PRIVACY FIX (task #87, G1/P0): the public WebID card is, by design,
 * world-readable — anyone can fetch it to discover where to talk to you. Writing
 * `solid:privateTypeIndex` onto that card therefore LEAKS the existence + URL of
 * the user's private data index to the whole web (the index *contents* stay
 * WAC-protected, but the disclosure itself is spec-noncompliant). The
 * type-index spec (https://solid.github.io/type-indexes/) links
 * `solid:privateTypeIndex` from the **Preferences Document**, which is
 * owner-private. This module discovers (or creates + WAC-locks) that document
 * and is the single home for the private-index link.
 *
 * House rules honoured here:
 *   - typed `@rdfjs/wrapper` / `@solid/object` accessors only — never inline /
 *     hand-built triples (the `solid-rdf` / `solid-wac` house rule);
 *   - reads revalidate (`freshRdf`) and writes are conditional (`If-Match` /
 *     `If-None-Match`) preserving every foreign triple;
 *   - the WebID card stays world-readable; only the prefs file is locked down.
 */
import {
  NamedNodeAs,
  NamedNodeFrom,
  OptionalAs,
  OptionalFrom,
  SetFrom,
  TermWrapper,
} from "@rdfjs/wrapper";
import { AclResource, Authorization } from "@solid/object";
import { DataFactory, Store, Writer } from "n3";
import type { DatasetCore } from "@rdfjs/types";
import { RdfFetchError } from "@jeswr/fetch-rdf";
import { freshRdf } from "./rdf-read.js";
import { writeResource } from "./pod-data.js";
import { aclUrlFromLinkHeader } from "./permissions.js";
import {
  AclDiscoveryError,
  AclReadError,
  AclWriteError,
  AcpUnsupportedError,
  ResourceWriteError,
} from "./errors.js";

const SPACE = "http://www.w3.org/ns/pim/space#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const ACL = "http://www.w3.org/ns/auth/acl#";
const ACP = "http://www.w3.org/ns/solid/acp#";

/** Turtle prefixes for a readable preferences document. */
const PREFERENCES_PREFIXES = { space: SPACE } as const;
/** Turtle prefixes for a readable ACL document. */
const ACL_PREFIXES = { acl: ACL, foaf: "http://xmlns.com/foaf/0.1/" } as const;

/**
 * The WebID subject's link to its preferences file, readable AND writable. The
 * write side exists solely so the app can create-and-link a missing prefs file
 * (the type-index spec's create-and-link fallback). The narrowest possible
 * profile mutation — one `space:preferencesFile` link; the app never takes
 * blanket write access to the card.
 */
export class ProfilePreferencesAnchor extends TermWrapper {
  get preferencesFile(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SPACE}preferencesFile`, NamedNodeAs.string);
  }
  set preferencesFile(v: string | undefined) {
    OptionalAs.object(this, `${SPACE}preferencesFile`, v, NamedNodeFrom.string);
  }
}

/**
 * The preferences document's own subject — a `space:ConfigurationFile`. Used to
 * stamp a freshly-minted prefs file so it self-describes.
 */
export class PreferencesDoc extends TermWrapper {
  /** Live set of `rdf:type` IRIs on the document subject. */
  get types(): Set<string> {
    return SetFrom.subjectPredicate(this, `${RDF}type`, NamedNodeAs.string, NamedNodeFrom.string);
  }
  /** Stamp the document as a configuration (preferences) file. */
  markConfiguration(): void {
    this.types.add(`${SPACE}ConfigurationFile`);
  }
}

/** The profile *document* URL a WebID lives in (fragment stripped). */
function documentUrl(webId: string): string {
  const u = new URL(webId);
  u.hash = "";
  return u.toString();
}

/** Read the `space:preferencesFile` link off a profile dataset (or undefined). */
export function preferencesFileLink(
  webId: string,
  profile: DatasetCore,
): string | undefined {
  return new ProfilePreferencesAnchor(webId, profile, DataFactory).preferencesFile;
}

export interface EnsurePreferencesResult {
  /** The preferences document URL (existing or freshly created). */
  preferencesFile: string;
  /** True when a fresh prefs file was created (and linked + WAC-locked) here. */
  created: boolean;
}

/**
 * Ensure the user has a preferences file, returning its URL.
 *
 * - If the card already links one (`space:preferencesFile`), reuse it (`created:
 *   false`) — never clobber an existing one we merely failed to read.
 * - Otherwise create `<podRoot>settings/preferences.ttl`, lock it owner-only via
 *   WAC, and link it from the card (conditional, foreign triples preserved).
 *
 * Accepts an already-fetched profile dataset + its ETag so a caller doing a
 * larger read-modify-write of the card (e.g. the type-index migration) does not
 * pay a second profile fetch and writes the card exactly once.
 *
 * @param fetchImpl - test-only override; **omit in production** so the
 *   auth-patched global fetch runs (AGENTS.md §Reading data).
 */
export async function ensurePreferencesFile(opts: {
  webId: string;
  podRoot: string;
  /** An already-fetched profile dataset (revalidated) — mutated + written when
   *  a fresh prefs file is linked. */
  profile: DatasetCore;
  /** The profile document's ETag, for the conditional card write. */
  profileEtag: string | null;
  fetchImpl?: typeof fetch;
}): Promise<EnsurePreferencesResult> {
  const { webId, podRoot, profile, profileEtag, fetchImpl } = opts;

  const existing = preferencesFileLink(webId, profile);
  if (existing) return { preferencesFile: existing, created: false };

  const preferencesFile = new URL("settings/preferences.ttl", podRoot).toString();

  // Mint the (typed) prefs document — create-only so a prefs file made
  // out-of-band but never linked is reused, not clobbered.
  const doc = new Store();
  new PreferencesDoc(preferencesFile, doc, DataFactory).markConfiguration();
  try {
    await writeResource(preferencesFile, doc, {
      createOnly: true,
      fetchImpl,
      prefixes: PREFERENCES_PREFIXES,
    });
  } catch (e) {
    // 412 under If-None-Match:* = it already exists (created out-of-band) — fine,
    // adopt it. Any other write failure propagates.
    if (!(e instanceof ResourceWriteError && e.status === 412)) throw e;
  }

  // Lock it owner-only BEFORE linking it from the card, so the private-index
  // link never points at a document that is briefly world-readable.
  await lockOwnerOnly(preferencesFile, webId, fetchImpl);

  // Link it from the card (read-modify-write, ETag-guarded, foreign triples
  // preserved — the anchor only adds one triple).
  const anchor = new ProfilePreferencesAnchor(webId, profile, DataFactory);
  anchor.preferencesFile = preferencesFile;
  await writeResource(documentUrl(webId), profile, { etag: profileEtag, fetchImpl });

  return { preferencesFile, created: true };
}

/** True for a clearly-ACP control document (`.acr`), which we don't write. */
function isAcpControlUrl(aclUrl: string): boolean {
  try {
    return new URL(aclUrl).pathname.endsWith(".acr");
  } catch {
    return aclUrl.endsWith(".acr");
  }
}

/** True when a dataset carries ACP-namespace triples (an ACP document). */
function datasetUsesAcp(dataset: DatasetCore): boolean {
  for (const q of dataset) {
    if (q.predicate.value.startsWith(ACP)) return true;
    if (q.object.termType === "NamedNode" && q.object.value.startsWith(ACP)) return true;
  }
  return false;
}

/**
 * Discover a resource's WAC ACL slot from its `Link: rel="acl"` header (never
 * guessed). Fails closed on an ACP (`.acr`) slot — this app only writes WAC, and
 * silently writing WAC triples into an ACP control resource (or, worse, leaving
 * a prefs file unprotected) would re-open the leak this change closes.
 *
 * @throws AclDiscoveryError when the slot can't be located,
 *   AcpUnsupportedError when the pod is ACP-backed (roborev Medium — ACP).
 */
async function discoverWacAclUrl(
  resourceUrl: string,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const call = fetchImpl ?? fetch;
  // GET (not HEAD) so the auth-patched fetch replays a 401→DPoP upgrade; only the
  // Link header matters.
  let res: Response;
  try {
    res = await call(resourceUrl, { method: "GET" });
  } catch (cause) {
    throw new AclDiscoveryError(resourceUrl, { cause });
  }
  await res.body?.cancel().catch(() => undefined);
  if (!res.ok) throw new AclDiscoveryError(resourceUrl);
  const aclUrl = aclUrlFromLinkHeader(res.headers.get("link"), resourceUrl);
  if (!aclUrl) throw new AclDiscoveryError(resourceUrl);
  if (isAcpControlUrl(aclUrl)) throw new AcpUnsupportedError(resourceUrl);
  return aclUrl;
}

/** Build the owner-only WAC ACL dataset for a resource (typed wrapper only). */
function ownerOnlyAcl(
  aclUrl: string,
  resourceUrl: string,
  ownerWebId: string,
): DatasetCore {
  const dataset: DatasetCore = new Store();
  const auth = new Authorization(`${aclUrl}#owner`, dataset, DataFactory);
  auth.type.add(`${ACL}Authorization`);
  auth.accessTo = resourceUrl;
  auth.agent.add(ownerWebId);
  auth.canRead = true;
  auth.canWrite = true;
  auth.canReadWriteAcl = true; // Control — the owner manages the ACL itself.
  // No public / authenticated / group / origin subject is ever added.
  // Defence-in-depth: assert the result grants no broad subject before use.
  assertOwnerOnly(dataset, resourceUrl, ownerWebId);
  return dataset;
}

/** PUT an ACL dataset, mapping failures to a fail-closed AclWriteError. */
async function putAcl(
  aclUrl: string,
  dataset: DatasetCore,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const call = fetchImpl ?? fetch;
  let put: Response;
  try {
    put = await call(aclUrl, {
      method: "PUT",
      headers: { "content-type": "text/turtle" },
      body: await toTurtle(dataset),
    });
  } catch (cause) {
    throw new AclWriteError(aclUrl, undefined, { cause });
  }
  if (!put.ok) throw new AclWriteError(aclUrl, `PUT ${aclUrl} -> ${put.status}`);
}

/**
 * Write an owner-only WAC ACL for a resource: a single `acl:Authorization`
 * granting the owner Read/Write/Control and NO ONE else. Built through the
 * typed `@solid/object` `Authorization` wrapper — never hand-built triples
 * (the `solid-wac` house rule). Unconditional — overwrites whatever is there.
 *
 * @throws AclDiscoveryError when the ACL slot can't be located,
 *   AcpUnsupportedError on an ACP pod, AclWriteError on a write rejection
 *   (fail-closed — a prefs file with no/loose ACL is a leak).
 */
export async function lockOwnerOnly(
  resourceUrl: string,
  ownerWebId: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const aclUrl = await discoverWacAclUrl(resourceUrl, fetchImpl);
  await putAcl(aclUrl, ownerOnlyAcl(aclUrl, resourceUrl, ownerWebId), fetchImpl);
}

/**
 * Ensure a resource's ACL is owner-only, locking it if it is not (idempotent).
 *
 * Reads the existing ACL: if it is ALREADY owner-only (only the owner agent, no
 * public/authenticated/group/origin/other-agent on this resource) it is left
 * untouched (no write). Otherwise — missing, loose, or shared — it is
 * (re-)written owner-only, fail-closed. This is what makes reusing an EXISTING
 * linked preferences file safe before writing the private-index link into it
 * (roborev High): a public/shared prefs document is locked down first.
 *
 * @throws AcpUnsupportedError on an ACP pod (fail-closed — we don't speak ACP),
 *   AclWriteError on a write rejection.
 */
export async function ensureOwnerOnly(
  resourceUrl: string,
  ownerWebId: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const aclUrl = await discoverWacAclUrl(resourceUrl, fetchImpl);

  // Read the existing ACL. A 404 means there is no own ACL — it must be created
  // owner-only (an unprotected resource may be world-readable via an ancestor
  // default, so never leave it without an explicit own ACL).
  let existing: { dataset: DatasetCore } | undefined;
  try {
    const { dataset } = await freshRdf(aclUrl, fetchImpl);
    existing = { dataset };
  } catch (e) {
    if (e instanceof RdfFetchError && e.status === 404) existing = undefined;
    else throw new AclReadError(aclUrl, { cause: e });
  }

  if (existing) {
    // A hybrid server could serve an ACP document at a `.acl`-named slot — refuse
    // to treat it as WAC (fail-closed).
    if (datasetUsesAcp(existing.dataset)) throw new AcpUnsupportedError(resourceUrl);
    if (isAlreadyOwnerOnly(existing.dataset, resourceUrl, ownerWebId)) return; // no write
  }

  await putAcl(aclUrl, ownerOnlyAcl(aclUrl, resourceUrl, ownerWebId), fetchImpl);
}

/**
 * True when `dataset`'s authorizations governing `resourceUrl` grant access to
 * NO ONE but the owner agent (no public/authenticated/group/origin/other-agent),
 * AND the owner actually holds an authorization. Conservative: any
 * non-owner-only or owner-absent shape returns false (→ re-lock).
 */
function isAlreadyOwnerOnly(
  dataset: DatasetCore,
  resourceUrl: string,
  ownerWebId: string,
): boolean {
  const acl = new AclResource(dataset, DataFactory);
  let ownerHasRule = false;
  for (const auth of acl.authorizations) {
    if (!authTargetsResource(auth, resourceUrl)) continue;
    if (auth.accessibleToAny || auth.accessibleToAuthenticated) return false;
    if (auth.agentClass.size > 0 || auth.origin.size > 0 || auth.agentGroup !== undefined) {
      return false;
    }
    for (const agent of auth.agent) {
      if (agent !== ownerWebId) return false;
      ownerHasRule = true;
    }
  }
  return ownerHasRule;
}

/**
 * Fail-closed assertion that an ACL dataset grants access on `resourceUrl` to
 * NO subject other than the owner agent — no public, authenticated, group,
 * origin, or other agent. Throws {@link AclWriteError} otherwise.
 */
function assertOwnerOnly(
  dataset: DatasetCore,
  resourceUrl: string,
  ownerWebId: string,
): void {
  const acl = new AclResource(dataset, DataFactory);
  for (const auth of acl.authorizations) {
    // Only authorizations that actually govern THIS resource matter.
    if (!authTargetsResource(auth, resourceUrl)) continue;
    if (auth.accessibleToAny || auth.accessibleToAuthenticated) {
      throw new AclWriteError(resourceUrl, "Refusing to write a non-owner-only preferences ACL.");
    }
    if (auth.agentClass.size > 0 || auth.origin.size > 0 || auth.agentGroup !== undefined) {
      throw new AclWriteError(resourceUrl, "Refusing to write a non-owner-only preferences ACL.");
    }
    for (const agent of auth.agent) {
      if (agent !== ownerWebId) {
        throw new AclWriteError(resourceUrl, "Refusing to grant a non-owner access to preferences.");
      }
    }
  }
}

/** True when an authorization names `resourceUrl` on accessTo or default. */
function authTargetsResource(auth: Authorization, resourceUrl: string): boolean {
  const subject = DataFactory.namedNode(auth.value);
  for (const pred of [`${ACL}accessTo`, `${ACL}default`]) {
    for (const q of auth.dataset.match(subject, DataFactory.namedNode(pred))) {
      if (q.object.termType === "NamedNode" && q.object.value === resourceUrl) return true;
    }
  }
  return false;
}

/** Serialise an in-memory ACL dataset to Turtle (promisified n3 Writer). */
function toTurtle(dataset: DatasetCore): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const writer = new Writer({ format: "text/turtle", prefixes: ACL_PREFIXES });
    for (const quad of dataset) writer.addQuad(quad);
    writer.end((err, result) => (err ? reject(err) : resolve(result)));
  });
}

/**
 * Read a preferences document, tolerating absence/unreadability the way the
 * type-index reader does: a `404`/`403` resolves to `undefined` (the file may
 * exist but be unreadable in this context — never treated as "definitely
 * empty"). Other errors propagate.
 *
 * @param fetchImpl - test-only override; omit in production.
 */
export async function readPreferences(
  preferencesFile: string,
  fetchImpl?: typeof fetch,
): Promise<{ dataset: DatasetCore; etag: string | null } | undefined> {
  try {
    return await freshRdf(preferencesFile, fetchImpl);
  } catch (e) {
    if (e instanceof RdfFetchError && (e.status === 404 || e.status === 403)) return undefined;
    throw e;
  }
}

export { RdfFetchError };
