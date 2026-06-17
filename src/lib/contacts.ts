// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Contacts — a SolidOS-interoperable `vcard:AddressBook`.
 *
 * **Why this shape (task #102/#105 / G6 Builder B).** SolidOS's contacts pane —
 * and every other vCard-aware Solid app — reads a SPECIFIC address-book layout:
 * a book root (`contacts/index.ttl#this a vcard:AddressBook`) that links a
 * people index (`vcard:nameEmailIndex`) and a groups index (`vcard:groupIndex`),
 * individuals at `Person/<uuid>/index.ttl#this` (typed `vcard:Individual`, with a
 * `vcard:inAddressBook` back-link and STRUCTURED `vcard:hasEmail [ a vcard:Home;
 * vcard:value <mailto:..> ]` nodes), and groups at `Group/<slug>.ttl#this`.
 * SolidOS browses people BY GROUP, so each contact is also added to a default
 * `Group/Contacts.ttl`. The previous PM layout was a flat `contacts/<slug>.ttl`
 * with a single direct-IRI `vcard:hasEmail` — readable by us, but invisible to
 * SolidOS. This module migrates to the canonical form, forward + non-destructive.
 *
 * **All contact RDF goes through `@jeswr/solid-task-model/contacts`** (the
 * shared, client-safe federated model — `buildPerson`/`parsePerson`,
 * `buildAddressBook`/`parseAddressBook`, `buildGroup`/`parseGroup`, the index
 * builders, the subject helpers). Imported ONLY from the `/contacts` subexport —
 * NEVER the barrel (it pulls `node:fs` via the shape module and breaks the Next
 * static export). The only quads PM mints by hand are the index-listing EDGES in
 * `people.ttl` / `Group/Contacts.ttl` (`vcard:inAddressBook` / `vcard:fn` /
 * `vcard:hasMember`) — never a contact document's content, which is always
 * model-built.
 *
 * **Stable public API.** `contactsStore(opts)` still returns the same surface
 * the app consumes (`list`/`read`/`create`/`update`/`remove`/`newItemUrl`/
 * `container`), and `Contact` keeps its plain `{ fn, email, phone, note, webId }`
 * shape (single email/phone — the common personal-address-book case — bridged to
 * the model's array form). So `use-people`, `use-federation-tasks`, `pod-search`,
 * the vCard import/export, the WebID-index search, prefetch and the pages need no
 * change beyond what they already import.
 */
import type { DatasetCore, NamedNode } from "@rdfjs/types";
import { DataFactory } from "n3";
import { RdfFetchError } from "@jeswr/fetch-rdf";
import {
  type AddressBookData,
  type ContactData,
  addressBookSubject,
  buildAddressBook,
  buildGroup,
  buildGroupsIndex,
  buildPeopleIndex,
  buildPerson,
  groupSubject,
  parsePerson,
  personSubject,
} from "@jeswr/solid-task-model/contacts";
import { ItemReadError, ResourceWriteError } from "./errors.js";
import { deleteResource, listContainer, readResource, writeResource } from "./pod-data.js";
import { freshRdf } from "./rdf-read.js";
import type { ItemStore, StoredItem } from "./productivity-store.js";
import { ensureTypeRegistrations } from "./type-index-write.js";

const VCARD = "http://www.w3.org/2006/vcard/ns#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** The RDF class a single contact is stamped + (container-)registered with. */
export const CONTACT_CLASS = `${VCARD}Individual`;
/** The RDF class the address-book ROOT is stamped + (instance-)registered with. */
export const ADDRESS_BOOK_CLASS = `${VCARD}AddressBook`;

/** Container slug under the pod root. */
export const CONTACTS_SLUG = "contacts/";

/** Address-book root document (relative to the contacts container). */
const INDEX_DOC = "index.ttl";
/** People index document (`vcard:nameEmailIndex` target). */
const PEOPLE_DOC = "people.ttl";
/** Groups index document (`vcard:groupIndex` target). */
const GROUPS_DOC = "groups.ttl";
/** The default group every contact joins so SolidOS (which browses BY GROUP) sees them. */
const DEFAULT_GROUP_DOC = "Group/Contacts.ttl";
const DEFAULT_GROUP_NAME = "Contacts";

/** Turtle prefixes for readable documents. */
const PREFIXES = {
  vcard: VCARD,
  dc: "http://purl.org/dc/elements/1.1/",
  dct: "http://purl.org/dc/terms/",
  acl: "http://www.w3.org/ns/auth/acl#",
} as const;

/** A contact as the UI works with it (plain, serialisable). */
export interface Contact {
  /** Full name — `vcard:fn`. */
  fn: string;
  /** Email address (bare, no `mailto:`) — first `vcard:hasEmail`. */
  email?: string;
  /** Phone number (bare, no `tel:`) — first `vcard:hasTelephone`. */
  phone?: string;
  /** Free-text note — `vcard:note`. */
  note?: string;
  /**
   * The contact's WebID, if known — `vcard:url` (a `vcard:WebId` value node).
   * Lets a contact be selected in the people-picker and feed sharing/group
   * membership. Bare IRI, no scheme stripping.
   */
  webId?: string;
}

/** Strip a `mailto:`/`tel:` scheme for display; `undefined` passes through. */
export function stripScheme(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const m = /^(?:mailto|tel):(.*)$/i.exec(uri);
  if (!m) return uri;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    // Malformed percent-encoding must not throw — that would make the whole
    // contact fail to parse. Fall back to the raw scheme-stripped value.
    return m[1];
  }
}

/** Wrap a bare email in a `mailto:` IRI; `undefined`/empty passes through. */
export function toMailto(email: string | undefined): string | undefined {
  const v = email?.trim();
  return v ? `mailto:${v}` : undefined;
}

/**
 * Wrap a bare phone in a `tel:` IRI. Spaces are removed (RFC 3966 disallows
 * them in the URI), but the leading `+` and digits are preserved.
 */
export function toTel(phone: string | undefined): string | undefined {
  const v = phone?.trim();
  if (!v) return undefined;
  return `tel:${v.replace(/[^\d+]/g, "")}`;
}

/** Bridge the UI {@link Contact} to the model's {@link ContactData} (arrays + IRIs). */
function toContactData(contact: Contact, inAddressBook: string): ContactData {
  const mailto = toMailto(contact.email);
  const tel = toTel(contact.phone);
  return {
    name: contact.fn,
    inAddressBook,
    emails: mailto ? [mailto] : [],
    phones: tel ? [tel] : [],
    webId: contact.webId?.trim() || undefined,
    note: contact.note || undefined,
  };
}

/** Bridge the model's {@link ContactData} back to the UI {@link Contact}. */
function fromContactData(data: ContactData): Contact {
  return {
    fn: data.name || "",
    email: stripScheme(data.emails?.[0]),
    phone: stripScheme(data.phones?.[0]),
    note: data.note,
    webId: data.webId,
  };
}

/**
 * Parse a single contact document into a {@link Contact}, or `undefined` if the
 * document holds no `vcard:Individual` at its `#this`/`#it` subject.
 *
 * Reads BOTH the canonical address-book person (subject `…/index.ttl#this`, via
 * the model's `parsePerson` — accepts structured AND direct-IRI emails) and a
 * LEGACY flat contact (subject `…/<slug>.ttl#it`), so a migration-in-progress
 * pod never drops a contact.
 */
export function parseContact(itemUrl: string, dataset: DatasetCore): Contact | undefined {
  const canonical = parsePerson(itemUrl, dataset);
  if (canonical) return fromContactData(canonical);
  return parseLegacyContact(itemUrl, dataset);
}

/** The legacy flat-contact subject this app used to write (`<doc>#it`). */
function legacySubject(itemUrl: string): string {
  return `${itemUrl}#it`;
}

/**
 * Parse a LEGACY flat contact (`<doc>#it a vcard:Individual` with a direct-IRI
 * `vcard:hasEmail <mailto:..>`). Kept so reads never drop a not-yet-migrated
 * contact; values are scheme-guarded exactly as the model guards its parsed
 * output (a `javascript:`/`data:` IRI is dropped, never handed to the UI).
 */
function parseLegacyContact(itemUrl: string, dataset: DatasetCore): Contact | undefined {
  const subject = legacySubject(itemUrl);
  let isIndividual = false;
  let fn: string | undefined;
  let emailUri: string | undefined;
  let phoneUri: string | undefined;
  let note: string | undefined;
  let webId: string | undefined;
  for (const q of dataset.match(null, null, null, null)) {
    if (q.subject.value !== subject) continue;
    const p = q.predicate.value;
    if (p === `${VCARD}fn` && q.object.termType === "Literal") fn = q.object.value;
    else if (p === `${VCARD}hasEmail` && q.object.termType === "NamedNode") emailUri = q.object.value;
    else if (p === `${VCARD}hasTelephone` && q.object.termType === "NamedNode") phoneUri = q.object.value;
    else if (p === `${VCARD}note` && q.object.termType === "Literal") note = q.object.value;
    else if (p === `${VCARD}url` && q.object.termType === "NamedNode") webId = q.object.value;
    else if (p === RDF_TYPE && q.object.value === CONTACT_CLASS) isIndividual = true;
  }
  if (!isIndividual) return undefined;
  return {
    fn: fn ?? "",
    email: /^mailto:/i.test(emailUri ?? "") ? stripScheme(emailUri) : undefined,
    phone: /^tel:/i.test(phoneUri ?? "") ? stripScheme(phoneUri) : undefined,
    note,
    webId: /^https?:\/\//i.test(webId ?? "") ? webId : undefined,
  };
}

/**
 * Build a contact document dataset for `itemUrl`, in the CANONICAL form (subject
 * `<itemUrl>#this`). A round-trip helper kept for parity with the prior module +
 * tests; the store uses {@link AddressBookContactsStore} which threads the book
 * back-link. No book context here, so the back-link points at the doc's own book.
 */
export function buildContact(itemUrl: string, contact: Contact): ReturnType<typeof buildPerson> {
  return buildPerson(itemUrl, toContactData(contact, addressBookSubject(itemUrl)));
}

/**
 * A contacts store bound to a pod + WebID, backing the SolidOS address-book
 * layout but exposing the SAME surface the rest of the app consumes.
 */
export class AddressBookContactsStore implements ItemStore<Contact> {
  /** The contacts container (always ends in `/`). */
  readonly container: string;
  /** The address-book root document URL (`contacts/index.ttl`). */
  private readonly bookDoc: string;
  /** The address-book root SUBJECT (`contacts/index.ttl#this`). */
  private readonly bookSubject: string;
  private readonly peopleDoc: string;
  private readonly groupsDoc: string;
  private readonly defaultGroupDoc: string;

  constructor(
    private readonly podRoot: string,
    private readonly webId: string,
    private readonly fetchImpl?: typeof fetch,
  ) {
    this.container = new URL(CONTACTS_SLUG, podRoot).toString();
    this.bookDoc = new URL(INDEX_DOC, this.container).toString();
    this.bookSubject = addressBookSubject(this.bookDoc);
    this.peopleDoc = new URL(PEOPLE_DOC, this.container).toString();
    this.groupsDoc = new URL(GROUPS_DOC, this.container).toString();
    this.defaultGroupDoc = new URL(DEFAULT_GROUP_DOC, this.container).toString();
  }

  /**
   * Mint a fresh person document URL (`Person/<uuid>/index.ttl`). A v4 UUID via
   * the Web Crypto global (client-safe) guarantees uniqueness without a
   * round-trip; the `#this` subject is appended by the model on build/parse. The
   * canonical layout keys people by UUID, not a name slug, so (unlike the
   * generic productivity store) there is no `slugHint`.
   */
  newItemUrl(): string {
    const uuid = crypto.randomUUID();
    return new URL(`Person/${uuid}/index.ttl`, this.container).toString();
  }

  /**
   * Fail closed unless `url` is a contact-document resource strictly inside this
   * book. Guards every caller-supplied URL (a `?id=` link) before any
   * authenticated I/O so a crafted link can't redirect a read/write/delete
   * elsewhere (confused-deputy).
   */
  private assertInScope(url: string): void {
    if (!isContactsResource(url, this.container)) {
      throw new ContactsScopeError(url, this.container);
    }
  }

  /**
   * List every contact in the book. Reads the canonical people index (each
   * `?p vcard:inAddressBook <book>`) AND unions in any LEGACY flat
   * `contacts/<slug>.ttl` still present (deduped), so a migration-in-progress
   * pod shows the full set. A missing book/container just means "nothing yet".
   */
  async list(): Promise<StoredItem<Contact>[]> {
    // Each lister already narrows "absent" to 404/403 → []; any OTHER failure
    // (parse error, 5xx, auth) PROPAGATES rather than masquerading as "no
    // contacts" (roborev Medium). The two run concurrently.
    const [canonical, legacy] = await Promise.all([this.listCanonical(), this.listLegacy()]);
    // Canonical contacts are returned in FULL — two distinct people that happen to
    // share an email/WebID/name are NEVER collapsed (roborev Medium). The ONLY
    // dedupe is CROSS-SOURCE: a LEGACY file whose contact identity already exists
    // among the canonical set is a not-yet-deleted migration remnant (a 412
    // aborted the legacy delete), so it is dropped in favour of the canonical
    // copy. A legacy file with no canonical twin still shows (URL-deduped).
    const byUrl = new Map<string, StoredItem<Contact>>();
    for (const item of canonical) byUrl.set(item.url, item);
    // Compute each canonical contact's STRICT migration-identity key set (see
    // migrationKeys). A legacy file is a migration remnant ONLY when it shares a
    // strong key with ONE SAME canonical contact — keys are matched per-canonical,
    // never pooled (a global set could "match" a legacy whose WebID came from
    // canonical A and whose tuple came from canonical B — roborev Medium). Email
    // or phone ALONE is never a twin signal (distinct people can share a household
    // address — round-3), so such a legacy contact still shows.
    const canonicalKeySets = canonical.map((c) => new Set(migrationKeys(c.data)));
    for (const item of legacy) {
      if (byUrl.has(item.url)) continue; // same doc surfaced by both paths
      const keys = migrationKeys(item.data);
      const isTwin =
        keys.length > 0 && canonicalKeySets.some((set) => keys.some((k) => set.has(k)));
      if (isTwin) continue; // migration remnant — the canonical copy wins
      byUrl.set(item.url, item);
    }
    return [...byUrl.values()];
  }

  /** Read the canonical people index, then GET each person document. */
  private async listCanonical(): Promise<StoredItem<Contact>[]> {
    let peopleDs: DatasetCore;
    try {
      ({ dataset: peopleDs } = await freshRdf(this.peopleDoc, this.fetchImpl));
    } catch (e) {
      if (e instanceof RdfFetchError && (e.status === 404 || e.status === 403)) return [];
      throw e;
    }
    const personDocs = this.peopleFromIndex(peopleDs);
    const items = await Promise.all(
      personDocs.map(async (docUrl) => {
        try {
          return await this.read(docUrl);
        } catch (e) {
          // A STALE index entry whose person doc is gone (404) or unreadable
          // (403) is expected — a deleted contact whose index prune failed
          // self-heals here. ANY OTHER failure (500/parse/auth) must NOT be
          // masked as "skip this contact" (roborev Medium) — re-throw it so the
          // list surfaces the real error rather than silently dropping people.
          if (e instanceof ItemReadError && (e.status === 404 || e.status === 403)) {
            return undefined;
          }
          throw e;
        }
      }),
    );
    return items.filter((i): i is StoredItem<Contact> => i !== undefined);
  }

  /** The person DOCUMENT urls referenced by the people index (`#this` stripped). */
  private peopleFromIndex(peopleDs: DatasetCore): string[] {
    const docs = new Set<string>();
    for (const q of peopleDs.match(null, null, null, null)) {
      if (
        q.predicate.value === `${VCARD}inAddressBook` &&
        q.object.value === this.bookSubject &&
        q.subject.termType === "NamedNode"
      ) {
        docs.add(stripFragment(q.subject.value));
      }
    }
    return [...docs];
  }

  /** Union in any LEGACY flat `contacts/<slug>.ttl` documents still present. */
  private async listLegacy(): Promise<StoredItem<Contact>[]> {
    let entries: { url: string }[];
    try {
      entries = await listContainer(this.container, this.fetchImpl);
    } catch (e) {
      if (e instanceof RdfFetchError && (e.status === 404 || e.status === 403)) return [];
      throw e;
    }
    const items: StoredItem<Contact>[] = [];
    for (const entry of entries) {
      if (!isLegacyFlatContact(entry.url, this.container)) continue;
      try {
        const item = await this.read(entry.url);
        if (item) items.push(item);
      } catch (e) {
        // A legacy file that vanished (404) / is unreadable (403) is skipped; any
        // other failure (500/parse/auth) propagates rather than being masked
        // (roborev Medium — mirrors listCanonical).
        if (e instanceof ItemReadError && (e.status === 404 || e.status === 403)) continue;
        throw e;
      }
    }
    return items;
  }

  /**
   * Read one contact by document URL. Accepts the canonical `Person/…/index.ttl`
   * (subject `#this`) AND a legacy flat `<slug>.ttl` (subject `#it`).
   *
   * @throws ItemReadError when the resource cannot be fetched.
   */
  async read(url: string): Promise<StoredItem<Contact> | undefined> {
    this.assertInScope(url);
    let dataset: DatasetCore;
    let etag: string | null;
    try {
      ({ dataset, etag } = await readResource(url, this.fetchImpl));
    } catch (e) {
      if (e instanceof RdfFetchError) throw new ItemReadError(url, e.status ?? 0, { cause: e });
      throw e;
    }
    const data = parseContact(url, dataset);
    if (data === undefined) return undefined;
    return { url, etag, data };
  }

  /**
   * Create a new contact. Ensures the book + default group exist (idempotent),
   * mints a person at `Person/<uuid>/index.ttl`, writes the person document
   * create-only, indexes it (people index + default group membership), and
   * registers the book in the Type Index.
   *
   * @returns the new contact document URL and its ETag.
   */
  async create(contact: Contact): Promise<{ url: string; etag: string | null }> {
    await this.ensureBook();
    const url = this.newItemUrl();
    const dataset = buildPerson(url, toContactData(contact, this.bookSubject));
    const { etag } = await writeResource(url, dataset, {
      createOnly: true,
      fetchImpl: this.fetchImpl,
      prefixes: PREFIXES,
    });
    await this.indexPerson(personSubject(url), contact.fn);
    return { url, etag };
  }

  /**
   * Overwrite an existing contact. For a CANONICAL contact: a conditional write
   * (`If-Match`), then re-index (the name may have changed). For a LEGACY flat
   * contact: MIGRATE it forward — write the canonical `Person/<uuid>/index.ttl`,
   * index it, then delete the flat file ONLY after the new form is confirmed
   * written (write-then-delete, ETag-guarded). Returns the surviving document's
   * ETag.
   */
  async update(
    url: string,
    contact: Contact,
    etag?: string | null,
  ): Promise<{ etag: string | null; url?: string }> {
    this.assertInScope(url);
    if (isLegacyFlatContact(url, this.container)) {
      return this.migrateLegacy(url, contact, etag);
    }
    const dataset = buildPerson(url, toContactData(contact, this.bookSubject));
    const result = await writeResource(url, dataset, {
      etag,
      fetchImpl: this.fetchImpl,
      prefixes: PREFIXES,
    });
    await this.indexPerson(personSubject(url), contact.fn);
    return result;
  }

  /**
   * Delete a contact (idempotent). Removes the document AND prunes it from the
   * people index + the default group so a deleted contact does not linger as a
   * dangling index entry. For a legacy flat file the document delete suffices (it
   * was never in the canonical indexes).
   */
  async remove(url: string): Promise<void> {
    this.assertInScope(url);
    await deleteResource(url, this.fetchImpl);
    if (!isLegacyFlatContact(url, this.container)) {
      const subject = personSubject(url);
      await this.unindexPerson(subject).catch(() => {
        // Index pruning is best-effort — the document is already gone, which is
        // the caller's desired end state; a stale index entry self-heals on the
        // next list (the person GET 404s and is skipped).
      });
    }
  }

  /** Register the book in the Type Index (idempotent). Bootstraps a private index if absent. */
  async ensureRegistered(): Promise<void> {
    await ensureTypeRegistrations({
      webId: this.webId,
      podRoot: this.podRoot,
      registrations: [
        // ADDITIVE: keep the existing container registration for vcard:Individual
        // (so people still surface under "My data"), and add the address-book
        // INSTANCE registration SolidOS discovers the book through.
        { forClass: CONTACT_CLASS, container: this.container },
        { forClass: ADDRESS_BOOK_CLASS, instance: this.bookSubject },
      ],
      fetchImpl: this.fetchImpl,
    });
  }

  // --- internals: book bootstrap, indexing, migration -----------------------

  /**
   * Ensure the address book exists: write `index.ttl` (book root with title +
   * index links + `acl:owner`) create-only, ensure the default group, and
   * register in the Type Index. Idempotent — a 412 (already created) is
   * tolerated, and registration is the idempotent ensure path.
   */
  private async ensureBook(): Promise<void> {
    const book: AddressBookData = {
      title: "Contacts",
      nameEmailIndex: this.peopleDoc,
      groupIndex: this.groupsDoc,
      owner: this.webId,
    };
    await this.createOnly(this.bookDoc, buildAddressBook(this.bookDoc, book));
    await this.ensureDefaultGroup();
    await this.ensureGroupsIndex();
    await this.ensureRegistered();
  }

  /** Ensure an empty default `Group/Contacts.ttl` exists (create-only, idempotent). */
  private async ensureDefaultGroup(): Promise<void> {
    const ds = buildGroup(this.defaultGroupDoc, {
      name: DEFAULT_GROUP_NAME,
      inAddressBook: this.bookSubject,
      members: [],
    });
    await this.createOnly(this.defaultGroupDoc, ds);
  }

  /**
   * Ensure the GROUPS INDEX (`vcard:groupIndex` target) lists the default group.
   * SolidOS discovers groups THROUGH this document (not the book's
   * `includesGroup` alone), so without it the default group — and therefore every
   * contact, which SolidOS browses BY GROUP — stays invisible (roborev High).
   *
   * Read-modify-write (not create-only) so an EXISTING groups index that is empty
   * or missing the default group is REPAIRED idempotently while preserving any
   * other groups already listed (roborev Low) — a half-finished prior bootstrap
   * never leaves discovery permanently broken. A missing doc is created fresh.
   */
  private async ensureGroupsIndex(): Promise<void> {
    await this.rmwIndex(this.groupsDoc, (ds) =>
      upsertGroupsIndexEntry(ds, this.bookSubject, groupSubject(this.defaultGroupDoc), DEFAULT_GROUP_NAME),
    );
  }

  /**
   * Add (or refresh) a person in the people index AND the default group, via
   * conditional read-modify-write with bounded retry on 412 (a concurrent index
   * write). Each index doc is updated independently so a name change refreshes
   * the people-index `vcard:fn` and a new contact joins the default group.
   */
  private async indexPerson(personSubjectIri: string, name: string): Promise<void> {
    await this.rmwIndex(this.peopleDoc, (ds) =>
      upsertPeopleEntry(ds, this.bookSubject, personSubjectIri, name),
    );
    await this.rmwIndex(this.defaultGroupDoc, (ds) => upsertGroupMember(ds, personSubjectIri));
  }

  /** Prune a person from the people index AND the default group (best-effort). */
  private async unindexPerson(personSubjectIri: string): Promise<void> {
    await this.rmwIndex(this.peopleDoc, (ds) => removePeopleEntry(ds, personSubjectIri));
    await this.rmwIndex(this.defaultGroupDoc, (ds) => removeGroupMember(ds, personSubjectIri));
  }

  /**
   * Migrate a LEGACY flat `contacts/<slug>.ttl` forward into the canonical
   * `Person/<uuid>/index.ttl` form, NON-DESTRUCTIVELY:
   *   1. ensure the book + default group exist;
   *   2. write the new canonical person document (create-only);
   *   3. index it (people index + default group);
   *   4. delete the flat file ONLY after the new form is confirmed written
   *      (write-then-delete, ETag-guarded on the delete).
   * A failure before step 4 leaves the legacy file intact (reads still union it
   * in, deduped) — never a half-migrated, contact-losing state.
   */
  private async migrateLegacy(
    legacyUrl: string,
    contact: Contact,
    legacyEtag?: string | null,
  ): Promise<{ etag: string | null; url: string }> {
    await this.ensureBook();
    const newUrl = this.newItemUrl();
    const dataset = buildPerson(newUrl, toContactData(contact, this.bookSubject));
    const result = await writeResource(newUrl, dataset, {
      createOnly: true,
      fetchImpl: this.fetchImpl,
      prefixes: PREFIXES,
    });
    await this.indexPerson(personSubject(newUrl), contact.fn);
    // The canonical form is now confirmed written + indexed — only NOW remove the
    // legacy file (write-then-delete), conditional on its ETag so a concurrent
    // edit (412) aborts the delete rather than dropping a newer version.
    await this.deleteLegacy(legacyUrl, legacyEtag);
    // Return the NEW canonical URL so the caller (the edit page) re-points its
    // `?id=` at the migrated resource — the legacy URL is now gone.
    return { etag: result.etag, url: newUrl };
  }

  /**
   * Delete a legacy flat file, conditional on `etag` when supplied (so a
   * concurrent edit is not silently lost). A 404/410 (already gone) is success;
   * a 412 (changed under us) is swallowed — the canonical copy already exists, so
   * the next read dedupes, and the stale legacy file is removed on a later pass.
   */
  private async deleteLegacy(url: string, etag?: string | null): Promise<void> {
    if (!etag) {
      await deleteResource(url, this.fetchImpl);
      return;
    }
    const init: RequestInit = { method: "DELETE", headers: { "if-match": etag } };
    const res = this.fetchImpl ? await this.fetchImpl(url, init) : await fetch(url, init);
    if (res.ok || res.status === 404 || res.status === 410 || res.status === 412) return;
    throw new ResourceWriteError(url, res.status);
  }

  /** Write a document create-only, tolerating "already exists" (412). */
  private async createOnly(url: string, dataset: DatasetCore): Promise<void> {
    try {
      await writeResource(url, dataset, {
        createOnly: true,
        fetchImpl: this.fetchImpl,
        prefixes: PREFIXES,
      });
    } catch (e) {
      if (e instanceof ResourceWriteError && e.status === 412) return; // already exists
      throw e;
    }
  }

  /**
   * Conditional read-modify-write of an index/group document with bounded retry
   * on 412 (a concurrent index writer). Reads fresh each attempt, applies
   * `mutate`, and writes with `If-Match`. A missing document (404) is created
   * fresh (create-only) so a first-ever index write succeeds. `mutate` returns
   * `false` to signal "no change" (skip the write — keeps the op idempotent).
   */
  private async rmwIndex(url: string, mutate: (ds: DatasetCore) => boolean): Promise<void> {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let dataset: DatasetCore;
      let etag: string | null;
      let missing = false;
      try {
        ({ dataset, etag } = await freshRdf(url, this.fetchImpl));
      } catch (e) {
        if (e instanceof RdfFetchError && e.status === 404) {
          ({ dataset, etag } = this.freshIndexDoc(url));
          missing = true;
        } else {
          throw e;
        }
      }
      const changed = mutate(dataset);
      if (!changed) return; // nothing to write — idempotent no-op
      try {
        await writeResource(url, dataset, {
          etag: missing ? null : etag,
          createOnly: missing,
          fetchImpl: this.fetchImpl,
          prefixes: PREFIXES,
        });
        return;
      } catch (e) {
        // 412: a concurrent writer beat us. Re-read + retry (bounded).
        if (e instanceof ResourceWriteError && e.status === 412 && attempt < MAX_ATTEMPTS - 1) {
          continue;
        }
        throw e;
      }
    }
  }

  /**
   * A fresh, empty in-memory dataset for an index/group document that does not
   * yet exist — the people index is a bare graph (entries are added by `mutate`),
   * the default group is seeded as a typed empty group so it reads as a group.
   */
  private freshIndexDoc(url: string): { dataset: DatasetCore; etag: null } {
    if (url === this.defaultGroupDoc) {
      return {
        dataset: buildGroup(url, {
          name: DEFAULT_GROUP_NAME,
          inAddressBook: this.bookSubject,
          members: [],
        }),
        etag: null,
      };
    }
    if (url === this.groupsDoc) {
      // An empty groups index; the default-group entry is spliced in by the
      // ensureGroupsIndex mutator (so the same upsert path repairs an existing one).
      return { dataset: buildGroupsIndex(this.bookSubject, []), etag: null };
    }
    return { dataset: buildPeopleIndex(this.bookSubject, []), etag: null };
  }
}

