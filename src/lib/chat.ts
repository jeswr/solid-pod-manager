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
import { isValidTargetUrl, noFollowFetch } from "./agent-target.js";
import { getNativeFetch } from "./native-fetch.js";
import { isLongChatDocument, parseLongChatMessages } from "./longchat.js";

const SIOC = "http://rdfs.org/sioc/ns#";
const DCT = "http://purl.org/dc/terms/";
const FOAF = "http://xmlns.com/foaf/0.1/";
const AS = "https://www.w3.org/ns/activitystreams#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** The RDF class a chat message is stamped with. */
export const MESSAGE_CLASS = `${SIOC}Note`;
/** Root slug under the pod for chats. */
export const CHAT_SLUG = "chat/";

/**
 * FEATURE GATE — foreign-origin READ-ONLY chat interop (a SolidOS
 * `meeting:LongChat` channel hosted on a THIRD-PARTY pod). UNSET (the default)
 * means a non-own-pod `?url=` is blocked exactly as before; set
 * `NEXT_PUBLIC_FOREIGN_CHAT_READ=1` at build to allow it (read-only, native
 * fetch, SSRF-guarded). On-pod `meeting:LongChat` reading is ALWAYS on (no gate)
 * — it is same-pod and uses the normal auth path. Spelled as a direct
 * `process.env.NEXT_PUBLIC_*` read so Next inlines it in the static export.
 */
export const FOREIGN_CHAT_READ_ENABLED =
  (process.env.NEXT_PUBLIC_FOREIGN_CHAT_READ ?? "") !== "";

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

/** How a chat container is read/written. */
export type ChatKind =
  /** PM's native `sioc:Note` per-resource append-only log — read AND write. */
  | "native"
  /** A SolidOS `meeting:LongChat` channel — READ-ONLY interop (never written). */
  | "longchat";

/**
 * A chat bound to a specific container URL + the active session's storages.
 * Construct via {@link openChat}, which enforces the scope guard on the
 * (possibly caller-supplied) container URL BEFORE any I/O.
 *
 * READ-ONLY interop: a chat may be flagged `readOnly` — either because it is a
 * FOREIGN-origin channel (read with the pristine native fetch, never the
 * auth-patched global) or because its on-pod shape is a SolidOS
 * `meeting:LongChat` channel (which PM reads but never writes — PM's native
 * `sioc:Note` model stays the sole write model). `send` on a read-only chat
 * throws; the UI hides the compose box.
 */
export class Chat {
  /**
   * Set once {@link messages} has detected the on-the-wire shape: `"longchat"`
   * for a SolidOS `meeting:LongChat` channel, `"native"` for PM's own model.
   * `undefined` until the first read. Drives the read-only compose guard for an
   * on-pod LongChat channel (a foreign chat is read-only from construction).
   */
  detectedKind?: ChatKind;

