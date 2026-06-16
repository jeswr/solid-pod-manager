// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * SolidOS `meeting:LongChat` READER — read-first interop (PM task #95 / G4,
 * research #62 P1-2).
 *
 * PM's NATIVE chat model (see `chat.ts`) is a flat append-only log: one resource
 * per message, each typed `sioc:Note` (+ `as:Note`) at the `${url}#it` subject.
 * SolidOS (the reference Solid app suite) writes a DIFFERENT shape, the
 * `meeting:LongChat` "long chat":
 *
 *   - a CHANNEL document (conventionally `index.ttl#this`) typed
 *     `mee:LongChat` with `dc:title` / `dc:author` / `dc:created` and
 *     `flow:participation` / `flow:message` links;
 *   - MESSAGES stored in dated files (`YYYY/MM/DD/chat.ttl`), each message a
 *     node with `sioc:content` (body, xsd:string), `dct:created`
 *     (xsd:dateTime) and `foaf:maker` (author WebID), signed with
 *     `sec:proofValue`. Messages are linked from the channel/threads via
 *     `flow:message` / `sioc:has_member`;
 *   - EDITS + DELETES are append-only: an edit is a replacement message linked
 *     by `dct:isReplacedBy`; a delete is a replacement carrying
 *     `schema:dateDeleted` (both `http://schema.org/` and `https://schema.org/`
 *     are accepted for compatibility).
 *
 * PRIMARY SOURCE for every term below: solidos/chat-pane
 * `shapes/longchat-shapes.ttl` + `shapes/longchat-example.ttl` +
 * `shapes/longchat-dated-chat-example.ttl` (and `src/create.ts`, which registers
 * the channel under the private type index as `solid:forClass mee:LongChat`).
 *
 * READ-ONLY: this module ONLY parses. PM's native model stays the sole WRITE
 * model (`chat.ts` `Chat.send`) — we never author the `meeting:LongChat` shape
 * and never cross-pod write. A `meeting:LongChat` channel renders read-only.
 *
 * Typed `@rdfjs/wrapper` accessors throughout — never a regex/string match on
 * the serialised RDF (house rule). Message bodies are returned as PLAIN TEXT
 * (`ChatMessage.content`); the UI renders them as text, never as live HTML.
 */
import {
  LiteralAs,
  NamedNodeAs,
  NamedNodeFrom,
  OptionalFrom,
  SetFrom,
  TermAs,
  TermWrapper,
} from "@rdfjs/wrapper";
import { DataFactory } from "n3";
import type { DatasetCore, Quad_Subject } from "@rdfjs/types";
import type { ChatMessage } from "./chat.js";

// --- Namespaces (all primary-source-confirmed against longchat-shapes.ttl) ----
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const MEETING = "http://www.w3.org/ns/pim/meeting#";
const FLOW = "http://www.w3.org/2005/01/wf/flow#";
const SIOC = "http://rdfs.org/sioc/ns#";
const DCT = "http://purl.org/dc/terms/";
const DC = "http://purl.org/dc/elements/1.1/";
const FOAF = "http://xmlns.com/foaf/0.1/";
// Both schema.org base IRIs are valid per the shape file ("both ... are accepted
// for compatibility") — a delete tombstone may use either.
const SCHEMA_HTTPS = "https://schema.org/";
const SCHEMA_HTTP = "http://schema.org/";

/** The RDF class a SolidOS long-chat CHANNEL is typed with. */
export const LONGCHAT_CLASS = `${MEETING}LongChat`;
/**
 * The predicates linking a channel/thread to its message nodes
 * (`flow:message` from the channel, `sioc:has_member` from a thread). The
 * parser recognises messages by their TRIPLE-SET (body+created+maker) across
 * the whole graph rather than walking these links, so it captures inline,
 * threaded AND dated-file messages uniformly; the local names are documented
 * here for provenance against `longchat-shapes.ttl`.
 */
export const FLOW_MESSAGE_PREDICATE = `${FLOW}message`;
export const SIOC_HAS_MEMBER_PREDICATE = `${SIOC}has_member`;
/** The predicate linking an original message to its replacement (edit/delete). */
const DCT_IS_REPLACED_BY = `${DCT}isReplacedBy`;
/** Message body / created / author. */
const SIOC_CONTENT = `${SIOC}content`;
const DCT_CREATED = `${DCT}created`;
const FOAF_MAKER = `${FOAF}maker`;

/**
 * A typed view of a `mee:LongChat` channel subject. Read-only accessors only.
 */