/** Strip a `#fragment` off an IRI. */
function stripFragment(iri: string): string {
  const i = iri.indexOf("#");
  return i === -1 ? iri : iri.slice(0, i);
}

/**
 * The STRICT migration-twin identity keys for a contact — used to recognise that
 * a not-yet-deleted legacy file is the SAME contact as a migrated canonical doc
 * (a 412 aborted the legacy delete), WITHOUT ever collapsing two genuinely
 * distinct people.
 *
 * Migration re-writes the contact's fields verbatim, so a true twin matches on a
 * STRONG signal:
 *   - the WebID (a person identifier — a strong key on its own); and/or
 *   - the FULL field tuple `name|email|phone|note` (exact equality of everything
 *     the contact carries).
 *
 * Email or phone ALONE is deliberately NOT a key (distinct people can share a
 * household email/number — roborev Medium). A legacy file is treated as a twin
 * only when EVERY key it produces is also present on a canonical contact, so a
 * contact with no strong signal (e.g. a bare name) is never deduped (URL
 * uniqueness still applies). Returns `[]` when no strong signal exists.
 */
function migrationKeys(c: Contact): string[] {
  const keys: string[] = [];
  const webId = c.webId?.trim().toLowerCase();
  if (webId) keys.push(`webid:${webId}`);
  const name = c.fn?.trim().toLowerCase() ?? "";
  const email = c.email?.trim().toLowerCase() ?? "";
  const phone = c.phone?.trim() ?? "";
  const note = c.note?.trim() ?? "";
  // The full-tuple key only counts as a signal when at least one detail beyond a
  // (possibly shared) name is present — a bare-name contact has no twin signal.
  // JSON-encode the tuple so a field containing the delimiter can't collide with
  // a different tuple (roborev Low — a naive `a|b` join is ambiguous).
  if (name && (email || phone || webId || note)) {
    keys.push(`full:${JSON.stringify([name, email, phone, note])}`);
  }
  return keys;
}