  constructor(
    readonly containerUrl: string,
    private readonly storages: readonly string[],
    private readonly webId: string,
    private readonly fetchImpl?: typeof fetch,
    /**
     * A FOREIGN-origin channel: read-only, and read with the pristine native
     * fetch (the auth-patched global must never reach a third-party pod).
     */
    private readonly foreign: boolean = false,
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

  /**
   * The fetch to use for READS. A FOREIGN-origin chat MUST use the pristine
   * native fetch (captured before the auth patch) so the auth layer never
   * re-issues with the user's DPoP/bearer credentials against a third-party pod;
   * wrapped to refuse redirects so a foreign host can't 3xx the read onto a
   * private origin. A same-pod chat uses the normal (auth-patched) path. A
   * test-supplied `fetchImpl` always wins.
   *
   * FAIL CLOSED: for a foreign chat with NO captured native fetch (would only
   * happen in a non-browser/SSR context, where `getNativeFetch()` is undefined),
   * we throw rather than silently fall back to the (possibly auth-patched) global
   * — a foreign read must never risk attaching the user's pod credentials.
   */
  private get readFetch(): typeof fetch | undefined {
    if (this.fetchImpl) return this.fetchImpl;
    if (this.foreign) {
      const native = getNativeFetch();
      if (!native) {
        throw new ChatScopeError(this.containerUrl, "no pristine fetch for a foreign read");
      }
      return noFollowFetch(native);
    }
    return undefined; // same-pod: the auth-patched global fetch
  }

  /**
   * True when this chat must be read-only: a foreign-origin channel (always) or
   * an on-pod channel detected as a SolidOS `meeting:LongChat` (PM never writes
   * that shape). Native same-pod chats are writable.
   */
  get readOnly(): boolean {
    return this.foreign || this.detectedKind === "longchat";
  }

  /**
   * List + parse all messages, oldest→newest. Missing container → empty.
   *
   * DETECT-AND-READ: first probe the channel's index document. If it is typed
   * `mee:LongChat`, parse via the SolidOS long-chat shape (read-only) — reading
   * the channel index AND any dated chat files (`YYYY/MM/DD/chat.ttl`) under the
   * container. Otherwise use PM's native per-resource reader (`sioc:Note`).
   */
  async messages(): Promise<ChatMessage[]> {
    // Probe the index document. A foreign container's index is fetched with the
    // native fetch (via readFetch); a same-pod container uses the auth path.
    //
    // FAIL CLOSED on an AMBIGUOUS probe (roborev findings, High/Medium): ONLY a
    // `404` is unambiguous — the index resource is genuinely ABSENT, so this is
    // PM's native model (no channel doc). EVERYTHING ELSE is ambiguous and must
    // fail closed:
    //   - `403` does NOT mean "no index": the index COULD exist and be unreadable
    //     to us. A SolidOS `meeting:LongChat` with read-denied-but-APPEND-allowed
    //     access (acl:Append) would 403 the GET yet accept a PUT — so downgrading
    //     a 403 to native would let `send()` corrupt a real LongChat channel.
    //   - a transient 5xx / malformed Turtle / network error is likewise a
    //     channel we FAILED to read, not a channel that ISN'T a long-chat.
    // In all those cases we re-throw — the caller surfaces an error + retries; we
    // never classify an unreadable channel as writable native.
    let indexDataset: import("@rdfjs/types").DatasetCore | undefined;
    try {
      ({ dataset: indexDataset } = await readResource(this.indexUrl, this.readFetch));
    } catch (e) {
      if (e instanceof RdfFetchError && e.status === 404) {
        // Unambiguous: no index document exists → PM's native model.
        indexDataset = undefined;
      } else {
        // Ambiguous (403 / 5xx / parse / network) → fail closed, NOT native.
        throw e;
      }
    }

    if (indexDataset && isLongChatDocument(indexDataset)) {
      this.detectedKind = "longchat";
      return this.readLongChat(indexDataset);
    }
    this.detectedKind = "native";
    return this.readNative();
  }

  /** The channel's index document URL (the LongChat channel metadata lives here). */
  private get indexUrl(): string {
    return `${this.containerUrl}index.ttl`;
  }

  /**
   * Read a SolidOS `meeting:LongChat` channel READ-ONLY. Reads the channel index
   * (already fetched) plus any dated chat files (`.ttl`) found by listing the
   * container tree (bounded depth — `YYYY/MM/DD/`), then parses all message
   * nodes via the typed long-chat accessors. Edits collapse to latest, deletions
   * render as tombstones. Foreign reads go through the native fetch.
   */
  private async readLongChat(
    indexDataset: import("@rdfjs/types").DatasetCore,
  ): Promise<ChatMessage[]> {
    const datasets: import("@rdfjs/types").DatasetCore[] = [indexDataset];
    // Collect dated chat files under the container (bounded: container →
    // YYYY → MM → DD → chat.ttl). A foreign listing uses the native fetch.
    const fileUrls = await this.collectLongChatFiles();
    const more = await Promise.all(
      fileUrls.map(async (url) => {
        try {
          const { dataset } = await readResource(url, this.readFetch);
          return dataset;
        } catch (e) {
          // PARTIAL-READ guard (roborev finding, Medium): a `404` is benign — the
          // file was LISTED but vanished between listing and read (a delete race),
          // so an absent message file is correctly empty. But a 403 / 5xx / parse
          // / network error means we FAILED to read a file that DOES exist —
          // silently dropping it would render an INCOMPLETE conversation as if it
          // were complete. For a read-only history view that is a correctness bug,
          // so we propagate: the SWR hook surfaces the error (and keeps the last
          // good cached render), rather than showing a deceptively short history.
          if (e instanceof RdfFetchError && e.status === 404) return undefined;
          throw e;
        }
      }),
    );
    for (const ds of more) if (ds) datasets.push(ds);
    return parseLongChatMessages(datasets);
  }

  /**
   * List the dated chat-file URLs under the channel container, STRICTLY matching
   * the documented SolidOS path convention `YYYY/MM/DD/chat.ttl` (roborev
   * finding, Medium). We descend ONLY into directories whose name is the
   * expected zero-padded date component for the current depth
   * (`\d{4}` → `\d{2}` → `\d{2}`) and collect ONLY a leaf file named exactly
   * `chat.ttl`. This prevents an UNRELATED Turtle document anywhere under the
   * channel subtree (which `parseLongChatMessages` would otherwise happily read
   * if it carried message-shaped triples) from being rendered as chat history.
   *
   * Bounded against a deep/wide/cyclic tree by depth (3) + a file cap. Only
   * same-origin descendants of the container are followed; foreign listings go
   * through the native fetch.
   */
  private async collectLongChatFiles(): Promise<string[]> {
    const MAX_FILES = 366; // a year of daily files — generous, but bounded
    // The relative directory-name pattern expected at each descent step.
    const DIR_PATTERN = [/^\d{4}$/, /^\d{2}$/, /^\d{2}$/]; // YYYY / MM / DD
    const CHAT_FILE = "chat.ttl";
    const out: string[] = [];
    let frontier: string[] = [this.containerUrl];
    for (let depth = 0; depth < DIR_PATTERN.length && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const dir of frontier) {
        let entries: { url: string; isContainer: boolean }[];
        try {
          entries = await listContainer(dir, this.readFetch);
        } catch (e) {
          // PARTIAL-READ guard (roborev finding, Medium): a `404` listing means
          // the date directory was removed between discovery and listing (a
          // benign race) — skip it. But a 403 / 5xx / parse / network error means
          // a directory that EXISTS could not be listed, so we may be MISSING its
          // dated files — silently continuing would render an incomplete history
          // as complete. Propagate so the read fails closed, mirroring the
          // dated-file read guard.
          if (e instanceof RdfFetchError && e.status === 404) continue;
          throw e;
        }
        for (const entry of entries) {
          if (!entry.isContainer || !this.isUnderContainer(entry.url)) continue;
          const name = this.lastSegment(entry.url);
          if (DIR_PATTERN[depth].test(name)) next.push(entry.url);
        }
      }
      frontier = next;
    }
    // `frontier` now holds the `YYYY/MM/DD/` leaf containers — collect each one's
    // `chat.ttl` (and only that file).
    for (const dir of frontier) {
      const fileUrl = `${dir}${CHAT_FILE}`;
      if (this.isUnderContainer(fileUrl) && out.length < MAX_FILES) out.push(fileUrl);
    }
    return out;
  }

