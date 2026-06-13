// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import {
  looksLikeWebId,
  filterPeople,
  buildPeopleOptions,
  resolveWebIdOption,
  type PersonOption,
} from "./people-search.js";

const BOB = "https://bob.example/profile/card#me";
const CAROL = "https://carol.example/profile/card#me";

describe("looksLikeWebId", () => {
  it("accepts absolute http(s) URLs with a dotted host", () => {
    expect(looksLikeWebId(BOB)).toBe(true);
    expect(looksLikeWebId("http://example.org/")).toBe(true);
    expect(looksLikeWebId("  https://x.io/me#me  ")).toBe(true);
  });
  it("rejects names and non-URLs", () => {
    expect(looksLikeWebId("Bob Smith")).toBe(false);
    expect(looksLikeWebId("bob@example.com")).toBe(false);
    expect(looksLikeWebId("localhost")).toBe(false);
    expect(looksLikeWebId("ftp://x.org")).toBe(false);
  });
});

describe("buildPeopleOptions", () => {
  it("merges contacts + friends, contact label wins on conflict, sorted", () => {
    const opts = buildPeopleOptions({
      contacts: [
        { webId: BOB, name: "Bob Smith", email: "bob@x.com" },
        { webId: "", name: "No WebID" }, // dropped
      ],
      friends: [BOB, CAROL],
    });
    expect(opts).toHaveLength(2);
    const bob = opts.find((o) => o.webId === BOB);
    expect(bob?.source).toBe("contact");
    expect(bob?.label).toBe("Bob Smith");
    const carol = opts.find((o) => o.webId === CAROL);
    expect(carol?.source).toBe("friend");
    expect(carol?.label).toBe(CAROL);
  });

  it("labels a nameless contact by its WebID", () => {
    const opts = buildPeopleOptions({ contacts: [{ webId: BOB }], friends: [] });
    expect(opts[0].label).toBe(BOB);
  });
});

describe("filterPeople", () => {
  const people: PersonOption[] = [
    { webId: BOB, label: "Bob Smith", source: "contact", detail: "bob@x.com" },
    { webId: CAROL, label: "Carol Jones", source: "friend" },
  ];
  it("returns all on empty query", () => {
    expect(filterPeople(people, "  ")).toHaveLength(2);
  });
  it("matches label, detail and webId case-insensitively", () => {
    expect(filterPeople(people, "bob")).toHaveLength(1);
    expect(filterPeople(people, "carol.example")).toHaveLength(1);
    expect(filterPeople(people, "@x.com")).toHaveLength(1);
    expect(filterPeople(people, "zzz")).toHaveLength(0);
  });
});

describe("resolveWebIdOption", () => {
  const profileFetch = (ttl: string): typeof fetch =>
    (async () =>
      new Response(ttl, {
        status: 200,
        headers: { "content-type": "text/turtle" },
      })) as typeof fetch;

  it("uses the public profile name as a label when present", async () => {
    const opt = await resolveWebIdOption(
      BOB,
      profileFetch(`@prefix foaf: <http://xmlns.com/foaf/0.1/>. <${BOB}> foaf:name "Bob Smith" .`),
    );
    expect(opt.label).toBe("Bob Smith");
    expect(opt.source).toBe("webid");
    expect(opt.detail).toBe(BOB);
  });

  it("falls back to a bare-WebID option when the profile has no name", async () => {
    const opt = await resolveWebIdOption(
      BOB,
      profileFetch(`@prefix foaf: <http://xmlns.com/foaf/0.1/>. <${BOB}> a foaf:Person .`),
    );
    expect(opt.label).toBe(BOB);
    expect(opt.detail).toBeUndefined();
  });

  it("falls back to a bare-WebID option when the profile is unreadable", async () => {
    const failing = (async () => new Response("nf", { status: 404 })) as typeof fetch;
    const opt = await resolveWebIdOption(BOB, failing);
    expect(opt).toEqual({ webId: BOB, label: BOB, source: "webid" });
  });
});
