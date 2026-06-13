// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * LDN Inbox (Feature 1) — read the user's OWN `ldp:inbox`, list + parse the
 * ActivityStreams 2.0 notifications it holds, and manage their read/dismiss
 * state. SENDING a notification is delegated to `notify-send.ts` (which owns the
 * SSRF-hardened cross-pod POST); this module is the SAME-POD read/manage side.
 *
 * Scope discipline (house rule / confused-deputy guard): the inbox is the user's
 * OWN container, so every read/write/delete is bounded to it — we validate that
 * each notification URL is a direct child of the discovered inbox container
 * (mirrors `productivity-store.assertInContainer`) before any authenticated I/O,
 * and we check the inbox itself is within the active storage (`isWithinPod`)
 * before listing. Read-state is a tiny SAME-POD sidecar; dismiss is a scoped
 * idempotent DELETE.
 *
 * RDF: parsed via typed `@rdfjs/wrapper` accessors (the `ActivityDoc` from
 * `notify-send.ts`), never regex on RDF. The UI consumes only the plain
 * {@link InboxNotification} shape.
 */
import { RdfFetchError } from "@jeswr/fetch-rdf";
import { LiteralFrom, NamedNodeFrom, OptionalAs, TermWrapper } from "@rdfjs/wrapper";
import { DataFactory, Store } from "n3";
import { ActivityDoc } from "./notify-send.js";
import { discoverInbox } from "./agent-target.js";
import { isWithinPod } from "./pod-scope.js";
import { deleteResource, listContainer, readResource, writeResource } from "./pod-data.js";
import { InboxScopeError } from "./errors.js";

const AS = "https://www.w3.org/ns/activitystreams#";
const PREFIXES = { as: AS } as const;

/** A notification as the inbox UI consumes it (plain, serialisable — no RDF). */
export interface InboxNotification {
  /** The notification resource URL (its inbox child). */
  url: string;
  /** `as:type` local name(s) joined (e.g. "Announce"), or "Notification". */
  type: string;
  /** `as:actor` — sender WebID, if present. */
  actor?: string;
  /** `as:object` IRI, if present. */
  object?: string;
  /** `as:target` IRI, if present. */
  target?: string;
  /** `as:summary`. */
  summary?: string;
  /** `as:content`. */
  content?: string;
  /** `as:published` as an ISO string (serialisable for client components). */
  published?: string;
  /** Whether a read-marker sidecar exists for this notification. */
  read: boolean;
}

/** Read the `as:type` local names from any AS2.0 activity subject (typed). */
function typeLabel(types: Set<string>): string {
  const locals = [...types]
    .filter((t) => t.startsWith(AS))
    .map((t) => t.slice(AS.length))
    .filter(Boolean);
  return locals.length > 0 ? locals.join(", ") : "Notification";
}

/**
 * Parse a notification document into an {@link InboxNotification}, or `undefined`
 * if it carries no recognisable AS2.0 activity. The activity subject is found by
 * scanning for any subject that has an `as:*` type or an `as:actor` — LDN
 * payloads vary in their subject IRI (often the document itself or a `#it`).
 */
export function parseInboxNotification(
  url: string,
  dataset: import("@rdfjs/types").DatasetCore,
  read = false,
): InboxNotification | undefined {
  const subject = findActivitySubject(url, dataset);
  if (!subject) return undefined;
  const doc = new ActivityDoc(subject, dataset, DataFactory);
  return {
    url,
    type: typeLabel(doc.types),
    actor: doc.actor,
    object: doc.activityObject,
    target: doc.target,
    summary: doc.summary,
    content: doc.content,
    published: doc.published?.toISOString(),
    read,
  };
}

/**
 * Locate the activity subject IRI within a notification dataset: the first
 * subject carrying an `as:` rdf:type, else the first subject with an `as:actor`.
 * Falls back to the conventional `${url}#it`. Pure.
 */
