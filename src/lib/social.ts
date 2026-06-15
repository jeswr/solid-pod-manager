// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Social depth — the `foaf:knows` friend list on the WebID profile, and
 * address-book **groups** (`vcard:Group`) stored alongside contacts.
 *
 * Two distinct data homes, both written with the read-modify-write discipline
 * (preserve unrelated triples, conditional PUT) and typed `@rdfjs/wrapper`
 * accessors (never hand-build quads):
 *
 *   - **Friends** (`foaf:knows <webid>`) live on the profile *card* — the
 *     public social graph other agents read. Add/remove mutate only the
 *     `foaf:knows` set on the WebID subject; nothing else on the card is
 *     touched.
 *   - **Groups** (`vcard:Group` with `vcard:hasMember <webid>` and
 *     `vcard:fn` label) live as one resource per group under the contacts
 *     container, mirroring the per-item model the productivity store uses.
 */
import {
  LiteralAs,
  LiteralFrom,
  NamedNodeAs,
  NamedNodeFrom,
  OptionalAs,
  OptionalFrom,
  SetFrom,
  TermWrapper,
} from "@rdfjs/wrapper";
import { DataFactory, Store } from "n3";
import { freshRdf } from "./rdf-read.js";
import { writeResource } from "./pod-data.js";
import { profileDocUrl, PROFILE_PREFIXES } from "./profile-edit.js";
import { createStore, type ProductivityStore, type StoreConfig } from "./productivity-store.js";

const FOAF = "http://xmlns.com/foaf/0.1/";
const VCARD = "http://www.w3.org/2006/vcard/ns#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** The RDF class an address-book group is stamped + registered with. */
export const GROUP_CLASS = `${VCARD}Group`;

const GROUP_PREFIXES = { vcard: VCARD } as const;

// ---------------------------------------------------------------------------
// Friends — `foaf:knows` on the profile card
// ---------------------------------------------------------------------------

/** Typed view of the `foaf:knows` set on the WebID subject. */
export class KnowsCard extends TermWrapper {
  /** Live set of WebID IRIs this agent `foaf:knows`. */
  get knows(): Set<string> {
    return SetFrom.subjectPredicate(this, `${FOAF}knows`, NamedNodeAs.string, NamedNodeFrom.string);
  }
}

/** Read the `foaf:knows` WebIDs off an already-parsed profile dataset (pure). */
export function readKnows(
  webId: string,
  dataset: import("@rdfjs/types").DatasetCore,
): string[] {
  return [...new KnowsCard(webId, dataset, DataFactory).knows].sort();
}

/**
 * Add a WebID to the user's `foaf:knows` (read-modify-write, idempotent).
 * No-op if already known. Returns the resulting friend list.
 *
 * @param fetchImpl - test-only override; omit in production.
 */
export async function addFriend(opts: {
  webId: string;
  friend: string;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  return mutateKnows(opts.webId, opts.fetchImpl, (set) => set.add(opts.friend));
}

/**
 * Remove a WebID from the user's `foaf:knows` (read-modify-write, idempotent).
 * Returns the resulting friend list.
 */
export async function removeFriend(opts: {
  webId: string;
  friend: string;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  return mutateKnows(opts.webId, opts.fetchImpl, (set) => set.delete(opts.friend));
}

async function mutateKnows(
  webId: string,
  fetchImpl: typeof fetch | undefined,
  mutate: (set: Set<string>) => void,
): Promise<string[]> {
  const docUrl = profileDocUrl(webId);
  const { dataset, etag } = await freshRdf(docUrl, fetchImpl);
  const card = new KnowsCard(webId, dataset, DataFactory);
  mutate(card.knows);
  await writeResource(docUrl, dataset, { etag, fetchImpl, prefixes: PROFILE_PREFIXES });
  return [...card.knows].sort();
}

// ---------------------------------------------------------------------------
// Groups — `vcard:Group` resources under the contacts container
// ---------------------------------------------------------------------------

/** A group as the UI works with it (plain, serialisable). */
export interface Group {
  /** Group label — `vcard:fn`. */
  name: string;
  /** Member WebIDs/contact IRIs — `vcard:hasMember`. */
  members: string[];
}

/** Typed view of a single group's subject. */
export class GroupDoc extends TermWrapper {
  get types(): Set<string> {
    return SetFrom.subjectPredicate(this, RDF_TYPE, NamedNodeAs.string, NamedNodeFrom.string);
  }
  mark(): this {
    this.types.add(GROUP_CLASS);
    return this;
  }
  get name(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${VCARD}fn`, LiteralAs.string);
  }
  set name(v: string | undefined) {
    OptionalAs.object(this, `${VCARD}fn`, v, LiteralFrom.string);
  }
  /** Live set of member IRIs (`vcard:hasMember`). */
  get members(): Set<string> {
    return SetFrom.subjectPredicate(
      this,
      `${VCARD}hasMember`,
      NamedNodeAs.string,
      NamedNodeFrom.string,
    );
  }
}

/** Parse a group document into a {@link Group}, or `undefined` if not one. */
export function parseGroup(
  itemUrl: string,
  dataset: import("@rdfjs/types").DatasetCore,
): Group | undefined {
  const doc = new GroupDoc(`${itemUrl}#it`, dataset, DataFactory);
  if (!doc.types.has(GROUP_CLASS)) return undefined;
  return { name: doc.name ?? "", members: [...doc.members].sort() };
}

/** Serialise a {@link Group} into a fresh dataset rooted at `${itemUrl}#it`. */
export function buildGroup(itemUrl: string, group: Group): Store {
  const store = new Store();
  const doc = new GroupDoc(`${itemUrl}#it`, store, DataFactory).mark();
  doc.name = group.name.trim() || undefined;
  for (const m of group.members) doc.members.add(m);
  return store;
}

/** Container slug groups live under (shares the contacts address-book space). */
export const GROUPS_SLUG = "contacts/groups/";

/** The store config — wires the typed parse/build into the shared CRUD. */
export const GROUPS_CONFIG: StoreConfig<Group> = {
  containerSlug: GROUPS_SLUG,
  forClass: GROUP_CLASS,
  prefixes: GROUP_PREFIXES,
  parse: parseGroup,
  build: buildGroup,
};

/** Build a Groups store bound to the active pod + WebID. */
export function groupsStore(opts: {
  podRoot: string;
  webId: string;
  fetchImpl?: typeof fetch;
}): ProductivityStore<Group> {
  return createStore(GROUPS_CONFIG, opts);
}

export { GROUP_PREFIXES };
