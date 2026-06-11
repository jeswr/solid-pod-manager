/**
 * Solid Type Index — read + (bootstrap) write, via typed `@rdfjs/wrapper`
 * subclasses (never inline quads). Closes the AGENTS.md §Writing-data
 * type-index deferral; the wrapper classes are the compile-verified ones from
 * the `solid-type-index` skill.
 *
 * The Type Index is the convention by which a pod owner advertises *where* a
 * given RDF class is stored, so independent apps discover each other's data.
 * CSS does not seed these files — so reads must tolerate their absence and the
 * app bootstraps them when missing (DESIGN.md §9).
 */
import {
  TermWrapper,
  DatasetWrapper,
  OptionalFrom,
  OptionalAs,
  SetFrom,
  NamedNodeAs,
  NamedNodeFrom,
} from "@rdfjs/wrapper";
import { RdfFetchError } from "@jeswr/fetch-rdf";
import { WebIdDataset } from "@solid/object";
import { freshRdf } from "./rdf-read.js";
import { DataFactory } from "n3";

const SOLID = "http://www.w3.org/ns/solid/terms#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

/** One `solid:TypeRegistration` entry in a type-index document. */
export class TypeRegistration extends TermWrapper {
  /** The RDF class this entry indexes (an IRI). */
  get forClass(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SOLID}forClass`, NamedNodeAs.string);
  }
  set forClass(v: string | undefined) {
    OptionalAs.object(this, `${SOLID}forClass`, v, NamedNodeFrom.string);
  }

  /** A single resource holding instances of `forClass`. */
  get instance(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SOLID}instance`, NamedNodeAs.string);
  }
  set instance(v: string | undefined) {
    OptionalAs.object(this, `${SOLID}instance`, v, NamedNodeFrom.string);
  }

  /** A container listing instances of `forClass`. */
  get instanceContainer(): string | undefined {
    return OptionalFrom.subjectPredicate(
      this,
      `${SOLID}instanceContainer`,
      NamedNodeAs.string,
    );
  }
  set instanceContainer(v: string | undefined) {
    OptionalAs.object(this, `${SOLID}instanceContainer`, v, NamedNodeFrom.string);
  }

  /** Stamp the entry as a TypeRegistration (call once when minting). */
  markRegistration(): void {
    this.types.add(`${SOLID}TypeRegistration`);
  }

  /** Live set of `rdf:type` IRIs. */
  get types(): Set<string> {
    return SetFrom.subjectPredicate(
      this,
      `${RDF}type`,
      NamedNodeAs.string,
      NamedNodeFrom.string,
    );
  }
}

/** A located registration: where data for a class lives. */
export interface RegisteredLocation {
  forClass: string;
  /** A single resource (`solid:instance`), if that form was used. */
  instance?: string;
  /** A container to list (`solid:instanceContainer`), if that form was used. */
  container?: string;
}

/** A type-index document, wrapped whole. */
export class TypeIndexDataset extends DatasetWrapper {
  /** Every `solid:TypeRegistration` subject in the document. */
  get registrations(): Iterable<TypeRegistration> {
    return this.instancesOf(`${SOLID}TypeRegistration`, TypeRegistration);
  }

  /** All registered locations across every class. */
  all(): RegisteredLocation[] {
    const out: RegisteredLocation[] = [];
    for (const reg of this.registrations) {
      const forClass = reg.forClass;
      if (!forClass) continue;
      out.push({ forClass, instance: reg.instance, container: reg.instanceContainer });
    }
    return out;
  }

  /** Find the location(s) registered for a class IRI. */
  locate(classIri: string): RegisteredLocation[] {
    return this.all().filter((l) => l.forClass === classIri);
  }
}

/**
 * The two type indexes advertised on a WebID profile. Either may be absent
 * (CSS does not seed them).
 */
export interface TypeIndexLinks {
  publicIndex?: string;
  privateIndex?: string;
}

