import { describe, it, expect } from "vitest";
import {
  parseContact,
  buildContact,
  contactsStore,
  CONTACT_CLASS,
  ADDRESS_BOOK_CLASS,
  ContactsScopeError,
  isContactsResource,
  isLegacyFlatContact,
  stripScheme,
  toMailto,
  toTel,
} from "./contacts.js";
import { buildPerson, addressBookSubject } from "@jeswr/solid-task-model/contacts";
import { DataFactory } from "n3";
import { discoverRegistrations } from "./type-index.js";
import { freshRdf } from "./rdf-read.js";
import {
  createMemoryPod,
  TEST_POD_ROOT,
  TEST_WEBID,
} from "./integrations/core/testing.js";

const url = `${TEST_POD_ROOT}contacts/c.ttl`;
const CONTAINER = `${TEST_POD_ROOT}contacts/`;
const BOOK_DOC = `${CONTAINER}index.ttl`;
const PEOPLE_DOC = `${CONTAINER}people.ttl`;
const BOOK_SUBJECT = addressBookSubject(BOOK_DOC);
const VCARD = "http://www.w3.org/2006/vcard/ns#";
const DataFactoryValue = DataFactory.namedNode(`${VCARD}value`);

describe("uri helpers", () => {
  it("wraps and strips mailto:", () => {
    expect(toMailto("a@b.com")).toBe("mailto:a@b.com");
    expect(stripScheme("mailto:a@b.com")).toBe("a@b.com");
    expect(toMailto("  ")).toBeUndefined();
  });
  it("wraps and strips tel:, normalising the number", () => {
    expect(toTel("+1 (555) 123-4567")).toBe("tel:+15551234567");
    expect(stripScheme("tel:+15551234567")).toBe("+15551234567");
    expect(toTel(undefined)).toBeUndefined();
  });
});

describe("buildContact / parseContact round-trip", () => {
  it("preserves name, email, phone and note", () => {
    const ds = buildContact(url, {
      fn: "Ada Lovelace",
      email: "ada@example.com",
      phone: "+44 20 7946 0958",
      note: "Met at conference",
    });
    const c = parseContact(url, ds);
    expect(c?.fn).toBe("Ada Lovelace");
    expect(c?.email).toBe("ada@example.com");
    expect(c?.phone).toBe("+442079460958");
    expect(c?.note).toBe("Met at conference");
  });

  it("stamps vcard:Individual and serialises emails as mailto: IRIs", () => {
    const ds = buildContact(url, { fn: "X", email: "x@y.z" });
    expect([...ds].some((q) => q.object.value === CONTACT_CLASS)).toBe(true);
    expect([...ds].some((q) => q.object.value === "mailto:x@y.z")).toBe(true);
  });

  it("preserves a contact WebID (vcard:url) for the people-picker", () => {
    const webId = "https://ada.example/profile/card#me";
    const ds = buildContact(url, { fn: "Ada", webId });
    expect([...ds].some((q) => q.object.value === webId)).toBe(true);
    expect(parseContact(url, ds)?.webId).toBe(webId);
  });

  it("handles a contact with only a name", () => {
    const ds = buildContact(url, { fn: "Nameless Only" });
    const c = parseContact(url, ds);
    expect(c?.fn).toBe("Nameless Only");
    expect(c?.email).toBeUndefined();
    expect(c?.phone).toBeUndefined();
  });

  it("returns undefined for a non-contact document", () => {
    const ds = buildContact(url, { fn: "X" });
    expect(parseContact(`${TEST_POD_ROOT}contacts/other.ttl`, ds)).toBeUndefined();
  });
});

describe("contactsStore (I/O)", () => {
  it("creates, updates and deletes a contact", async () => {
    const pod = createMemoryPod();
    const store = contactsStore({ podRoot: TEST_POD_ROOT, webId: TEST_WEBID, fetchImpl: pod.fetch });
    const { url: created, etag } = await store.create({ fn: "Grace", email: "grace@navy.mil" });
    let items = await store.list();
    expect(items).toHaveLength(1);
    expect(items[0].data.email).toBe("grace@navy.mil");

    await store.update(created, { fn: "Grace Hopper", email: "grace@navy.mil" }, etag);
    const reread = await store.read(created);
    expect(reread?.data.fn).toBe("Grace Hopper");

    await store.remove(created);
    items = await store.list();
    expect(items).toHaveLength(0);
  });
});

// --- SolidOS address-book layout (task #102/#105) -----------------------------

