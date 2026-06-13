/**
 * Contacts — an address book, one `vcard:Individual` per resource under
 * `contacts/`.
 *
 * Class: `vcard:Individual` — already in this app's Identity/Contacts category
 * class lists (`src/lib/categories.ts`), so contacts surface under "Contacts"
 * in "My data".
 *
 * Fields: `vcard:fn` (formatted name), `vcard:hasEmail`, `vcard:hasTelephone`,
 * `vcard:note`.
 *
 * **Email / telephone modelling choice.** The vCard ontology models
 * `hasEmail`/`hasTelephone` as object properties pointing at `vcard:Email` /
 * `vcard:Voice` resources carrying `vcard:value`. A spec-faithful, widely
 * interoperable shortcut that this app adopts is the `mailto:` / `tel:` URI
 * form: `vcard:hasEmail <mailto:a@b.com>` — a single triple, used by Inrupt's
 * contacts app and the Solid contacts shape. We store one email and one phone
 * (the common case for a personal address book); the URI scheme is stripped for
 * display. This keeps the document a flat, human-readable single subject while
 * staying re-readable by other vCard-aware Solid apps.
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
import { createStore, type ProductivityStore, type StoreConfig } from "./productivity-store.js";

const VCARD = "http://www.w3.org/2006/vcard/ns#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** The RDF class a contact is stamped + registered with. */
export const CONTACT_CLASS = `${VCARD}Individual`;

/** Container slug under the pod root. */
export const CONTACTS_SLUG = "contacts/";

const PREFIXES = { vcard: VCARD } as const;

/** A contact as the UI works with it (plain, serialisable). */
export interface Contact {
  /** Full name — `vcard:fn`. */
  fn: string;
  /** Email address (bare, no `mailto:`) — `vcard:hasEmail`. */
  email?: string;
  /** Phone number (bare, no `tel:`) — `vcard:hasTelephone`. */
  phone?: string;
  /** Free-text note — `vcard:note`. */
  note?: string;
}

/** Typed `@rdfjs/wrapper` view of a single contact's subject. */
export class ContactDoc extends TermWrapper {
  get types(): Set<string> {
    return SetFrom.subjectPredicate(this, RDF_TYPE, NamedNodeAs.string, NamedNodeFrom.string);
  }
  mark(): this {
    this.types.add(CONTACT_CLASS);
    return this;
  }
  get fn(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${VCARD}fn`, LiteralAs.string);
  }
  set fn(v: string | undefined) {
    OptionalAs.object(this, `${VCARD}fn`, v, LiteralFrom.string);
  }
  /** `vcard:hasEmail` as a `mailto:` IRI (raw, scheme included). */
  get emailUri(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${VCARD}hasEmail`, NamedNodeAs.string);
  }
  set emailUri(v: string | undefined) {
    OptionalAs.object(this, `${VCARD}hasEmail`, v, NamedNodeFrom.string);
  }
  /** `vcard:hasTelephone` as a `tel:` IRI (raw, scheme included). */
  get phoneUri(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${VCARD}hasTelephone`, NamedNodeAs.string);
  }
  set phoneUri(v: string | undefined) {
    OptionalAs.object(this, `${VCARD}hasTelephone`, v, NamedNodeFrom.string);
  }
  get note(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${VCARD}note`, LiteralAs.string);
  }
  set note(v: string | undefined) {
    OptionalAs.object(this, `${VCARD}note`, v, LiteralFrom.string);
  }
}

/** Strip a `mailto:`/`tel:` scheme for display; `undefined` passes through. */
export function stripScheme(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const m = /^(?:mailto|tel):(.*)$/i.exec(uri);
  if (!m) return uri;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    // Malformed percent-encoding (e.g. an imported value like `bad%ZZ@y.z`) must
    // not throw — that would make the whole contact fail to parse and vanish
    // from the list. Fall back to the raw scheme-stripped value.
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

/** Parse a contact document into a {@link Contact}, or `undefined` if not one. */
export function parseContact(
  itemUrl: string,
  dataset: import("@rdfjs/types").DatasetCore,
): Contact | undefined {
  const doc = new ContactDoc(`${itemUrl}#it`, dataset, DataFactory);
  if (!doc.types.has(CONTACT_CLASS)) return undefined;
  return {
    fn: doc.fn ?? "",
    email: stripScheme(doc.emailUri),
    phone: stripScheme(doc.phoneUri),
    note: doc.note,
  };
}

/** Serialise a {@link Contact} into a fresh dataset rooted at `${itemUrl}#it`. */
export function buildContact(itemUrl: string, contact: Contact): Store {
  const store = new Store();
  const doc = new ContactDoc(`${itemUrl}#it`, store, DataFactory).mark();
  doc.fn = contact.fn || undefined;
  doc.emailUri = toMailto(contact.email);
  doc.phoneUri = toTel(contact.phone);
  doc.note = contact.note || undefined;
  return store;
}

/** The store config — wires the typed parse/build into the shared CRUD. */
export const CONTACTS_CONFIG: StoreConfig<Contact> = {
  containerSlug: CONTACTS_SLUG,
  forClass: CONTACT_CLASS,
  prefixes: PREFIXES,
  parse: parseContact,
  build: buildContact,
};

/** Build a Contacts store bound to the active pod + WebID. */
export function contactsStore(opts: {
  podRoot: string;
  webId: string;
  fetchImpl?: typeof fetch;
}): ProductivityStore<Contact> {
  return createStore(CONTACTS_CONFIG, opts);
}