/** Read both `solid:*TypeIndex` links off the WebID subject of a profile dataset. */
export function typeIndexLinks(
  webId: string,
  profile: import("@rdfjs/types").DatasetCore,
): TypeIndexLinks {
  const subject = new ProfileTypeIndexAnchor(webId, profile, DataFactory);
  return { publicIndex: subject.publicIndex, privateIndex: subject.privateIndex };
}

/**
 * The WebID subject's type-index links, readable AND writable — the write side
 * exists solely so the app can bootstrap a missing index (DESIGN.md §9). This
 * is the narrowest possible profile mutation: one `solid:privateTypeIndex`
 * link; the app never takes blanket write access to profile documents.
 */
export class ProfileTypeIndexAnchor extends TermWrapper {
  get publicIndex(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SOLID}publicTypeIndex`, NamedNodeAs.string);
  }
  get privateIndex(): string | undefined {
    return OptionalFrom.subjectPredicate(
      this,
      `${SOLID}privateTypeIndex`,
      NamedNodeAs.string,
    );
  }
  set privateIndex(v: string | undefined) {
    OptionalAs.object(this, `${SOLID}privateTypeIndex`, v, NamedNodeFrom.string);
  }
}

/** The type-index document's own subject — used when minting a fresh index. */
export class TypeIndexDocument extends TermWrapper {
  /** Live set of `rdf:type` IRIs on the document subject. */
  get types(): Set<string> {
    return SetFrom.subjectPredicate(
      this,
      `${RDF}type`,
      NamedNodeAs.string,
      NamedNodeFrom.string,
    );
  }
  /** Stamp the document as a private (unlisted) type index. */
  markUnlistedIndex(): void {
    this.types.add(`${SOLID}TypeIndex`);
    this.types.add(`${SOLID}UnlistedDocument`);
  }
}

/**
 * Fetch and parse a type-index document into a {@link TypeIndexDataset}.
 *
 * @param indexUrl - the index document URL.
 * @param fetchImpl - test-only fetch override. **Omit in production paths** so
 *   the auth-patched global runs (AGENTS.md §Reading data). A `404`/missing
 *   index resolves to `undefined` (convention, not enforcement); other errors
 *   propagate as `RdfFetchError`.
 */
export async function readTypeIndex(
  indexUrl: string,
  fetchImpl?: typeof fetch,
): Promise<TypeIndexDataset | undefined> {
  try {
    const { dataset } = await freshRdf(indexUrl, fetchImpl);
    return new TypeIndexDataset(dataset, DataFactory);
  } catch (e) {
    if (e instanceof RdfFetchError && (e.status === 404 || e.status === 403)) {
      // Absent or unreadable index — treat as "no registrations here", never
      // as "definitely empty" for write paths (TBL's caveat in the skill).
      return undefined;
    }
    throw e;
  }
}

/**
 * The full discovery result: every registered location found across the public
 * and (when readable) private type indexes.
 */
export interface DiscoveredRegistrations {
  links: TypeIndexLinks;
  /** Whether at least one index document existed and was read. */
  hadIndex: boolean;
  locations: RegisteredLocation[];
}

/**
 * Read a WebID profile's type indexes and return every registered location.
 *
 * The profile dataset must already be fetched (it carries the index links).
 * Reads the public index unauthenticated-friendly and the private index too
 * (it is auth-gated; the patched global handles the 401→login upgrade).
 *
 * @param fetchImpl - test-only override; omit in production.
 */
export async function discoverRegistrations(
  webId: string,
  profile: import("@rdfjs/types").DatasetCore,
  fetchImpl?: typeof fetch,
): Promise<DiscoveredRegistrations> {
  const links = typeIndexLinks(webId, profile);
  const docs = await Promise.all(
    [links.publicIndex, links.privateIndex]
      .filter((u): u is string => Boolean(u))
      .map((u) => readTypeIndex(u, fetchImpl)),
  );
  const present = docs.filter((d): d is TypeIndexDataset => Boolean(d));
  const locations = present.flatMap((d) => d.all());
  return { links, hadIndex: present.length > 0, locations };
}

/** Re-export so callers can fetch a profile without importing fetch-rdf directly. */
export { WebIdDataset };
