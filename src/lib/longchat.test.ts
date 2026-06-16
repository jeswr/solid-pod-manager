// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { Parser, Store } from "n3";
import {
  isLongChatDocument,
  longChatChannels,
  parseLongChatMessages,
  LONGCHAT_CLASS,
} from "./longchat.js";

const BASE = "https://alice.example/chat/index.ttl";

/** Parse a Turtle string into a Store, resolving relative IRIs against BASE. */
function ttl(body: string, base = BASE): Store {
  return new Store(new Parser({ baseIRI: base }).parse(body));
}

const PREFIXES = `
@prefix dc:     <http://purl.org/dc/elements/1.1/> .
@prefix dct:    <http://purl.org/dc/terms/> .
@prefix flow:   <http://www.w3.org/2005/01/wf/flow#> .
@prefix foaf:   <http://xmlns.com/foaf/0.1/> .
@prefix ical:   <http://www.w3.org/2002/12/cal/ical#> .
@prefix mee:    <http://www.w3.org/ns/pim/meeting#> .
@prefix schema: <https://schema.org/> .
@prefix schema_http: <http://schema.org/> .
@prefix sec:    <https://w3id.org/security#> .
@prefix sioc:   <http://rdfs.org/sioc/ns#> .
@prefix solid:  <http://www.w3.org/ns/solid/terms#> .
@prefix ui:     <http://www.w3.org/ns/ui#> .
@prefix xsd:    <http://www.w3.org/2001/XMLSchema#> .
@prefix : <#> .
`;

// The canonical self-contained channel fixture, copied from
// solidos/chat-pane/shapes/longchat-example.ttl (primary source). Msg1 is EDITED
// (replaced) by Msg1v2, which is a DELETION (schema:dateDeleted). Msg2 is a live
// reply in Msg1's thread.
const CHANNEL_EXAMPLE = `${PREFIXES}
:this
  a mee:LongChat ;
  dc:author :alice ;
  dc:title "Example Long Chat" ;
  dc:created "2026-04-07T10:00:00Z"^^xsd:dateTime ;
  ui:sharedPreferences :sharedPrefs ;
  flow:participation :participationAlice ;
  flow:message :Msg1 .

:participationAlice
  ical:dtstart "2026-04-07T10:00:00Z"^^xsd:dateTime ;
  flow:participant :alice .

:alice foaf:nick "alice" .

:Msg1
  sioc:content "Hello long chat" ;
  dct:created "2026-04-07T10:01:00Z"^^xsd:dateTime ;
  foaf:maker :alice ;
  sec:proofValue "sig-msg-1" ;
  sioc:has_reply :Msg1-thread ;
  dct:isReplacedBy :Msg1v2 .

:Msg2
  sioc:content "Reply in thread" ;
  dct:created "2026-04-07T10:02:00Z"^^xsd:dateTime ;
  foaf:maker :alice ;
  sec:proofValue "sig-msg-2" .

:Msg1-thread
  a sioc:Thread ;
  sioc:has_member :Msg2 .

:Msg1v2
  sioc:content "(message deleted)" ;
  dct:created "2026-04-07T10:03:00Z"^^xsd:dateTime ;
  foaf:maker :alice ;
  sec:proofValue "sig-msg-1-v2" ;
  sioc:has_reply :Msg1-thread ;
  schema:dateDeleted "2026-04-07T10:03:00Z"^^xsd:dateTime .
`;

// A dated chat file (YYYY/MM/DD/chat.ttl), copied from
// solidos/chat-pane/shapes/longchat-dated-chat-example.ttl. Messages here are the
// message graph itself (no flow:message link in the file).
const DATED_FILE = `${PREFIXES}
:Msg100
  sioc:content "Base message in dated chat file" ;
  dct:created "2026-04-07T11:00:00Z"^^xsd:dateTime ;
  foaf:maker :alice ;
  sec:proofValue "sig-msg-100" ;
  sioc:has_reply :Msg100-thread .

:Msg101
  sioc:content "Thread reply in dated chat file" ;
  dct:created "2026-04-07T11:01:00Z"^^xsd:dateTime ;
  foaf:maker :bob ;
  sec:proofValue "sig-msg-101" .

:Msg100-thread
  a sioc:Thread ;
  sioc:has_member :Msg101 .
`;