describe("address-book write path (SolidOS layout)", () => {
  it("creates the book, people index, default group + canonical person doc", async () => {
    const pod = createMemoryPod();
    const store = contactsStore({ podRoot: TEST_POD_ROOT, webId: TEST_WEBID, fetchImpl: pod.fetch });
    const { url: person } = await store.create({ fn: "Ada Lovelace", email: "ada@x.io" });

    // Person doc is at contacts/Person/<uuid>/index.ttl.
    expect(person).toMatch(/contacts\/Person\/[0-9a-f-]+\/index\.ttl$/);

    // The book root exists and is a vcard:AddressBook with the index links.
    const book = pod.dataset(BOOK_DOC);
    expect(
      [...book.match(null, null, null)].some(
        (q) => q.predicate.value.endsWith("#type") && q.object.value === ADDRESS_BOOK_CLASS,
      ),
    ).toBe(true);
    expect(pod.get(BOOK_DOC)).toContain("nameEmailIndex");
    // acl:owner is the WebID.
    expect(pod.get(BOOK_DOC)).toContain(TEST_WEBID);

    // The people index lists the person back-linked to the book.
    const people = pod.dataset(PEOPLE_DOC);
    const subj = `${person}#this`;
    expect(
      [...people.match(null, null, null)].some(
        (q) =>
          q.subject.value === subj &&
          q.predicate.value === `${VCARD}inAddressBook` &&
          q.object.value === BOOK_SUBJECT,
      ),
    ).toBe(true);

    // The default group exists and lists the person as a member (SolidOS browses
    // BY GROUP, so a contact must be in ≥1 group to be visible).
    const groupDoc = `${CONTAINER}Group/Contacts.ttl`;
    const group = pod.dataset(groupDoc);
    expect(
      [...group.match(null, null, null)].some(
        (q) => q.predicate.value === `${VCARD}hasMember` && q.object.value === subj,
      ),
    ).toBe(true);

    // The person doc writes the STRUCTURED email form SolidOS reads.
    const personDs = pod.dataset(person);
    expect([...personDs.match(null, DataFactoryValue, null)].length).toBeGreaterThan(0);
    expect(pod.get(person)).toContain("vcard:value");
  });

  it("writes structured email/phone/webid that round-trip through read", async () => {
    const pod = createMemoryPod();
    const store = contactsStore({ podRoot: TEST_POD_ROOT, webId: TEST_WEBID, fetchImpl: pod.fetch });
    const { url: person } = await store.create({
      fn: "Grace",
      email: "grace@navy.mil",
      phone: "+1 555 0100",
      webId: "https://grace.example/card#me",
      note: "Compiler pioneer",
    });
    const read = await store.read(person);
    expect(read?.data).toEqual({
      fn: "Grace",
      email: "grace@navy.mil",
      phone: "+15550100",
      webId: "https://grace.example/card#me",
      note: "Compiler pioneer",
    });
  });

  it("re-indexes the people-index fn on a rename", async () => {
    const pod = createMemoryPod();
    const store = contactsStore({ podRoot: TEST_POD_ROOT, webId: TEST_WEBID, fetchImpl: pod.fetch });
    const { url: person, etag } = await store.create({ fn: "Ada" });
    await store.update(person, { fn: "Ada Lovelace" }, etag);
    const people = pod.get(PEOPLE_DOC) ?? "";
    expect(people).toContain("Ada Lovelace");
    // The list reflects the new name too.
    const items = await store.list();
    expect(items[0].data.fn).toBe("Ada Lovelace");
  });

  it("registers the address book as a solid:instance ADDITIVELY (keeps the container)", async () => {
    const pod = createMemoryPod();
    const store = contactsStore({ podRoot: TEST_POD_ROOT, webId: TEST_WEBID, fetchImpl: pod.fetch });
    await store.create({ fn: "Ada" });

    const { dataset } = await freshRdf(`${TEST_POD_ROOT}profile/card`, pod.fetch);
    const discovered = await discoverRegistrations(TEST_WEBID, dataset, pod.fetch);
    const forBook = discovered.locations.filter((l) => l.forClass === ADDRESS_BOOK_CLASS);
    const forIndividual = discovered.locations.filter((l) => l.forClass === CONTACT_CLASS);
    // The book is registered as a single instance (contacts/index.ttl#this).
    expect(forBook.some((l) => l.instance === BOOK_SUBJECT)).toBe(true);
    // The legacy container registration for vcard:Individual is still present.
    expect(forIndividual.some((l) => l.container === CONTAINER)).toBe(true);
  });

  it("prunes the people index + group membership on delete", async () => {
    const pod = createMemoryPod();
    const store = contactsStore({ podRoot: TEST_POD_ROOT, webId: TEST_WEBID, fetchImpl: pod.fetch });
    const { url: person } = await store.create({ fn: "Ada" });
    await store.remove(person);
    const subj = `${person}#this`;
    const people = pod.dataset(PEOPLE_DOC);
    expect([...people.match(null, null, null)].some((q) => q.subject.value === subj)).toBe(false);
    const group = pod.dataset(`${CONTAINER}Group/Contacts.ttl`);
    expect([...group.match(null, null, null)].some((q) => q.object.value === subj)).toBe(false);
    expect(await store.list()).toHaveLength(0);
  });
});

