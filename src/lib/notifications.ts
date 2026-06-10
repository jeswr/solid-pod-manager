/**
 * Solid Notifications Protocol client — live-sync over the pod via the
 * **WebSocketChannel2023** channel (PM finding #3; the last open P3 item).
 *
 * All RDF/IO lives here in `src/lib` (house rule); the UI consumes only the
 * {@link subscribeToResource} callback API. Every step is a **progressive
 * enhancement**: discovery, subscription, and the socket each degrade SILENTLY
 * to a no-op when the server does not support notifications, returns an error,
 * or the connection drops (AGENTS.md / solid-notifications skill: "discover
 * support, never assume it"). Nothing here ever throws to the UI; failures log
 * at most `console.debug` and resolve to a no-op unsubscribe.
 *
 * Flow (Solid Notifications Protocol §discovery / §subscription):
 *   1. Discover the storage description from the topic's `Link` header
 *      (`rel="…solid/terms#storageDescription"`), or fall back to
 *      `/.well-known/solid` / the storage-root description.
 *   2. Parse it with typed `@rdfjs/wrapper` accessors (never regex on RDF) to
 *      find a `notify:subscription` service advertising
 *      `notify:WebSocketChannel2023`.
 *   3. POST a JSON-LD channel request; read `receiveFrom` from the response.
 *   4. Open a plain browser `WebSocket` on `receiveFrom` (it carries its own
 *      short-lived auth — the DPoP-patched `fetch` cannot patch a socket) and
 *      surface each notification to the caller.
 *
 * The subscription body and notification frames are **protocol messages, not
 * pod RDF**, so they are exempt from the typed-wrapper rule and use plain
 * `JSON` (solid-notifications skill). Only the storage *description* is RDF.
 */
import { fetchRdf, RdfFetchError } from "@jeswr/fetch-rdf";
import { DatasetWrapper, TermWrapper, SetFrom, NamedNodeAs, NamedNodeFrom } from "@rdfjs/wrapper";
import { DataFactory } from "n3";

/** The Solid notifications ontology namespace. */
const NOTIFY = "http://www.w3.org/ns/solid/notifications#";
/** The channel type this client speaks. */
export const WEBSOCKET_CHANNEL_2023 = `${NOTIFY}WebSocketChannel2023`;
/** The storage-description Link relation (Solid Protocol §4.1). */
const STORAGE_DESCRIPTION_REL = "http://www.w3.org/ns/solid/terms#storageDescription";
/** The JSON-LD context for a subscription request (notifications-protocol). */
const SUBSCRIPTION_CONTEXT = "https://www.w3.org/ns/solid/notification/v1";

/** A change notification surfaced to a subscriber. */
export interface ResourceChangeNotification {
  /** ActivityStreams activity type — `Create` / `Update` / `Delete` / `Add` / `Remove`. */
  type: string;
  /** The changed resource IRI (the member, for `Add`/`Remove`). May be undefined if absent. */
  object?: string;
}

/** Options for {@link subscribeToResource}. */
export interface SubscribeOptions {
  /**
   * Test-only fetch override. **Omit in production** so the auth-patched global
   * `fetch` runs (AGENTS.md §Reading data) — passing a fetch bypasses the
   * 401→login upgrade.
   */
  fetchImpl?: typeof fetch;
  /**
   * Test-only `WebSocket` constructor override. **Omit in production** so the
   * native browser `WebSocket` is used.
   */
  webSocketImpl?: typeof WebSocket;
}

/**
 * A node that describes notification subscription services — the storage
 * description's own subject, which carries `notify:subscription` (the service
 * URL) and `notify:channelType` (which channels that service offers). Read
 * through typed accessors (never regex/string-matching on RDF — house rule).
 *
 * Per the Solid Notifications Protocol / CSS / prod-solid-server, both
 * predicates hang off the *same* description subject; `notify:channelType`
 * advertises what the `notify:subscription` endpoint supports.
 */