describe("isLongChatDocument / longChatChannels (detection)", () => {
  it("detects a mee:LongChat channel document", () => {
    const ds = ttl(CHANNEL_EXAMPLE);
    expect(isLongChatDocument(ds)).toBe(true);
    const channels = longChatChannels(ds);
    expect(channels).toHaveLength(1);
    expect(channels[0].isLongChat).toBe(true);
    expect(channels[0].title).toBe("Example Long Chat");
  });

  it("LONGCHAT_CLASS is the primary-source-confirmed meeting#LongChat IRI", () => {
    expect(LONGCHAT_CLASS).toBe("http://www.w3.org/ns/pim/meeting#LongChat");
  });

  it("returns false for PM's native sioc:Note document (no false-positive)", () => {
    const native = ttl(
      `@prefix sioc: <http://rdfs.org/sioc/ns#> . @prefix as: <https://www.w3.org/ns/activitystreams#> .
       <#it> a sioc:Note, as:Note ; sioc:content "hi" .`,
    );
    expect(isLongChatDocument(native)).toBe(false);
    expect(longChatChannels(native)).toEqual([]);
  });

  it("returns false for an unrelated document", () => {
    expect(isLongChatDocument(ttl(`<x> <y> "z" .`))).toBe(false);
  });
});

describe("parseLongChatMessages — author / time / body, ordering, edits, deletions", () => {
  it("parses the channel: deleted edit shows a tombstone, reply shows live, oldest→newest", () => {
    const out = parseLongChatMessages([ttl(CHANNEL_EXAMPLE)]);
    // Msg1 was replaced by Msg1v2 (a deletion) → ONE entry, the tombstone.
    // Msg2 is a live thread reply. The superseded original Msg1 must NOT appear.
    expect(out.map((m) => m.content)).toEqual(["Reply in thread", "(message deleted)"]);
    // Author + time read off the typed accessors.
    const reply = out.find((m) => m.content === "Reply in thread");
    expect(reply?.author).toBe("https://alice.example/chat/index.ttl#alice");
    expect(reply?.created).toBe("2026-04-07T10:02:00.000Z");
    const tomb = out.find((m) => m.content === "(message deleted)");
    expect(tomb?.created).toBe("2026-04-07T10:03:00.000Z");
  });

  it("the original (superseded) message body never leaks into the rendered list", () => {
    const out = parseLongChatMessages([ttl(CHANNEL_EXAMPLE)]);
    expect(out.some((m) => m.content === "Hello long chat")).toBe(false);
  });

  it("parses dated-file messages (message graph with no flow:message link)", () => {
    const base = "https://alice.example/chat/2026/04/07/chat.ttl";
    const out = parseLongChatMessages([ttl(DATED_FILE, base)]);
    expect(out.map((m) => m.content)).toEqual([
      "Base message in dated chat file",
      "Thread reply in dated chat file",
    ]);
    expect(out[0].author).toBe(`${base.replace("chat.ttl", "chat.ttl")}#alice`);
    expect(out[1].author).toBe(`${base}#bob`);
    expect(out[0].created).toBe("2026-04-07T11:00:00.000Z");
  });

  it("merges channel + dated files into one ordered conversation", () => {
    const out = parseLongChatMessages([
      ttl(CHANNEL_EXAMPLE),
      ttl(DATED_FILE, "https://alice.example/chat/2026/04/07/chat.ttl"),
    ]);
    // Four rendered messages total (2 from channel after edit/delete, 2 dated),
    // strictly oldest→newest by dct:created.
    expect(out.map((m) => m.created)).toEqual([
      "2026-04-07T10:02:00.000Z",
      "2026-04-07T10:03:00.000Z",
      "2026-04-07T11:00:00.000Z",
      "2026-04-07T11:01:00.000Z",
    ]);
  });

  it("accepts the http://schema.org/ deletion variant too (compat)", () => {
    const httpDel = `${PREFIXES}
      :M
        sioc:content "to delete" ;
        dct:created "2026-04-07T12:00:00Z"^^xsd:dateTime ;
        foaf:maker :alice ;
        schema_http:dateDeleted "2026-04-07T12:01:00Z"^^xsd:dateTime .`;
    const out = parseLongChatMessages([ttl(httpDel)]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("(message deleted)");
  });

  it("ignores non-message nodes (thread, participation, channel itself)", () => {
    // The channel subject, the thread, and the participation node are NOT
    // messages (they lack the body+created+maker triple-set) → never rendered.
    const out = parseLongChatMessages([ttl(CHANNEL_EXAMPLE)]);
    expect(out.every((m) => m.content !== "Example Long Chat")).toBe(true);
    expect(out.length).toBe(2);
  });

  it("survives a cyclic dct:isReplacedBy chain without looping (bounded)", () => {
    const cyclic = `${PREFIXES}
      :A sioc:content "a" ; dct:created "2026-04-07T10:00:00Z"^^xsd:dateTime ; foaf:maker :alice ; dct:isReplacedBy :B .
      :B sioc:content "b" ; dct:created "2026-04-07T10:01:00Z"^^xsd:dateTime ; foaf:maker :alice ; dct:isReplacedBy :A .`;
    // Both A and B are superseded (each is the subject of a dct:isReplacedBy), so
    // neither renders directly; the walk must terminate, not hang.
    const out = parseLongChatMessages([ttl(cyclic)]);
    expect(Array.isArray(out)).toBe(true);
  });

  it("parses a BLANK-NODE message and does not collide with a same-value NamedNode", () => {
    // A blank-node message AND a NamedNode message whose lexical value matches the
    // blank-node label must both render as DISTINCT messages (term-kind identity).
    const mixed = `${PREFIXES}
      [] sioc:content "from blank node" ; dct:created "2026-04-07T09:00:00Z"^^xsd:dateTime ; foaf:maker :alice .
      :b1 sioc:content "from named node" ; dct:created "2026-04-07T09:01:00Z"^^xsd:dateTime ; foaf:maker :alice .`;
    const out = parseLongChatMessages([ttl(mixed)]);
    expect(out.map((m) => m.content)).toEqual(["from blank node", "from named node"]);
    expect(out).toHaveLength(2); // two distinct messages, no collision
  });

  it("blank-node messages in TWO documents reusing the same label do NOT collide", () => {
    // n3 relabels blank nodes per parse, but to be certain the parser is robust to
    // two datasets that each contain a blank-node message: both must render as
    // DISTINCT messages (doc-scoped blank-node identity), never deduped into one.
    const fileA = `${PREFIXES}
      [] sioc:content "message in file A" ; dct:created "2026-04-07T08:00:00Z"^^xsd:dateTime ; foaf:maker :alice .`;
    const fileB = `${PREFIXES}
      [] sioc:content "message in file B" ; dct:created "2026-04-07T08:01:00Z"^^xsd:dateTime ; foaf:maker :bob .`;
    const out = parseLongChatMessages([
      ttl(fileA, "https://alice.example/chat/2026/04/07/chat.ttl"),
      ttl(fileB, "https://alice.example/chat/2026/04/08/chat.ttl"),
    ]);
    expect(out.map((m) => m.content)).toEqual(["message in file A", "message in file B"]);
    expect(out).toHaveLength(2);
  });

  it("an isReplacedBy in ONE file does not suppress a like-labelled node in ANOTHER", () => {
    // A blank-node original superseded in file A must not cause a same-labelled
    // (but distinct) blank-node message in file B to disappear (doc-scoped
    // superseded keys).
    const fileA = `${PREFIXES}
      :orig sioc:content "old A" ; dct:created "2026-04-07T07:00:00Z"^^xsd:dateTime ; foaf:maker :alice ; dct:isReplacedBy :new .
      :new  sioc:content "new A" ; dct:created "2026-04-07T07:05:00Z"^^xsd:dateTime ; foaf:maker :alice .`;
    const fileB = `${PREFIXES}
      :orig sioc:content "independent B" ; dct:created "2026-04-07T07:10:00Z"^^xsd:dateTime ; foaf:maker :bob .`;
    const out = parseLongChatMessages([
      ttl(fileA, "https://alice.example/chat/2026/04/07/chat.ttl"),
      ttl(fileB, "https://bob.example/chat/2026/04/07/chat.ttl"),
    ]);
    // file A shows only its LATEST ("new A"); file B's same-IRI-local `:orig`
    // (a DIFFERENT absolute IRI, different base) is independent and still shows.
    expect(out.map((m) => m.content).sort()).toEqual(["independent B", "new A"]);
  });

  it("never returns live HTML — message bodies are plain text only", () => {
    const htmlBody = `${PREFIXES}
      :M sioc:content "<img src=x onerror=alert(1)>" ; dct:created "2026-04-07T10:00:00Z"^^xsd:dateTime ; foaf:maker :alice .
      :ch a mee:LongChat ; flow:message :M .`;
    const out = parseLongChatMessages([ttl(htmlBody)]);
    // The body is returned verbatim as a STRING (the UI renders it as text); the
    // parser does not interpret or sanitise — it never produces markup/DOM.
    expect(out[0].content).toBe("<img src=x onerror=alert(1)>");
    expect(typeof out[0].content).toBe("string");
  });
});