function findActivitySubject(
  url: string,
  dataset: import("@rdfjs/types").DatasetCore,
): string | undefined {
  const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
  for (const q of dataset.match(null, DataFactory.namedNode(RDF_TYPE), null)) {
    if (q.object.termType === "NamedNode" && q.object.value.startsWith(AS)) {
      return q.subject.value;
    }
  }
  for (const q of dataset.match(null, DataFactory.namedNode(`${AS}actor`), null)) {
    return q.subject.value;
  }
  // No activity markers at all → try the conventional subject so a bare payload
  // still parses to a (typeless) notification rather than vanishing.
  const itUrl = `${url}#it`;
  const it = new ActivityDoc(itUrl, dataset, DataFactory);
  if (it.actor || it.summary || it.content) return itUrl;
  return undefined;
}

/**
 * Per-notification read-marker sidecar (a tiny same-pod doc next to the item).
 * This suffix is RESERVED: a member ending in `.read.ttl` is treated as a
 * sidecar (not surfaced as a notification). Read-state is derived from sidecar
 * EXISTENCE; the `as:read` triple it carries is descriptive provenance, not the
 * source of truth, so we never need to read it back.
 */
const READ_MARKER_SUFFIX = ".read.ttl";
const READ_PREDICATE = `${AS}read`;

/** The sidecar URL for a notification's read-marker (same container, scoped). */
function readMarkerUrl(notificationUrl: string): string {
  return `${notificationUrl}${READ_MARKER_SUFFIX}`;
}

/**
 * An inbox bound to the active session. Construct via {@link inboxFor}.
 * Production callers pass NO `fetchImpl`; tests inject one.
 */