class SubscriptionDescriptionNode extends TermWrapper {
  /** The subscription-service URL(s) advertised (`notify:subscription`). */
  get subscriptionServices(): Set<string> {
    return SetFrom.subjectPredicate(
      this,
      `${NOTIFY}subscription`,
      NamedNodeAs.string,
      NamedNodeFrom.string,
    );
  }

  /** The channel-type IRIs this description advertises (`notify:channelType`). */
  get channelTypes(): Set<string> {
    return SetFrom.subjectPredicate(
      this,
      `${NOTIFY}channelType`,
      NamedNodeAs.string,
      NamedNodeFrom.string,
    );
  }
}

/**
 * A storage-description document, wrapped whole. Finds the subscription
 * service(s) that support a given channel type.
 */
class StorageDescriptionDataset extends DatasetWrapper {
  /**
   * Every subscription-service IRI whose describing subject advertises the
   * given `channelType`. Returns the service URLs.
   *
   * Walks each subject of a `notify:subscription` triple as a
   * {@link SubscriptionDescriptionNode}; if that subject also advertises the
   * wanted `notify:channelType`, its subscription URLs qualify — all via typed
   * accessors, never regex on RDF.
   */
  subscriptionServicesFor(channelType: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const descriptions = this.matchSubjectsOf(
      SubscriptionDescriptionNode,
      DataFactory.namedNode(`${NOTIFY}subscription`),
    );
    for (const desc of descriptions) {
      if (!desc.channelTypes.has(channelType)) continue;
      for (const service of desc.subscriptionServices) {
        if (!seen.has(service)) {
          seen.add(service);
          out.push(service);
        }
      }
    }
    return out;
  }
}

/**
 * Discover a WebSocketChannel2023 subscription-service URL for a topic resource.
 *
 * Tries, in order: the topic's `Link: rel="storageDescription"` header; then
 * `/.well-known/solid` (capabilities doc); then the storage-root description.
 * Returns `undefined` on any failure (no support, network error, parse error) —
 * the caller treats `undefined` as "notifications unavailable", never an error.
 */
export async function discoverSubscriptionService(
  topicUrl: string,
  fetchImpl?: typeof fetch,
): Promise<string | undefined> {
  const doFetch = fetchImpl ?? fetch;
  const candidates: string[] = [];

  // 1. The topic's own storageDescription Link header (the spec's primary path).
  try {
    const head = await doFetch(topicUrl, { method: "HEAD" });
    const fromLink = storageDescriptionFromLinkHeader(head.headers.get("link"), topicUrl);
    if (fromLink) candidates.push(fromLink);
  } catch (e) {
    debug("HEAD for storage-description Link failed", e);
  }

  // 2. Conventional fallbacks (solid-notifications skill: discover, but tolerate
  //    servers that only expose the well-known / storage-root description).
  try {
    const origin = new URL(topicUrl).origin;
    candidates.push(new URL("/.well-known/solid/storage", origin).toString());
    candidates.push(new URL("/.well-known/solid", origin).toString());
  } catch (e) {
    debug("could not derive well-known fallbacks", e);
  }

  for (const descriptionUrl of dedupe(candidates)) {
    const service = await readSubscriptionService(descriptionUrl, fetchImpl);
    if (service) return service;
  }
  return undefined;
}

/**
 * Fetch + parse a storage-description document and return its first
 * WebSocketChannel2023 subscription-service URL, or `undefined`. The
 * `/.well-known/solid` capabilities doc is JSON-LD with a flat
 * `notificationGateway` shape, which `fetchRdf` parses as RDF just like the
 * Turtle storage description, so the same typed accessors find the service.
 */
async function readSubscriptionService(
  descriptionUrl: string,
  fetchImpl?: typeof fetch,
): Promise<string | undefined> {
  try {
    const { dataset } = await fetchRdf(
      descriptionUrl,
      fetchImpl ? { fetch: fetchImpl } : undefined,
    );
    const services = new StorageDescriptionDataset(dataset, DataFactory).subscriptionServicesFor(
      WEBSOCKET_CHANNEL_2023,
    );
    return services[0];
  } catch (e) {
    if (!(e instanceof RdfFetchError)) debug("storage-description read failed", e);
    return undefined;
  }
}

