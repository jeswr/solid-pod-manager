import { describe, it, expect } from "vitest";
import {
  parseContact,
  buildContact,
  contactsStore,
  CONTACT_CLASS,
  stripScheme,
  toMailto,
  toTel,
} from "./contacts.js";
import {
  createMemoryPod,
  TEST_POD_ROOT,
  TEST_WEBID,
} from "./integrations/core/testing.js";

const url = `${TEST_POD_ROOT}contacts/c.ttl`;

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
    const { url: created, etag } = await store.create({ fn: "Grace", email: "grace@navy.mil" }, "Grace");
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