// --- index mutators (pure; operate on a dataset, return "changed") -----------
// The contacts DOCUMENTS are always model-built; these only splice the
// index-listing EDGES (`vcard:inAddressBook`/`vcard:fn`/`vcard:hasMember`) into
// the people/groups index documents — the minimal listing SolidOS reads.

/** Add/refresh `person vcard:inAddressBook <book>; vcard:fn <name>` in the people index. */
function upsertPeopleEntry(
  ds: DatasetCore,
  bookSubject: string,
  personSubjectIri: string,
  name: string,
): boolean {
  const { namedNode, literal, quad } = DataFactory;
  const subj = namedNode(personSubjectIri);
  let changed = false;
  // inAddressBook back-link (idempotent).
  const inBook = namedNode(`${VCARD}inAddressBook`);
  if ([...ds.match(subj, inBook, namedNode(bookSubject))].length === 0) {
    ds.add(quad(subj, inBook, namedNode(bookSubject)));
    changed = true;
  }
  // fn — replace any prior value so a rename refreshes the index.
  const fnP = namedNode(`${VCARD}fn`);
  const existingFn = [...ds.match(subj, fnP, null)];
  const wanted = name || "";
  if (!(existingFn.length === 1 && existingFn[0].object.value === wanted)) {
    for (const q of existingFn) ds.delete(q);
    ds.add(quad(subj, fnP, literal(wanted)));
    changed = true;
  }
  return changed;
}

