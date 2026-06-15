// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Chat / long-chat (Feature 2) — an append-only message log under the user's
 * pod. One container per chat (`chat/<channel>/`), one resource per message
 * (mirrors SolidOS long-chat's dated structure, kept simple: flat per-chat).
 *
 * Message vocab: `sioc:Note` with `sioc:content` (text) + `dct:created`
 * (`xsd:dateTime`) + a `foaf:maker` author WebID. We also stamp `as:Note` so the
 * message is recognisable as an ActivityStreams object. Typed `@rdfjs/wrapper`
 * accessors only — never hand-concat Turtle.
 *
 * SCOPE (confused-deputy guard): a chat is viewed/written at a CONTAINER URL,
 * which may arrive via a `?url=` query param. Before ANY read/write we validate
 * the container is inside one of the user's OWN pods (`isInOwnPods`) — same-pod
 * only — and each message resource must be a direct child of that container.
 * Sending = create-only PUT (append), never overwrite. Optionally notify a
 * contact via the SSRF-hardened `sendNotification`.
 */
import { RdfFetchError } from "@jeswr/fetch-rdf";
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
import { isInOwnPods } from "./pod-scope.js";
import { toSlug } from "./productivity-store.js";
import { listContainer, readResource, writeResource } from "./pod-data.js";
import { ChatScopeError, ChatMessageError } from "./errors.js";

const SIOC = "http://rdfs.org/sioc/ns#";
const DCT = "http://purl.org/dc/terms/";
const FOAF = "http://xmlns.com/foaf/0.1/";
const AS = "https://www.w3.org/ns/activitystreams#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** The RDF class a chat message is stamped with. */
export const MESSAGE_CLASS = `${SIOC}Note`;
/** Root slug under the pod for chats. */
export const CHAT_SLUG = "chat/";

const PREFIXES = { sioc: SIOC, dct: DCT, foaf: FOAF, as: AS } as const;

/** A chat message as the UI consumes it (plain, serialisable). */
export interface ChatMessage {
  /** The message resource URL. */
  url: string;
  /** Author WebID — `foaf:maker`. */
  author?: string;
  /** Body text — `sioc:content`. */
  content: string;
  /** Created — `dct:created`, as an ISO string. */
  created?: string;
}

/** Typed `@rdfjs/wrapper` view of a single message subject. */
export class MessageDoc extends TermWrapper {
  get types(): Set<string> {
    return SetFrom.subjectPredicate(this, RDF_TYPE, NamedNodeAs.string, NamedNodeFrom.string);
  }
  mark(): this {
    this.types.add(MESSAGE_CLASS);
    this.types.add(`${AS}Note`);
    return this;
  }
  get content(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SIOC}content`, LiteralAs.string);
  }
  set content(v: string | undefined) {
    OptionalAs.object(this, `${SIOC}content`, v, LiteralFrom.string);
  }
  get author(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${FOAF}maker`, NamedNodeAs.string);
  }
  set author(v: string | undefined) {
    OptionalAs.object(this, `${FOAF}maker`, v, NamedNodeFrom.string);
  }
  get created(): Date | undefined {
    return OptionalFrom.subjectPredicate(this, `${DCT}created`, LiteralAs.date);
  }
  set created(v: Date | undefined) {
    OptionalAs.object(this, `${DCT}created`, v, LiteralFrom.dateTime);
  }
}