export class LongChatChannel extends TermWrapper {
  get types(): Set<string> {
    // `termFrom` is needed by the returned set's `.has()` (it converts the query
    // value to a term); we only ever READ this set (never `.add`), but the
    // converter must be a real one, not a throwing stub.
    return SetFrom.subjectPredicate(this, RDF_TYPE, NamedNodeAs.string, NamedNodeFrom.string);
  }
  /** True iff this subject is typed `mee:LongChat`. */
  get isLongChat(): boolean {
    return this.types.has(LONGCHAT_CLASS);
  }
  get title(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${DC}title`, LiteralAs.string);
  }
}

/**
 * A typed view of a single long-chat MESSAGE node — a node carrying the message
 * triple-set (`sioc:content` + `dct:created` + `foaf:maker`), whether it is the
 * object of `flow:message` / `sioc:has_member` / `dct:isReplacedBy` (inline /
 * threaded / edit chains) or a standalone subject in a dated chat file.
 * Read-only.
 *
 * Note message nodes may be IRIs (`#fragment`) OR blank nodes, so this wraps a
 * generic term, not specifically a NamedNode.
 */
export class LongChatMessageNode extends TermWrapper {
  get content(): string | undefined {
    return OptionalFrom.subjectPredicate(this, SIOC_CONTENT, LiteralAs.string);
  }
  get created(): Date | undefined {
    return OptionalFrom.subjectPredicate(this, DCT_CREATED, LiteralAs.date);
  }
  get author(): string | undefined {
    return OptionalFrom.subjectPredicate(this, FOAF_MAKER, NamedNodeAs.string);
  }
  /** The replacement message node (an edit / delete), if this was superseded. */
  get replacedBy(): LongChatMessageNode | undefined {
    return OptionalFrom.subjectPredicate(
      this,
      DCT_IS_REPLACED_BY,
      TermAs.instance(LongChatMessageNode),
    );
  }
  /** The deletion timestamp (`schema:dateDeleted`), if this is a tombstone. */
  get dateDeleted(): Date | undefined {
    return (
      OptionalFrom.subjectPredicate(this, `${SCHEMA_HTTPS}dateDeleted`, LiteralAs.date) ??
      OptionalFrom.subjectPredicate(this, `${SCHEMA_HTTP}dateDeleted`, LiteralAs.date)
    );
  }
  /** True iff this node carries the minimal message triple-set (body+created+maker). */
  get isMessage(): boolean {
    return this.content !== undefined && this.created !== undefined && this.author !== undefined;
  }
}

/** True iff `dataset` contains a subject typed `mee:LongChat`. */
export function isLongChatDocument(dataset: DatasetCore): boolean {
  for (const _q of dataset.match(
    null,
    DataFactory.namedNode(RDF_TYPE),
    DataFactory.namedNode(LONGCHAT_CLASS),
  )) {
    return true;
  }
  return false;
}

/**
 * Collect every distinct subject typed `mee:LongChat` in `dataset` (there is
 * normally exactly one — `index.ttl#this`).
 */
export function longChatChannels(dataset: DatasetCore): LongChatChannel[] {
  const out: LongChatChannel[] = [];
  const seen = new Set<string>();
  for (const q of dataset.match(
    null,
    DataFactory.namedNode(RDF_TYPE),
    DataFactory.namedNode(LONGCHAT_CLASS),
  )) {
    const key = termKey(q.subject);
    if (seen.has(key)) continue;
    seen.add(key);
    // Wrap from the ORIGINAL subject term (preserves named/blank-node identity).
    out.push(new LongChatChannel(q.subject, dataset, DataFactory));
  }
  return out;
}

/**
 * A STABLE cross-document identity key for an RDF subject term.
 *
 * Two correctness rules (both roborev findings):
 *   - PRESERVE THE TERM KIND so a NamedNode `<…#b1>` and a BlankNode `_:b1`
 *     never collide (a bare `.value` string would conflate them).
 *   - SCOPE BLANK NODES TO THEIR DOCUMENT. Blank-node labels are unique ONLY
 *     within one dataset, so the SAME label `_:b1` in two different dated files
 *     denotes DIFFERENT nodes; keying both globally by value would make distinct
 *     messages collide (or a replacement in one file suppress a message in
 *     another). Named-node IRIs are globally unique, so they stay un-scoped (a
 *     message edited across files still dedups correctly).
 *
 * `docId` is a per-document discriminator (its index in the parsed set). The
 * SPACE delimiter is safe because `termType` is a fixed enum with no spaces, and
 * the key is plain printable text — no NUL (which would make the source look
 * binary to git).
 */
function termKey(term: { termType: string; value: string }, docId = 0): string {
  return term.termType === "BlankNode"
    ? `BlankNode#${docId} ${term.value}`
    : `${term.termType} ${term.value}`;
}

/**
 * Walk a message node and its `dct:isReplacedBy` replacement chain to its
 * LATEST version (append-only edits) WITHIN one document (`docId`). Bounded to
 * avoid a cyclic chain looping forever (a malformed/malicious graph could point
 * a node back at itself). Keyed on the doc-scoped term identity so a blank-node
 * loop is detected too.
 */
function latestVersion(node: LongChatMessageNode, docId: number): LongChatMessageNode {
  let current = node;
  const seen = new Set<string>([termKey(current, docId)]);
  for (let i = 0; i < 64; i++) {
    const next = current.replacedBy;
    if (!next || seen.has(termKey(next, docId))) break;
    seen.add(termKey(next, docId));
    current = next;
  }
  return current;
}

/**
 * Convert a (latest-version) message node into the UI {@link ChatMessage}, or
 * `undefined` if it lacks the minimal message shape. A deleted message (a
 * replacement carrying `schema:dateDeleted`) renders as a "(message deleted)"
 * tombstone so the conversation history stays intact and ordered.
 *
 * `id` is the node's term value (a `#fragment` IRI, or a blank-node label) used
 * as a render key. Bodies are returned as plain text.
 */
function toChatMessage(node: LongChatMessageNode, id: string): ChatMessage | undefined {
  const deleted = node.dateDeleted;
  if (deleted) {
    return {
      url: id,
      author: node.author,
      content: "(message deleted)",
      created: (node.created ?? deleted).toISOString(),
    };
  }
  if (!node.isMessage) return undefined;
  return {
    url: id,
    author: node.author,
    content: node.content ?? "",
    // isMessage guarantees created is present.
    created: node.created?.toISOString(),
  };
}

/**
 * Parse all messages out of one or more long-chat documents (the channel index
 * and/or its dated chat files), oldest→newest, with edits collapsed to their
 * latest version, superseded originals hidden, and deletions shown as
 * tombstones. Returns plain serialisable {@link ChatMessage}s.
 *
 * A message node is recognised by carrying the minimal message triple-set
 * (`sioc:content` + `dct:created` + `foaf:maker`) — this covers BOTH inline
 * channel messages (linked via `flow:message`) AND dated-file messages (the
 * message graph itself), without depending on which linkage a particular
 * deployment used. Superseded nodes (the SOURCE of a `dct:isReplacedBy`) are
 * dropped so only the latest version of each edit chain shows once.
 *
 * Identity preserves the RDF term KIND and is DOCUMENT-SCOPED for blank nodes
 * (their labels are only unique within a dataset), so a blank-node message in
 * one file never collides with — or is wrongly superseded by — a same-labelled
 * node in another file. Each subject is wrapped from the ORIGINAL term (not a
 * reconstructed string) so blank nodes resolve correctly.
 */
export function parseLongChatMessages(datasets: DatasetCore[]): ChatMessage[] {
  // 1. Every node REPLACED by another (older versions in an edit chain) — these
  //    must not render directly; only the chain's latest does. The replacement
  //    edge lives within ONE document, so the superseded key is doc-scoped too
  //    (a blank-node original in file A must not suppress a like-labelled node in
  //    file B).
  const supersededKeys = new Set<string>();
  datasets.forEach((ds, docId) => {
    for (const q of ds.match(null, DataFactory.namedNode(DCT_IS_REPLACED_BY), null)) {
      supersededKeys.add(termKey(q.subject, docId));
    }
  });

  // 2. Every distinct subject TERM (kind- + doc-scoped) carrying the message
  //    shape. Index by the LATEST-version node's doc-scoped key so an edit chain
  //    contributes one entry.
  const byKey = new Map<string, ChatMessage>();
  datasets.forEach((ds, docId) => {
    // Distinct subject TERMS for this dataset — keep the original term object so
    // the wrapper preserves blank-node vs named-node identity.
    const subjects = new Map<string, Quad_Subject>();
    for (const q of ds) {
      const k = termKey(q.subject, docId);
      if (!subjects.has(k)) subjects.set(k, q.subject);
    }
    for (const [subjectKey, subjectTerm] of subjects) {
      if (supersededKeys.has(subjectKey)) continue; // an older edit version — skip
      const node = new LongChatMessageNode(subjectTerm, ds, DataFactory);
      if (!node.isMessage && node.dateDeleted === undefined) continue;
      const latest = latestVersion(node, docId);
      const latestKey = termKey(latest, docId);
      const msg = toChatMessage(latest, latest.value);
      if (msg && !byKey.has(latestKey)) byKey.set(latestKey, msg);
    }
  });

  return sortByCreated([...byKey.values()]);
}

/** Sort oldest→newest with a stable id tiebreaker (chat order). */
function sortByCreated(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort((a, b) => {
    const ca = a.created ?? "";
    const cb = b.created ?? "";
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  });
}