  /** The final path segment of a (container or file) URL, decoded; `""` on parse error. */
  private lastSegment(url: string): string {
    try {
      const path = new URL(url).pathname.replace(/\/$/, "");
      const seg = path.slice(path.lastIndexOf("/") + 1);
      return decodeURIComponent(seg);
    } catch {
      return "";
    }
  }

  /** PM's native reader: one `sioc:Note` resource per message, direct children only. */
  private async readNative(): Promise<ChatMessage[]> {
    let entries: { url: string }[];
    try {
      entries = await listContainer(this.containerUrl, this.readFetch);
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
          const { dataset } = await readResource(entry.url, this.readFetch);
          return parseMessage(entry.url, dataset);
        } catch {
          return undefined;
        }
      }),
    );
    return sortMessages(parsed.filter((m): m is ChatMessage => m !== undefined));
  }

  /** Boolean form of the direct-child scope guard (read path: skip, don't throw). */
  private isInContainer(url: string): boolean {
    try {
      this.assertInContainer(url);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * True iff `url` is a same-origin DESCENDANT of the chat container (any depth)
   * — used to bound the dated-file walk to the channel's own subtree. Looser than
   * {@link assertInContainer} (which requires a DIRECT child) because long-chat
   * files are nested under `YYYY/MM/DD/`.
   */
  private isUnderContainer(url: string): boolean {
    let parsed: URL;
    let container: URL;
    try {
      parsed = new URL(url);
      container = new URL(this.containerUrl);
    } catch {
      return false;
    }
    const containerPath = container.pathname.endsWith("/")
      ? container.pathname
      : `${container.pathname}/`;
    return (
      parsed.origin === container.origin &&
      parsed.pathname.startsWith(containerPath) &&
      parsed.pathname !== containerPath
    );
  }

  /**
   * Append a message: create-only PUT of a new resource in the chat container
   * (never overwrites). Returns the new message URL.
   *
   * WRITE GUARD — FAIL CLOSED (roborev finding, High): PM's native `sioc:Note`
   * model is the SOLE write model; we never author the long-chat shape or
   * cross-pod write. A write is permitted ONLY when the channel is EXPLICITLY
   * classified `"native"` (and not foreign). Crucially, `detectedKind` is unset
   * until the first read, so we must NOT treat "not yet detected" as writable —
   * before any read (or after an ambiguous probe), a channel could be a SolidOS
   * `meeting:LongChat`, and writing a native message into it would corrupt it.
   * So if the kind is unknown we DETECT first (run the same index probe
   * `messages()` uses) and proceed only if it resolves to native — a fresh read
   * before the mutation (the read-fresh-before-write rule), never the cached
   * snapshot. A foreign chat is rejected outright (never even probed for write).
   */
  async send(content: string): Promise<{ url: string }> {
    // Pure input validation first — an empty message never needs a network probe.
    const trimmed = content.trim();
    if (!trimmed) throw new ChatMessageError("A chat message cannot be empty.");
    if (this.foreign) {
      throw new ChatMessageError(
        "This chat is read-only (external chat). Messages can be viewed but not sent from here.",
      );
    }
    // Detect the shape if we haven't yet (fail-closed: an undetected channel is
    // NOT assumed writable). messages() sets detectedKind via the index probe and
    // fails closed on an ambiguous read.
    if (this.detectedKind === undefined) {
      await this.messages();
    }
    if (this.detectedKind !== "native") {
      throw new ChatMessageError(
        "This chat is read-only (external chat). Messages can be viewed but not sent from here.",
      );
    }
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
 * Normalise a possibly-document `?url=` into its CONTAINER URL. A SolidOS
 * `meeting:LongChat` is often pointed at via its channel document
 * (`…/index.ttl` or `…/index.ttl#this`) rather than the bare container, so strip
 * any fragment/query, drop a trailing `index.ttl` (or any non-slash final
 * segment), and ensure a trailing slash. Returns `undefined` for a non-http(s)
 * or unparseable URL.
 */
export function chatContainerFromUrl(raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  u.hash = "";
  u.search = "";
  let path = u.pathname;
  if (!path.endsWith("/")) {
    const slash = path.lastIndexOf("/");
    const lastSegment = slash >= 0 ? path.slice(slash + 1) : path;
    // A final segment with a FILE EXTENSION (e.g. `index.ttl`) is the channel
    // DOCUMENT — drop it to reach the container. A bare segment (e.g. `team`) is
    // the container the user means — just add the trailing slash.
    if (/\.[^./]+$/.test(lastSegment)) {
      path = slash >= 0 ? path.slice(0, slash + 1) : "/";
    } else {
      path = `${path}/`;
    }
  }
  u.pathname = path;
  return u.toString();
}

/**
 * Open a chat at a container URL.
 *
 * SCOPE: a chat within one of the user's OWN pods is opened on the normal
 * (auth-patched) path and is read/write for the native model, read-only for a
 * detected `meeting:LongChat`. A FOREIGN-origin channel (`allowForeign:true`) is
 * opened READ-ONLY on the pristine native fetch (the auth-patched global must
 * never reach a third-party pod), and only if it passes the strict SSRF/outbound
 * host validator (https, no credentials, no private/loopback/metadata host).
 *
 * @throws ChatScopeError when `containerUrl` is neither within the user's own
 *   pods nor an allowed, validated foreign origin (a confused-deputy guard on a
 *   `?url=` param — never read an arbitrary container with the user's
 *   credentials, never read an unsafe foreign host at all).
 */
export function openChat(opts: {
  containerUrl: string;
  storages: readonly string[];
  webId: string;
  fetchImpl?: typeof fetch;
  /** Allow a foreign-origin channel (read-only, native-fetch, SSRF-guarded). */
  allowForeign?: boolean;
}): Chat {
  const normalised = chatContainerFromUrl(opts.containerUrl);
  if (!normalised) {
    throw new ChatScopeError(opts.containerUrl, opts.storages.join(", "));
  }
  if (isInOwnPods(normalised, opts.storages)) {
    return new Chat(normalised, opts.storages, opts.webId, opts.fetchImpl);
  }
  // Not in the user's pods. Only proceed for an explicitly-allowed foreign
  // channel that passes the strict outbound validator; otherwise fail closed.
  if (opts.allowForeign && isValidTargetUrl(normalised)) {
    return new Chat(normalised, opts.storages, opts.webId, opts.fetchImpl, true);
  }
  throw new ChatScopeError(normalised, opts.storages.join(", "));
}