/** True for an absolute http(s) URL usable as an author WebID. */
function isWebId(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Parse a message document into a {@link ChatMessage}, or `undefined` if not one.
 *
 * INTEROP NOTE: we read the conventional `${url}#it` subject this app writes. A
 * message authored by another long-chat client that uses the resource URL itself
 * (or a different fragment) as the subject would not be recognised here. This is
 * an accepted app-owned-format simplification.
 */
export function parseMessage(
  url: string,
  dataset: import("@rdfjs/types").DatasetCore,
): ChatMessage | undefined {
  const doc = new MessageDoc(`${url}#it`, dataset, DataFactory);
  if (!doc.types.has(MESSAGE_CLASS)) return undefined;
  return {
    url,
    author: doc.author,
    content: doc.content ?? "",
    created: doc.created?.toISOString(),
  };
}

/** Serialise a message into a fresh dataset rooted at `${url}#it`. */
export function buildMessage(
  url: string,
  msg: { author?: string; content: string; created?: Date },
): Store {
  const store = new Store();
  const doc = new MessageDoc(`${url}#it`, store, DataFactory).mark();
  doc.content = msg.content || undefined;
  doc.author = isWebId(msg.author) ? msg.author : undefined;
  doc.created = msg.created ?? new Date();
  return store;
}

/** Sort messages oldest→newest (chat order); stable url tiebreaker. */
export function sortMessages(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort((a, b) => {
    const ca = a.created ?? "";
    const cb = b.created ?? "";
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  });
}

/** Build the container URL for a named chat channel under the user's pod. */
export function chatContainerUrl(podRoot: string, channel: string): string {
  const slug = toSlug(channel) || Math.random().toString(36).slice(2, 8);
  return new URL(`${CHAT_SLUG}${slug}/`, podRoot).toString();
}

/**
 * A chat bound to a specific container URL + the active session's storages.
 * Construct via {@link openChat}, which enforces the same-pod scope guard on the
 * (possibly caller-supplied) container URL BEFORE any I/O.
 */
export class Chat {
  constructor(
    readonly containerUrl: string,
    private readonly storages: readonly string[],
    private readonly webId: string,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  /** Fail closed unless `url` is a direct child resource of this chat container. */
  private assertInContainer(url: string): void {
    let parsed: URL;
    let container: URL;
    try {
      parsed = new URL(url);
      container = new URL(this.containerUrl);
    } catch {
      throw new ChatScopeError(url, this.containerUrl);
    }
    const containerPath = container.pathname.endsWith("/")
      ? container.pathname
      : `${container.pathname}/`;
    if (
      parsed.origin !== container.origin ||
      !parsed.pathname.startsWith(containerPath) ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new ChatScopeError(url, this.containerUrl);
    }
    const rest = parsed.pathname.slice(containerPath.length);
    const isDirectChild = rest.length > 0 && !rest.includes("/") && !/%2f/i.test(rest);
    if (!isDirectChild) throw new ChatScopeError(url, this.containerUrl);
  }

  /** List + parse all messages, oldest→newest. Missing container → empty. */
  async messages(): Promise<ChatMessage[]> {
    let entries: { url: string }[];
    try {
      entries = await listContainer(this.containerUrl, this.fetchImpl);
    } catch (e) {
      if (e instanceof RdfFetchError && (e.status === 404 || e.status === 403)) return [];
      throw e;
    }
    const candidates = entries.filter(
      (entry) => !entry.url.endsWith("/") && this.isInContainer(entry.url),
    );
    const parsed = await Promise.all(
      candidates.map(async (entry) => {
        try {
          const { dataset } = await readResource(entry.url, this.fetchImpl);
          return parseMessage(entry.url, dataset);
        } catch {
          return undefined;
        }
      }),
    );
    return sortMessages(parsed.filter((m): m is ChatMessage => m !== undefined));
  }

  /** Boolean form of the scope guard (read path: skip, don't throw). */
  private isInContainer(url: string): boolean {
    try {
      this.assertInContainer(url);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Append a message: create-only PUT of a new resource in the chat container
   * (never overwrites). Returns the new message URL.
   */
  async send(content: string): Promise<{ url: string }> {
    const trimmed = content.trim();
    if (!trimmed) throw new ChatMessageError("A chat message cannot be empty.");
    const rand = Math.random().toString(36).slice(2, 10);
    const url = `${this.containerUrl}${Date.now()}-${rand}.ttl`;
    this.assertInContainer(url);
    const dataset = buildMessage(url, { author: this.webId, content: trimmed });
    await writeResource(url, dataset, {
      createOnly: true,
      fetchImpl: this.fetchImpl,
      prefixes: PREFIXES,
    });
    return { url };
  }

  /** Whether the bound container is within the user's own pods. */
  get inScope(): boolean {
    return isInOwnPods(this.containerUrl, this.storages);
  }
}

/**
 * Open a chat at a container URL, enforcing the same-pod scope guard FIRST.
 *
 * @throws ChatScopeError when `containerUrl` is not within any of the user's own
 *   pods (a confused-deputy guard on a `?url=` param — never read/write an
 *   arbitrary container with the user's credentials).
 */
export function openChat(opts: {
  containerUrl: string;
  storages: readonly string[];
  webId: string;
  fetchImpl?: typeof fetch;
}): Chat {
  const normalised = opts.containerUrl.endsWith("/") ? opts.containerUrl : `${opts.containerUrl}/`;
  if (!isInOwnPods(normalised, opts.storages)) {
    throw new ChatScopeError(normalised, opts.storages.join(", "));
  }
  return new Chat(normalised, opts.storages, opts.webId, opts.fetchImpl);
}