/** Remove every triple about a person subject from the people index. */
function removePeopleEntry(ds: DatasetCore, personSubjectIri: string): boolean {
  const subj = DataFactory.namedNode(personSubjectIri);
  const toDelete = [...ds.match(subj, null, null)];
  for (const q of toDelete) ds.delete(q);
  return toDelete.length > 0;
}

/** Add `<group> vcard:hasMember <person>` to the default group (idempotent). */
function upsertGroupMember(ds: DatasetCore, personSubjectIri: string): boolean {
  const groupSubj = soleGroupSubject(ds);
  if (!groupSubj) return false;
  const p = DataFactory.namedNode(`${VCARD}hasMember`);
  const o = DataFactory.namedNode(personSubjectIri);
  if ([...ds.match(groupSubj, p, o)].length) return false; // already a member
  ds.add(DataFactory.quad(groupSubj, p, o));
  return true;
}

/** Remove `<group> vcard:hasMember <person>` from the default group. */
function removeGroupMember(ds: DatasetCore, personSubjectIri: string): boolean {
  const groupSubj = soleGroupSubject(ds);
  if (!groupSubj) return false;
  const p = DataFactory.namedNode(`${VCARD}hasMember`);
  const o = DataFactory.namedNode(personSubjectIri);
  const toDelete = [...ds.match(groupSubj, p, o)];
  for (const q of toDelete) ds.delete(q);
  return toDelete.length > 0;
}

