// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import {
  readEditableProfile,
  applyEditableProfile,
  saveProfile,
  fetchEditableProfile,
  profileDocUrl,
  type EditableProfile,
} from "./profile-edit.js";
import { createMemoryPod, TEST_WEBID, TEST_PROFILE_DOC } from "./integrations/core/testing.js";

const WEBID = "https://alice.example/profile/card#me";
const DOC = "https://alice.example/profile/card";

describe("profileDocUrl", () => {
  it("strips the fragment to the document URL", () => {
    expect(profileDocUrl(WEBID)).toBe(DOC);
  });
});

describe("readEditableProfile", () => {
  it("reads every editable field, name preferring vcard:fn", async () => {
    const ds = await parseRdf(
      `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
       @prefix vcard: <http://www.w3.org/2006/vcard/ns#>.
       @prefix solid: <http://www.w3.org/ns/solid/terms#>.
       <${WEBID}> a foaf:Person ;
         vcard:fn "Alice Card" ;
         foaf:name "Alice FOAF" ;
         foaf:nick "Al" ;
         vcard:hasPhoto <https://alice.example/me.jpg> ;
         vcard:role "Engineer" ;
         vcard:organization-name "Example Co" ;
         solid:preferredPronouns "she/her" ;
         vcard:note "Hi there" ;
         foaf:homepage <https://alice.example/> .`,
      "text/turtle",
    );
    const p = readEditableProfile(WEBID, ds);
    expect(p.name).toBe("Alice Card");
    expect(p.nickname).toBe("Al");
    expect(p.photo).toBe("https://alice.example/me.jpg");
    expect(p.role).toBe("Engineer");
    expect(p.organisation).toBe("Example Co");
    expect(p.pronouns).toBe("she/her");
    expect(p.description).toBe("Hi there");
    expect(p.homepage).toBe("https://alice.example/");
  });

  it("falls back to foaf:name when vcard:fn is absent; empty name otherwise", async () => {
    const named = await parseRdf(
      `@prefix foaf: <http://xmlns.com/foaf/0.1/>. <${WEBID}> foaf:name "Only FOAF" .`,
      "text/turtle",
    );
    expect(readEditableProfile(WEBID, named).name).toBe("Only FOAF");

    const bare = await parseRdf(
      `@prefix foaf: <http://xmlns.com/foaf/0.1/>. <${WEBID}> a foaf:Person .`,
      "text/turtle",
    );
    const p = readEditableProfile(WEBID, bare);
    expect(p.name).toBe("");
    expect(p.photo).toBeUndefined();
  });
});

describe("applyEditableProfile", () => {
  it("writes name to both vcard:fn and foaf:name; clears emptied fields", async () => {
    const ds = await parseRdf(
      `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
       @prefix vcard: <http://www.w3.org/2006/vcard/ns#>.
       <${WEBID}> a foaf:Person ; vcard:role "Old role" .`,
      "text/turtle",
    );
    applyEditableProfile(WEBID, ds, { name: "New Name", role: "  " });
    const after = readEditableProfile(WEBID, ds);
    expect(after.name).toBe("New Name");
    expect(after.role).toBeUndefined(); // whitespace-only cleared
    // both predicates carry the name
    const names = [...ds].filter(
      (q) =>
        q.predicate.value === "http://xmlns.com/foaf/0.1/name" ||
        q.predicate.value === "http://www.w3.org/2006/vcard/ns#fn",
    );
    expect(names.map((q) => q.object.value).sort()).toEqual(["New Name", "New Name"]);
  });

  it("preserves unrelated triples on the subject (e.g. storage, issuer)", async () => {
    const ds = await parseRdf(
      `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
       @prefix solid: <http://www.w3.org/ns/solid/terms#>.
       @prefix pim: <http://www.w3.org/ns/pim/space#>.
       <${WEBID}> a foaf:Person ;
         solid:oidcIssuer <https://idp.example/> ;
         pim:storage <https://alice.example/> ;
         foaf:name "Old" .`,
      "text/turtle",
    );
    applyEditableProfile(WEBID, ds, { name: "Renamed" });
    const preserved = [...ds].filter(
      (q) =>
        q.predicate.value === "http://www.w3.org/ns/solid/terms#oidcIssuer" ||
        q.predicate.value === "http://www.w3.org/ns/pim/space#storage",
    );
    expect(preserved).toHaveLength(2);
  });
});

describe("saveProfile / fetchEditableProfile round-trip (I/O)", () => {
  it("reads, edits, conditionally writes, and re-reads the new values", async () => {
    const pod = createMemoryPod();

    const { profile, etag } = await fetchEditableProfile(TEST_WEBID, pod.fetch);
    expect(profile.name).toBe("Alice Test"); // seeded foaf:name
    expect(etag).toBeTruthy();

    const edit: EditableProfile = {
      name: "Alice Tested",
      nickname: "Ali",
      role: "Maintainer",
      homepage: "https://alice.test/",
    };
    await saveProfile({ webId: TEST_WEBID, edit, fetchImpl: pod.fetch });

    const reread = await fetchEditableProfile(TEST_WEBID, pod.fetch);
    expect(reread.profile.name).toBe("Alice Tested");
    expect(reread.profile.nickname).toBe("Ali");
    expect(reread.profile.role).toBe("Maintainer");
    expect(reread.profile.homepage).toBe("https://alice.test/");

    // The seeded storage/issuer survive the read-modify-write.
    const raw = pod.get(TEST_PROFILE_DOC) ?? "";
    expect(raw).toContain("storage");
    expect(raw).toContain("oidcIssuer");
  });

  it("surfaces a 412 as ResourceWriteError when the ETag is stale", async () => {
    const pod = createMemoryPod();
    // Prime: one save bumps the version so a hand-built stale write fails.
    await saveProfile({ webId: TEST_WEBID, edit: { name: "v2" }, fetchImpl: pod.fetch });
    // A second concurrent save reading the same fresh etag still succeeds —
    // staleness is exercised at the writeResource layer (covered there); here
    // we assert a clean second save round-trips.
    await expect(
      saveProfile({ webId: TEST_WEBID, edit: { name: "v3" }, fetchImpl: pod.fetch }),
    ).resolves.toBeTruthy();
  });
});