/**
 * Subscribe to change notifications for a topic resource.
 *
 * Discovers the subscription service, POSTs a JSON-LD channel request, and opens
 * the returned `receiveFrom` WebSocket; `onChange` fires for each notification.
 * Returns an **idempotent** unsubscribe that closes the socket and best-effort
 * `DELETE`s the channel. ANY failure (no support, 404, auth failure, malformed
 * response, `WebSocket` undefined in SSR/build) resolves to a no-op unsubscribe
 * — it never throws and never surfaces an error to the caller.
 */
export async function subscribeToResource(
  topicUrl: string,
  onChange: (n: ResourceChangeNotification) => void,
  opts: SubscribeOptions = {},
): Promise<() => void> {
  const noop = () => {};
  // SSR / build / non-browser: there is no WebSocket — degrade to a no-op.
  const WS = opts.webSocketImpl ?? (typeof WebSocket !== "undefined" ? WebSocket : undefined);
  if (!WS) return noop;

  const doFetch = opts.fetchImpl ?? fetch;

  try {
    const serviceUrl = await discoverSubscriptionService(topicUrl, opts.fetchImpl);
    if (!serviceUrl) {
      debug("no WebSocketChannel2023 subscription service for", topicUrl);
      return noop;
    }
    // Defence-in-depth: never POST our auth to an off-pod service URL.
    if (!sameOrigin(serviceUrl, topicUrl)) {
      debug("subscription service is off-origin, refusing", serviceUrl);
      return noop;
    }

    const subRes = await doFetch(serviceUrl, {
      method: "POST",
      headers: { "content-type": "application/ld+json" },
      body: JSON.stringify({
        "@context": SUBSCRIPTION_CONTEXT,
        type: WEBSOCKET_CHANNEL_2023,
        topic: topicUrl,
      }),
    });
    if (!subRes.ok) {
      debug("subscribe POST failed", subRes.status, topicUrl);
      return noop;
    }

    const channel: unknown = await subRes.json();
    const receiveFrom = readReceiveFrom(channel);
    // Only DELETE a channel id that lives on the same pod (else drop it).
    const rawChannelId = readChannelId(channel);
    const channelId = sameOrigin(rawChannelId, topicUrl) ? rawChannelId : undefined;
    if (!receiveFrom) {
      debug("subscription response had no receiveFrom", topicUrl);
      return noop;
    }
    // Defence-in-depth: never open a socket to an off-pod / non-ws endpoint.
    if (!isSocketForTopic(receiveFrom, topicUrl)) {
      debug("receiveFrom is off-host or not a ws(s) URL, refusing", receiveFrom);
      return noop;
    }

    let socket: WebSocket;
    try {
      socket = new WS(receiveFrom);
    } catch (e) {
      debug("WebSocket construction failed", e);
      return noop;
    }

    socket.addEventListener("message", (ev: MessageEvent) => {
      const parsed = parseNotification(ev.data);
      if (parsed) {
        try {
          onChange(parsed);
        } catch (e) {
          debug("onChange callback threw (swallowed)", e);
        }
      }
    });
    // Never throw on socket error — degradation is silent; the view keeps its
    // fetch-on-mount + manual-reload behaviour.
    socket.addEventListener("error", (e) => debug("notification socket error", e));

    let closed = false;
    return () => {
      if (closed) return; // idempotent
      closed = true;
      try {
        socket.close();
      } catch (e) {
        debug("socket close failed", e);
      }
      // Best-effort channel teardown — fire and forget, never await/throw.
      if (channelId) {
        Promise.resolve(doFetch(channelId, { method: "DELETE" })).catch((e) =>
          debug("channel DELETE failed", e),
        );
      }
    };
  } catch (e) {
    debug("subscribeToResource failed (degrading to no-op)", e);
    return noop;
  }
}

