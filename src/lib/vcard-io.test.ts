// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { exportVCard, importVCard } from "./vcard-io.js";
import { contactsStore, type Contact } from "./contacts.js";
import { createMemoryPod, TEST_POD_ROOT, TEST_WEBID } from "./integrations/core/testing.js";

describe("vCard round-trip", () => {
  it("exports and re-imports a full contact", () => {
    const contact: Contact = {
      fn: "Ada Lovelace",
      email: "ada@example.com",
      phone: "+44 20 7946 0958",
      note: "Met at conference; remember to follow up",
    };
    const vcf = exportVCard([contact]);
    expect(vcf).toContain("BEGIN:VCARD");
    expect(vcf).toContain("VERSION:4.0");
    const [c] = importVCard(vcf);
    expect(c.fn).toBe("Ada Lovelace");
    expect(c.email).toBe("ada@example.com");
    expect(c.phone).toBe("+44 20 7946 0958");
    expect(c.note).toBe("Met at conference; remember to follow up");
  });

  it("derives FN from N when FN is absent", () => {
    const vcf = ["BEGIN:VCARD", "VERSION:3.0", "N:Hopper;Grace;;;", "EMAIL:grace@navy.mil", "END:VCARD"].join("\r\n");
    const [c] = importVCard(vcf);
    expect(c.fn).toBe("Grace Hopper");
    expect(c.email).toBe("grace@navy.mil");
  });

  it("falls back to N/email when FN is blank", () => {
    const vcf = ["BEGIN:VCARD", "VERSION:3.0", "FN:", "N:Hopper;Grace;;;", "EMAIL:grace@navy.mil", "END:VCARD"].join("\r\n");
    const [c] = importVCard(vcf);
    expect(c.fn).toBe("Grace Hopper");
  });

  it("strips a mailto:/tel: scheme an exporter may leave", () => {
    const vcf = ["BEGIN:VCARD", "FN:X", "EMAIL:mailto:x@y.z", "TEL:tel:+15551234567", "END:VCARD"].join("\n");
    const [c] = importVCard(vcf);
    expect(c.email).toBe("x@y.z");
    expect(c.phone).toBe("+15551234567");
  });

  it("imports multiple cards in one file", () => {
    const vcf = [
      "BEGIN:VCARD",
      "FN:One",
      "END:VCARD",
      "BEGIN:VCARD",
      "FN:Two",
      "END:VCARD",
    ].join("\r\n");
    const contacts = importVCard(vcf);
    expect(contacts.map((c) => c.fn)).toEqual(["One", "Two"]);
  });

  it("escapes and unescapes commas/semicolons in NOTE", () => {
    const contact: Contact = { fn: "Comma, Person", note: "a, b; c" };
    const [c] = importVCard(exportVCard([contact]));
    expect(c.fn).toBe("Comma, Person");
    expect(c.note).toBe("a, b; c");
  });

  it("normalises bare CR / CRLF in text values", () => {
    const [c] = importVCard(exportVCard([{ fn: "X", note: "a\r\nb\rc" }]));
    expect(c.note).toBe("a\nb\nc");
  });

  it("decodes ENCODING=QUOTED-PRINTABLE values (vCard 3.0)", () => {
    // "Café" encoded as UTF-8 quoted-printable: C3 A9 for é.
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN;ENCODING=QUOTED-PRINTABLE:Caf=C3=A9 Owner",
      "NOTE;ENCODING=QUOTED-PRINTABLE:line one=0Aline two",
      "END:VCARD",
    ].join("\r\n");
    const [c] = importVCard(vcf);
    expect(c.fn).toBe("Café Owner");
    expect(c.note).toBe("line one\nline two");
  });

  it("joins quoted-printable soft line-breaks across lines", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Folded Note",
      "NOTE;ENCODING=QUOTED-PRINTABLE:first part=",
      "second part",
      "END:VCARD",
    ].join("\r\n");
    const [c] = importVCard(vcf);
    expect(c.fn).toBe("Folded Note");
    expect(c.note).toBe("first partsecond part");
  });

  it("ignores a card with nothing usable", () => {
    const vcf = ["BEGIN:VCARD", "VERSION:4.0", "END:VCARD"].join("\r\n");
    expect(importVCard(vcf)).toHaveLength(0);
  });

  it("folds long lines and unfolds them on import", () => {
    const contact: Contact = { fn: "N".repeat(120) };
    const vcf = exportVCard([contact]);
    expect(vcf.split("\r\n").some((l) => l.startsWith(" "))).toBe(true);
    const [c] = importVCard(vcf);
    expect(c.fn).toBe("N".repeat(120));
  });

  it("folds non-ASCII names on UTF-8 octet boundaries and round-trips", () => {
    const fn = "naïve café 日本語 ".repeat(6);
    const vcf = exportVCard([{ fn, note: "café" }]);
    for (const line of vcf.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    const [c] = importVCard(vcf);
    expect(c.fn).toBe(fn.trim());
    expect(c.note).toBe("café");
  });

  it("exports TEL with VALUE=text so free-form numbers stay verbatim", () => {
    const vcf = exportVCard([{ fn: "X", phone: "+44 20 7946 0958" }]);
    expect(vcf).toContain("TEL;VALUE=text:+44 20 7946 0958");
    const [c] = importVCard(vcf);
    expect(c.phone).toBe("+44 20 7946 0958");
  });

  it("decodes ISO-8859-1 quoted-printable using the CHARSET parameter", () => {
    // "Café" in ISO-8859-1: é is the single byte 0xE9.
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:Caf=E9",
      "END:VCARD",
    ].join("\r\n");
    const [c] = importVCard(vcf);
    expect(c.fn).toBe("Café");
  });

  it("splits N on unescaped semicolons, keeping escaped ones literal", () => {
    // Family name "de la O; Jr" with an escaped semicolon; given "María".
    const vcf = ["BEGIN:VCARD", "VERSION:4.0", "N:de la O\\; Jr;María;;;", "END:VCARD"].join("\r\n");
    const [c] = importVCard(vcf);
    expect(c.fn).toBe("María de la O; Jr");
  });

  it("matches CHARSET case-insensitively regardless of parameter case", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN;charset=iso-8859-1;encoding=QUOTED-PRINTABLE:Caf=E9",
      "END:VCARD",
    ].join("\r\n");
    const [c] = importVCard(vcf);
    expect(c.fn).toBe("Café");
  });

  it("imports a BOM-prefixed .vcf (Windows/Outlook exports)", () => {
    const vcf = `\uFEFF${["BEGIN:VCARD", "FN:Bommed", "EMAIL:b@o.m", "END:VCARD"].join("\r\n")}`;
    const [c] = importVCard(vcf);
    expect(c.fn).toBe("Bommed");
    expect(c.email).toBe("b@o.m");
  });

  it("matches grouped properties like item1.EMAIL", () => {
    const vcf = [
      "BEGIN:VCARD",
      "FN:Grouped",
      "item1.EMAIL:grouped@example.com",
      "item2.TEL:+15551234567",
      "END:VCARD",
    ].join("\r\n");
    const [c] = importVCard(vcf);
    expect(c.email).toBe("grouped@example.com");
    expect(c.phone).toBe("+15551234567");
  });

  it("does not throw on a malformed percent-encoded mailto:", () => {
    const vcf = ["BEGIN:VCARD", "FN:X", "EMAIL:mailto:bad%ZZ@y.z", "END:VCARD"].join("\r\n");
    const [c] = importVCard(vcf);
    // Kept as the scheme-stripped raw value rather than throwing.
    expect(c.email).toBe("bad%ZZ@y.z");
  });

  it("round-trips a malformed-email import through the store without vanishing", async () => {
    // Regression: a malformed percent-encoded email must survive create→list,
    // not throw in parseContact (which would drop the contact from the list).
    const pod = createMemoryPod();
    const store = contactsStore({ podRoot: TEST_POD_ROOT, webId: TEST_WEBID, fetchImpl: pod.fetch });
    const [parsed] = importVCard(["BEGIN:VCARD", "FN:Bad Email", "EMAIL:bad%ZZ@y.z", "END:VCARD"].join("\r\n"));
    await store.create(parsed, parsed.fn);
    const items = await store.list();
    expect(items).toHaveLength(1);
    expect(items[0].data.fn).toBe("Bad Email");
  });
});