/**
 * Add `book vcard:includesGroup <group>` + the group's `a vcard:Group` + `vcard:fn`
 * to the GROUPS INDEX, idempotently — repairs an empty/partial index while
 * preserving any other groups it lists. Returns whether anything changed.
 */
function upsertGroupsIndexEntry(
  ds: DatasetCore,
  bookSubject: string,
  groupSubjectIri: string,
  name: string,
): boolean {
  const { namedNode, literal, quad } = DataFactory;
  const book = namedNode(bookSubject);
  const group = namedNode(groupSubjectIri);
  let changed = false;
  const includes = namedNode(`${VCARD}includesGroup`);
  if ([...ds.match(book, includes, group)].length === 0) {
    ds.add(quad(book, includes, group));
    changed = true;
  }
  const typeP = namedNode(RDF_TYPE);
  const groupType = namedNode(`${VCARD}Group`);
  if ([...ds.match(group, typeP, groupType)].length === 0) {
    ds.add(quad(group, typeP, groupType));
    changed = true;
  }
  const fnP = namedNode(`${VCARD}fn`);
  if (name && [...ds.match(group, fnP, null)].length === 0) {
    ds.add(quad(group, fnP, literal(name)));
    changed = true;
  }
  return changed;
}

/** The single `vcard:Group` subject in a group document, if exactly one. */
function soleGroupSubject(ds: DatasetCore): NamedNode | undefined {
  for (const q of ds.match(
    null,
    DataFactory.namedNode(RDF_TYPE),
    DataFactory.namedNode(`${VCARD}Group`),
  )) {
    if (q.subject.termType === "NamedNode") return q.subject;
  }
  return undefined;
}