/** Parse a raw WebSocket message into a {@link ResourceChangeNotification}, or `undefined`. */
function parseNotification(data: unknown): ResourceChangeNotification | undefined {
  try {
    const text = typeof data === "string" ? data : String(data);
    const doc = JSON.parse(text) as Record<string, unknown>;
    const type = typeof doc.type === "string" ? doc.type : undefined;
    if (!type) return undefined;
    return { type, object: readObjectId(doc.object) };
  } catch (e) {
    debug("could not parse notification frame", e);
    return undefined;
  }
}

/** A notification `object` may be a string IRI or `{ id: string }`. */
function readObjectId(object: unknown): string | undefined {
  if (typeof object === "string") return object;
  if (object && typeof object === "object" && typeof (object as { id?: unknown }).id === "string") {
    return (object as { id: string }).id;
  }
  return undefined;
}

/** Read `receiveFrom` from a subscription response (a plain JSON-LD object). */
function readReceiveFrom(channel: unknown): string | undefined {
  if (channel && typeof channel === "object") {
    const v = (channel as { receiveFrom?: unknown }).receiveFrom;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** Read the channel `id` from a subscription response (for best-effort DELETE). */
function readChannelId(channel: unknown): string | undefined {
  if (channel && typeof channel === "object") {
    const v = (channel as { id?: unknown }).id;
    if (typeof v === "string" && v.startsWith("http")) return v;
  }
  return undefined;
}

/**
 * Extract the storage-description target from an HTTP `Link` header. Resolves a
 * relative target against the resource URL. Returns `undefined` if absent.
 *
 * `Link` is a structured HTTP header, not RDF, so header parsing (not the
 * typed-wrapper rule) applies here.
 */
function storageDescriptionFromLinkHeader(
  header: string | null,
  baseUrl: string,
): string | undefined {
  if (!header) return undefined;
  for (const part of splitLinkHeader(header)) {
    const match = /^<([^>]*)>\s*;\s*(.*)$/.exec(part.trim());
    if (!match) continue;
    const [, target, params] = match;
    if (relMatches(params, STORAGE_DESCRIPTION_REL)) {
      try {
        return new URL(target, baseUrl).toString();
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Whether a Link param string declares `rel` equal to the given relation IRI. */
function relMatches(params: string, rel: string): boolean {
  const m = /rel\s*=\s*"?([^";]+)"?/i.exec(params);
  if (!m) return false;
  // rel may be a space-separated list of relation types.
  return m[1]
    .split(/\s+/)
    .map((r) => r.trim())
    .includes(rel);
}

/** Split a `Link` header on commas that separate entries (not inside `<…>`). */
function splitLinkHeader(header: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of header) {
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Confused-deputy guard (defence-in-depth, security review): the subscription
 * service, `receiveFrom` socket, and channel `id` are all read from a
 * server-controlled storage description / subscription response, then hit with
 * the user's auth. Even though the topic is always the user's own pod, a
 * compromised description could point these at another origin and leak a DPoP
 * token (the patched fetch signs a proof bound to whatever URL it retries). So
 * we require every notification endpoint to share the topic's origin — the same
 * invariant `pod-scope.ts#isWithinPod` enforces for resource reads.
 */
function sameOrigin(candidate: string | undefined, base: string): boolean {
  if (!candidate) return false;
  try {
    return new URL(candidate).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/**
 * A `receiveFrom` URL is only acceptable if it is a `ws:`/`wss:` socket whose
 * host+port match the topic's (a WebSocket URL has a distinct scheme, so it
 * can't share `origin` with an https: topic — compare host instead).
 */
function isSocketForTopic(receiveFrom: string | undefined, topicUrl: string): boolean {
  if (!receiveFrom) return false;
  try {
    const ws = new URL(receiveFrom);
    const topic = new URL(topicUrl);
    return (ws.protocol === "ws:" || ws.protocol === "wss:") && ws.host === topic.host;
  } catch {
    return false;
  }
}

/** Log a degradation at `console.debug` only — notifications never surface errors. */
function debug(...args: unknown[]): void {
  if (typeof console !== "undefined" && typeof console.debug === "function") {
    console.debug("[notifications]", ...args);
  }
}