export class Inbox {
  constructor(
    readonly inboxUrl: string,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  /**
   * Fail closed unless `url` is a direct child resource of THIS inbox container
   * (same scope guard as the productivity store). A read-marker sidecar
   * (`<item>.read.ttl`) is a valid child too. Rejects the container itself, any
   * sub-container, a query/fragment, and anything outside the inbox.
   */
  /** Boolean form of {@link assertInInbox} for the read path (skip, don't throw). */
  private isInInbox(url: string): boolean {
    try {
      this.assertInInbox(url);
      return true;
    } catch {
      return false;
    }
  }

  private assertInInbox(url: string): void {
    let parsed: URL;
    let container: URL;
    try {
      parsed = new URL(url);
      container = new URL(this.inboxUrl);
    } catch {
      throw new InboxScopeError(url, this.inboxUrl);
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
      throw new InboxScopeError(url, this.inboxUrl);
    }
    const rest = parsed.pathname.slice(containerPath.length);
    const isDirectChild = rest.length > 0 && !rest.includes("/") && !/%2f/i.test(rest);
    if (!isDirectChild) throw new InboxScopeError(url, this.inboxUrl);
  }

  /**
   * List + parse the notifications in the inbox. Read-marker sidecars are not
   * listed as notifications; instead each notification's read-state is resolved
   * from its sidecar (best-effort). Unreadable/non-AS2.0 items are skipped.
   * A missing inbox (404/403) lists as empty.
   */
  async list(): Promise<InboxNotification[]> {
    let entries: { url: string }[];
    try {
      entries = await listContainer(this.inboxUrl, this.fetchImpl);
    } catch (e) {
      if (e instanceof RdfFetchError && (e.status === 404 || e.status === 403)) return [];
      throw e;
    }
    const markerUrls = new Set(
      entries.filter((e) => e.url.endsWith(READ_MARKER_SUFFIX)).map((e) => e.url),
    );
    const candidates = entries.filter(
      (entry) =>
        !entry.url.endsWith("/") && // sub-container
        !entry.url.endsWith(READ_MARKER_SUFFIX) && // a sidecar, not a notification
        // Defence-in-depth: apply the same scope guard to the READ path — never
        // dereference a URL that isn't a direct child of this inbox, even if
        // ldp:contains advertises it (a crafted/compromised listing must not
        // steer an authenticated GET off-target).
        this.isInInbox(entry.url),
    );
    // Fetch + parse the candidates in parallel; a single failing item resolves to
    // `undefined` (skipped) rather than failing the whole list.
    const parsed = await Promise.all(
      candidates.map(async (entry) => {
        try {
          const { dataset } = await readResource(entry.url, this.fetchImpl);
          const read = markerUrls.has(readMarkerUrl(entry.url));
          return parseInboxNotification(entry.url, dataset, read);
        } catch {
          return undefined;
        }
      }),
    );
    const out = parsed.filter((n): n is InboxNotification => n !== undefined);
    // Newest first; a stable secondary key on url keeps undated items
    // deterministic. ISO-8601 UTC strings are lexicographically ordered, so we
    // use plain relational comparison (not locale-sensitive localeCompare).
    return out.sort((a, b) => {
      const pa = a.published ?? "";
      const pb = b.published ?? "";
      if (pa !== pb) return pa < pb ? 1 : -1; // descending (newest first)
      return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
    });
  }

  /**
   * Mark a notification read by writing a tiny same-pod sidecar next to it.
   * Idempotent (overwrites). Scope-guarded on both the notification URL and the
   * derived sidecar URL.
   */
  async markRead(notificationUrl: string): Promise<void> {
    this.assertInInbox(notificationUrl);
    const sidecar = readMarkerUrl(notificationUrl);
    this.assertInInbox(sidecar);
    const store = new Store();
    const doc = new MutableReadMarker(`${sidecar}#it`, store, DataFactory);
    doc.markRead(notificationUrl);
    await writeResource(sidecar, store, { fetchImpl: this.fetchImpl, prefixes: PREFIXES });
  }

  /**
   * Dismiss a notification: DELETE the notification resource (idempotent), and
   * best-effort DELETE its read-marker sidecar. Scope-guarded.
   */
  async dismiss(notificationUrl: string): Promise<void> {
    this.assertInInbox(notificationUrl);
    await deleteResource(notificationUrl, this.fetchImpl);
    const sidecar = readMarkerUrl(notificationUrl);
    try {
      this.assertInInbox(sidecar);
      await deleteResource(sidecar, this.fetchImpl);
    } catch {
      // Sidecar may not exist / out of scope — dismiss already succeeded.
    }
  }
}

/**
 * A writable read-marker doc: records `as:read true` plus an `as:object` linking
 * back to the notification it marks. Written via TYPED `@rdfjs/wrapper`
 * accessors (house rule: never inline `DataFactory.quad` / hand-build triples).
 */
class MutableReadMarker extends TermWrapper {
  set read(v: boolean | undefined) {
    OptionalAs.object(this, READ_PREDICATE, v, LiteralFrom.boolean);
  }
  /** `as:object` — the notification this marker refers to. */
  set marks(v: string | undefined) {
    OptionalAs.object(this, `${AS}object`, v, NamedNodeFrom.string);
  }
  markRead(notificationUrl: string): void {
    this.read = true;
    this.marks = notificationUrl;
  }
}

/**
 * Build an {@link Inbox} for the user's OWN inbox.
 *
 * Discovers the user's `ldp:inbox` from their profile, then — defence in depth —
 * asserts it is WITHIN the active storage before returning (the inbox must be
 * the user's own same-pod container; we never list/manage an off-pod inbox here,
 * even one advertised by the user's own profile). Returns `undefined` when no
 * inbox is advertised or it is out of the active pod.
 *
 * @param fetchImpl - test-only override; **omit in production** so the
 *   auth-patched global fetch runs.
 */
export async function inboxFor(opts: {
  webId: string;
  activeStorage: string;
  fetchImpl?: typeof fetch;
}): Promise<Inbox | undefined> {
  const inboxUrl = await discoverInbox(opts.webId, opts.fetchImpl);
  if (!inboxUrl) return undefined;
  // The OWN inbox must be inside the active pod (same-pod manage only).
  if (!isWithinPod(inboxUrl, opts.activeStorage)) return undefined;
  return new Inbox(inboxUrl, opts.fetchImpl);
}