// --- scope helpers -----------------------------------------------------------

/** Thrown when a URL passed to the store is not a contacts resource in-scope. */
export class ContactsScopeError extends Error {
  constructor(
    readonly url: string,
    readonly container: string,
  ) {
    super(`Refusing to act on a resource outside the contacts book: ${url}`);
    this.name = "ContactsScopeError";
  }
}

/**
 * Is `url` a CONTACT (person) DOCUMENT the item CRUD (`read`/`update`/`remove`)
 * may act on — strictly inside `container`, no `..`, no query/fragment? Accepts
 * ONLY the canonical person doc (`Person/<seg>/index.ttl`) and the legacy flat
 * contact (`<slug>.ttl`).
 *
 * Deliberately REJECTS the address-book STRUCTURAL documents — the book root
 * (`index.ttl`), the people/groups indexes, AND the group documents
 * (`Group/<slug>.ttl`). Those are written only by the store's OWN internal
 * bootstrap/index paths (which never pass a caller-supplied URL through this
 * guard); exposing them to the `?id=`-driven item CRUD would let a crafted link
 * OVERWRITE a group with a person doc or DELETE it (a confused-deputy —
 * roborev High). Group editing, if ever added, goes through a dedicated group
 * API, never the contact item store.
 */
export function isContactsResource(url: string, container: string): boolean {
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url);
    base = new URL(container);
  } catch {
    return false;
  }
  if (parsed.origin !== base.origin) return false;
  if (parsed.search !== "" || parsed.hash !== "") return false;
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  if (!parsed.pathname.startsWith(basePath)) return false;
  const rest = parsed.pathname.slice(basePath.length);
  if (rest.length === 0 || rest.endsWith("/")) return false; // container or sub-container
  if (rest.includes("..") || /%2e%2e/i.test(rest)) return false; // traversal
  if (/%2f/i.test(rest)) return false; // encoded slash
  const segs = rest.split("/");
  // Canonical person: Person/<seg>/index.ttl (exactly 3 segments).
  if (segs.length === 3 && segs[0] === "Person" && segs[2] === "index.ttl") return true;
  // Legacy flat contact: <slug>.ttl directly in the container (1 segment), but
  // NOT the structural docs (index/people/groups). Group/<slug>.ttl is a
  // 2-segment path and is NOT accepted here (it is a structural doc — see above).
  if (segs.length === 1 && segs[0].endsWith(".ttl") && !isStructuralDoc(segs[0])) return true;
  return false;
}