describe("forward migration of legacy flat contacts (non-destructive)", () => {
  /** Seed a legacy flat `contacts/<slug>.ttl` (subject `#it`, direct-IRI email). */
  function legacyTurtle(): string {
    return `@prefix vcard: <${VCARD}>.
<${url}#it> a vcard:Individual ;
  vcard:fn "Legacy Person" ;
  vcard:hasEmail <mailto:legacy@old.example> .`;
  }

  it("reads a legacy flat contact (union, deduped) without migrating on read", async () => {
    const pod = createMemoryPod();
    await pod.fetch(url, {
      method: "PUT",
      headers: { "content-type": "text/turtle" },
      body: legacyTurtle(),
    });
    const store = contactsStore({ podRoot: TEST_POD_ROOT, webId: TEST_WEBID, fetchImpl: pod.fetch });
    const items = await store.list();
    expect(items).toHaveLength(1);
    expect(items[0].data.fn).toBe("Legacy Person");
    expect(items[0].data.email).toBe("legacy@old.example");
    // Read did not migrate — the flat file is still present.
    expect(pod.get(url)).toBeTruthy();
  });

  it("migrates a legacy contact forward on update, then deletes the flat file", async () => {
    const pod = createMemoryPod();
    const put = await pod.fetch(url, {
      method: "PUT",
      headers: { "content-type": "text/turtle" },
      body: legacyTurtle(),
    });
    const legacyEtag = put.headers.get("etag");
    const store = contactsStore({ podRoot: TEST_POD_ROOT, webId: TEST_WEBID, fetchImpl: pod.fetch });

    const { url: migrated } = await store.update(
      url,
      { fn: "Legacy Person", email: "legacy@old.example" },
      legacyEtag,
    );
    // The new canonical person doc exists ...
    expect(migrated).toBeDefined();
    if (!migrated) throw new Error("expected a migrated url");
    expect(migrated).toMatch(/contacts\/Person\/[0-9a-f-]+\/index\.ttl$/);
    expect(pod.get(migrated)).toContain("vcard:value");
    // ... and the flat file was deleted ONLY after the new form was written.
    expect(pod.get(url)).toBeUndefined();
    // The list now shows exactly one (canonical) contact.
    const items = await store.list();
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe(migrated);
  });
});

describe("scope guard (confused-deputy)", () => {
  const store = contactsStore({ podRoot: TEST_POD_ROOT, webId: TEST_WEBID });

  it("accepts canonical person/group docs and legacy flat contacts", () => {
    expect(isContactsResource(`${CONTAINER}Person/abc/index.ttl`, CONTAINER)).toBe(true);
    expect(isContactsResource(`${CONTAINER}Group/Family.ttl`, CONTAINER)).toBe(true);
    expect(isContactsResource(`${CONTAINER}old-contact.ttl`, CONTAINER)).toBe(true);
    expect(isLegacyFlatContact(`${CONTAINER}old-contact.ttl`, CONTAINER)).toBe(true);
    expect(isLegacyFlatContact(`${CONTAINER}Person/abc/index.ttl`, CONTAINER)).toBe(false);
  });

  it("rejects structural docs, the container, traversal + foreign origins", () => {
    expect(isContactsResource(`${CONTAINER}index.ttl`, CONTAINER)).toBe(false);
    expect(isContactsResource(`${CONTAINER}people.ttl`, CONTAINER)).toBe(false);
    expect(isContactsResource(`${CONTAINER}groups.ttl`, CONTAINER)).toBe(false);
    expect(isContactsResource(CONTAINER, CONTAINER)).toBe(false);
    expect(isContactsResource(`${CONTAINER}Person/../../evil.ttl`, CONTAINER)).toBe(false);
    expect(isContactsResource(`${CONTAINER}sub/`, CONTAINER)).toBe(false);
    expect(isContactsResource("https://evil.example/contacts/x.ttl", CONTAINER)).toBe(false);
    expect(isContactsResource(`${CONTAINER}x.ttl?id=1`, CONTAINER)).toBe(false);
  });

  it("read/update/remove fail closed on an out-of-scope URL", async () => {
    await expect(store.read("https://evil.example/x.ttl")).rejects.toBeInstanceOf(
      ContactsScopeError,
    );
    await expect(
      store.update("https://evil.example/x.ttl", { fn: "x" }),
    ).rejects.toBeInstanceOf(ContactsScopeError);
    await expect(store.remove(`${CONTAINER}index.ttl`)).rejects.toBeInstanceOf(
      ContactsScopeError,
    );
  });
});

// buildPerson is exercised indirectly through the store; asserting its
// structured output here documents the SolidOS contract directly.
describe("model contract (buildPerson structured form)", () => {
  it("writes a structured vcard:hasEmail node with a vcard:value mailto:", () => {
    const pdoc = `${CONTAINER}Person/zzz/index.ttl`;
    const ds = buildPerson(pdoc, {
      name: "Ada",
      inAddressBook: BOOK_SUBJECT,
      emails: ["mailto:ada@x.io"],
    });
    const valueQuads = [...ds.match(null, DataFactoryValue, null)];
    expect(valueQuads.some((q) => q.object.value === "mailto:ada@x.io")).toBe(true);
  });
});