/** The structural address-book docs that are NOT contact item resources. */
function isStructuralDoc(seg: string): boolean {
  return seg === INDEX_DOC || seg === PEOPLE_DOC || seg === GROUPS_DOC;
}

/** Is `url` a LEGACY flat `contacts/<slug>.ttl` (one segment, not structural)? */
export function isLegacyFlatContact(url: string, container: string): boolean {
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url);
    base = new URL(container);
  } catch {
    return false;
  }
  if (parsed.origin !== base.origin) return false;
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  if (!parsed.pathname.startsWith(basePath)) return false;
  if (parsed.search !== "" || parsed.hash !== "") return false;
  const rest = parsed.pathname.slice(basePath.length);
  const segs = rest.split("/");
  return segs.length === 1 && segs[0].endsWith(".ttl") && !isStructuralDoc(segs[0]);
}

/**
 * Build a contacts store bound to the active pod + WebID — the stable public
 * factory consumed across the app (`use-people`, `use-federation-tasks`,
 * `pod-search`, the WebID-index search, prefetch, the pages).
 *
 * Production callers pass NO `fetchImpl` (the auth-patched global runs); tests
 * inject one. The `onAdvisory` option is accepted (for `useStore` parity) and
 * ignored — contacts data is guarded by the shared model's own scheme guards,
 * not the productivity SHACL surface.
 */
export function contactsStore(opts: {
  podRoot: string;
  webId: string;
  fetchImpl?: typeof fetch;
  onAdvisory?: unknown;
}): AddressBookContactsStore {
  return new AddressBookContactsStore(opts.podRoot, opts.webId, opts.fetchImpl);
}
