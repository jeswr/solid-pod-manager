// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * WebID-index consumer client — a thin, framework-agnostic client over the
 * `solid-webid-index` Linked-Data surfaces (`/search`, `/lookup`,
 * `/.well-known/health`, the LDN suggest inbox), turning the index's RDF
 * responses into UI-ready plain objects so the Pod Manager's people/contacts
 * search can consume it.
 *
 * VENDORED COPY. The canonical source lives in `jeswr/solid-webid-index`
 * (`src/lib/client/{index,types,indexClient}.ts`, main @ 166f1ff). That repo is
 * `private: true` with no package `exports` map, so it is not yet
 * GitHub-installable as `solid-webid-index/client`; until it publishes that
 * surface, this is a minimal typed mirror. Keep it in sync with the source on
 * any client change there (the maintenance rule). When solid-webid-index ships
 * an importable `./client` export, replace this file with a re-export.
 *
 * SECURITY POSTURE (consumer side): this client only ever talks to ITS OWN
 * configured index origin (`origin`), never arbitrary URLs, so the SSRF surface
 * is narrow. Two defensive guards still apply, mirroring the source:
 *   1. {@link IndexClient.fetchPage} REJECTS any `next` URL whose origin differs
 *      from the configured index origin (a malicious `hydra:next` cannot
 *      redirect a consuming app to a third-party host).
 *   2. Extracted `foaf:img` photo URLs are rejected unless `https:` (a
 *      `javascript:`/`data:` URL never reaches the consuming UI's <img src>).
 * Every request is `credentials: "omit"`, so the Pod Manager's DPoP/cookie auth
 * is NEVER attached to the third-party index origin. The injectable `fetch` MUST
 * NOT be an authenticated/credentialed fetch — index reads are public and the
 * suggest POST is unauthenticated cross-origin (pass the bare global `fetch`).
 */

import { parseRdf } from "@jeswr/fetch-rdf";
import type { DatasetCore, Quad, Term } from "@rdfjs/types";
import { DataFactory } from "n3";

const { namedNode } = DataFactory;

// ─── Public types (mirrors solid-webid-index/src/lib/client/types.ts) ─────────

/** A single search/index entry, projected from the Hydra collection RDF. */
export interface IndexEntry {
  /** The upstream WebID IRI (the agent's canonical identity). */
  webid: string;
  /** Best-effort display name (foaf:name), or null when no label. */
  name: string | null;
  /** Avatar/photo URL — only an `https:` URL survives; else null. */
  photoUrl: string | null;
  /** `dcterms:modified` (last-crawled) as an ISO-8601 string, or null. */
  modified: string | null;
}

/** One page of search results, plus the opaque cursor to fetch the next page. */
export interface IndexPage {
  /** The entries on this page. */
  entries: IndexEntry[];
  /**
   * The OPAQUE `hydra:next` URL for the following page, or null when last.
   * Clients MUST treat this as opaque and pass it verbatim to
   * {@link IndexClient.fetchPage} — never reconstruct it (keyset pagination).
   */
  next: string | null;
}

/** Liveness snapshot from `GET /.well-known/health`. */
export interface IndexHealth {
  /** "ok" when the store responded; "degraded" when the DB was unreachable. */
  status: "ok" | "degraded";
  /** Number of served WebID entries (void:entities). */
  entries: number;
  /** Total served triples (void:triples). */
  triples: number;
  /** Live crawl frontier depth (pending + claimed). */
  queueDepth: number;
  /** The index build version string. */
  version: string;
}

/** The outcome of a {@link IndexClient.suggestWebId} call. */
export type SuggestOutcome =
  | "submitted" // 201/202 — newly accepted (or accepted, crawl pending)
  | "already-indexed" // 200/409 — already known / tombstoned
  | "invalid" // 400/415/422 — malformed or not a WebID-shaped IRI
  | "rate-limited" // 429 — too many suggestions; retry later
  | "error"; // 5xx / network — transient, safe to retry

/** Options accepted by the client factory. */
export interface IndexClientOptions {
  /**
   * The canonical origin of the index deployment. A trailing slash is stripped.
   * When empty/undefined the whole client is INERT — {@link createIndexClient}
   * returns `null` so a consuming app can gate the whole integration on one env
   * var (`NEXT_PUBLIC_WEBID_INDEX`).
   */
  origin: string;
  /**
   * The `fetch` implementation. Injectable so tests can stub it. NEVER pass an
   * authenticated/credentialed fetch — a user's DPoP token must never be
   * attached to the third-party index origin. Defaults to the global `fetch`.
   */
  fetch?: typeof globalThis.fetch;
  /** Optional AbortSignal forwarded to every request (cancellation). */
  signal?: AbortSignal;
}

/** Options for a single search call. */
export interface SearchOptions {
  /** Page size hint forwarded as `?limit=` (the server clamps it). */
  limit?: number;
  /** Per-call AbortSignal (overrides the client-level signal for this call). */
  signal?: AbortSignal;
}

/** Options for a suggest call. */
export interface SuggestOptions {
  /** The suggesting user's WebID, recorded as the AS2 `actor` (provenance). */
  actor?: string;
  /** Per-call AbortSignal. */
  signal?: AbortSignal;
}

// ─── Vocabulary IRIs ─────────────────────────────────────────────────────────

const HYDRA = "http://www.w3.org/ns/hydra/core#";
const FOAF = "http://xmlns.com/foaf/0.1/";
const DCT = "http://purl.org/dc/terms/";

/** The AS2 context IRI — the `@context` of the suggest Announce body. */
const AS2_CONTEXT_IRI = "https://www.w3.org/ns/activitystreams";

const HYDRA_MEMBER = `${HYDRA}member`;
const HYDRA_VIEW = `${HYDRA}view`;
const HYDRA_NEXT = `${HYDRA}next`;
const FOAF_NAME = `${FOAF}name`;
const FOAF_IMG = `${FOAF}img`;
const DCT_MODIFIED = `${DCT}modified`;

/** The Accept header for RDF reads — Turtle preferred (the index's default). */
const RDF_ACCEPT =
  "text/turtle, application/ld+json;q=0.9, application/n-triples;q=0.8";

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Iterate quads with a given predicate IRI via RDF/JS match (never key access). */
function matchP(dataset: DatasetCore, predicate: string): Iterable<Quad> {
  return dataset.match(null, namedNode(predicate), null, null) as Iterable<Quad>;
}

/** Iterate quads with a given subject + predicate. */
function matchSP(dataset: DatasetCore, subject: Term, predicate: string): Iterable<Quad> {
  return dataset.match(subject, namedNode(predicate), null, null) as Iterable<Quad>;
}

/** First literal value for (subject, predicate), or null. */
function firstLiteral(dataset: DatasetCore, subject: Term, predicate: string): string | null {
  for (const q of matchSP(dataset, subject, predicate)) {
    if (q.object.termType === "Literal") return q.object.value;
  }
  return null;
}

/** First IRI value for (subject, predicate), or null. */
function firstIri(dataset: DatasetCore, subject: Term, predicate: string): string | null {
  for (const q of matchSP(dataset, subject, predicate)) {
    if (q.object.termType === "NamedNode") return q.object.value;
  }
  return null;
}

/** Accept only an `https:` photo URL; everything else (incl. javascript:/data:) → null. */
function safePhotoUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Build the UI-ready entries from a parsed Hydra collection dataset, and resolve
 * the opaque `hydra:next` URL.
 */
function projectCollection(dataset: DatasetCore): IndexPage {
  const entries: IndexEntry[] = [];
  const seen = new Set<string>();

  for (const q of matchP(dataset, HYDRA_MEMBER)) {
    const member = q.object;
    if (member.termType !== "NamedNode") continue;
    const webid = member.value;
    if (seen.has(webid)) continue;
    seen.add(webid);

    entries.push({
      webid,
      name: firstLiteral(dataset, member, FOAF_NAME),
      photoUrl: safePhotoUrl(firstIri(dataset, member, FOAF_IMG)),
      modified: firstLiteral(dataset, member, DCT_MODIFIED),
    });
  }

  // Resolve hydra:next via the PartialCollectionView (collection → view → next).
  let next: string | null = null;
  for (const viewQ of matchP(dataset, HYDRA_VIEW)) {
    for (const nextQ of matchSP(dataset, viewQ.object, HYDRA_NEXT)) {
      if (nextQ.object.termType === "NamedNode") {
        next = nextQ.object.value;
        break;
      }
    }
    if (next) break;
  }

  return { entries, next };
}

/** Map an inbox POST HTTP status to a {@link SuggestOutcome}. */
function mapSuggestStatus(status: number): SuggestOutcome {
  if (status === 201 || status === 202) return "submitted";
  if (status === 200 || status === 409) return "already-indexed";
  if (status === 429) return "rate-limited";
  if (status === 400 || status === 415 || status === 422) return "invalid";
  if (status === 413) return "invalid"; // body too large (shouldn't happen for our small body)
  return "error"; // 5xx and anything unexpected — transient
}

// ─── The client ──────────────────────────────────────────────────────────────

/** The public consumer-client surface (see {@link createIndexClient}). */
export interface IndexClient {
  /** The configured index origin (no trailing slash). */
  readonly origin: string;
  /** Search the index. Returns the first page; follow `.next` with {@link fetchPage}. */
  search(query: string, opts?: SearchOptions): Promise<IndexPage>;
  /** Follow an opaque `hydra:next` URL verbatim (same-origin enforced). */
  fetchPage(nextUrl: string, opts?: { signal?: AbortSignal }): Promise<IndexPage>;
  /** True when the WebID is indexed (the `/lookup` JSON mode `indexed:true`). */
  isIndexed(webid: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
  /** Read the index liveness snapshot. */
  checkHealth(opts?: { signal?: AbortSignal }): Promise<IndexHealth>;
  /** Suggest a WebID via the LDN inbox (AS2 `as:Announce`). */
  suggestWebId(webid: string, opts?: SuggestOptions): Promise<SuggestOutcome>;
}

class IndexClientImpl implements IndexClient {
  readonly origin: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly clientSignal?: AbortSignal;

  constructor(origin: string, opts: IndexClientOptions) {
    this.origin = origin;
    this.doFetch = opts.fetch ?? globalThis.fetch;
    this.clientSignal = opts.signal;
  }

  /** Resolve the effective AbortSignal (per-call overrides the client-level one). */
  private signalFor(callSignal?: AbortSignal): AbortSignal | undefined {
    return callSignal ?? this.clientSignal;
  }

  /**
   * GET an RDF resource and parse it. Reads always omit credentials (public,
   * cross-origin). Throws on a non-2xx status.
   */
  private async getRdf(url: string, signal?: AbortSignal): Promise<DatasetCore> {
    const res = await this.doFetch(url, {
      method: "GET",
      headers: { Accept: RDF_ACCEPT },
      credentials: "omit",
      signal,
    });
    if (!res.ok) {
      throw new Error(`webid-index GET ${url} failed: ${res.status}`);
    }
    const contentType = res.headers.get("Content-Type");
    const body = await res.text();
    return parseRdf(body, contentType, { baseIRI: url });
  }

  async search(query: string, opts?: SearchOptions): Promise<IndexPage> {
    const url = new URL(`${this.origin}/search`);
    url.searchParams.set("q", query);
    if (opts?.limit !== undefined) {
      url.searchParams.set("limit", String(opts.limit));
    }
    const dataset = await this.getRdf(url.toString(), this.signalFor(opts?.signal));
    return projectCollection(dataset);
  }

  async fetchPage(nextUrl: string, opts?: { signal?: AbortSignal }): Promise<IndexPage> {
    // Same-origin guard: an opaque hydra:next is followed VERBATIM, but only when
    // it points back at the configured index origin. A malicious next URL pointing
    // at a third-party host is refused — the consuming app never fetches an
    // attacker-chosen origin through this client.
    let parsed: URL;
    try {
      parsed = new URL(nextUrl);
    } catch {
      throw new Error(`webid-index: invalid next URL: ${nextUrl}`);
    }
    if (parsed.origin !== new URL(this.origin).origin) {
      throw new Error(
        `webid-index: refusing cross-origin next URL (${parsed.origin} ≠ ${this.origin})`,
      );
    }
    const dataset = await this.getRdf(parsed.toString(), this.signalFor(opts?.signal));
    return projectCollection(dataset);
  }

  async isIndexed(webid: string, opts?: { signal?: AbortSignal }): Promise<boolean> {
    const url = new URL(`${this.origin}/lookup`);
    url.searchParams.set("webid", webid);
    // The NON-REDIRECTING JSON mode (`?format=json` + `Accept: application/json`):
    // a single `200 { indexed: boolean }` with NO redirect. `redirect: "error"`
    // refuses a stray 3xx rather than following it cross-origin. FAILS CLOSED:
    // any inability to confirm `indexed:true` resolves to `false`.
    url.searchParams.set("format", "json");
    try {
      const res = await this.doFetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
        credentials: "omit",
        signal: this.signalFor(opts?.signal),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { indexed?: unknown };
      return body.indexed === true;
    } catch {
      return false;
    }
  }

  async checkHealth(opts?: { signal?: AbortSignal }): Promise<IndexHealth> {
    const res = await this.doFetch(`${this.origin}/.well-known/health`, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "omit",
      signal: this.signalFor(opts?.signal),
    });
    if (!res.ok) {
      throw new Error(`webid-index health check failed: ${res.status}`);
    }
    const body = (await res.json()) as Partial<IndexHealth>;
    return {
      status: body.status === "ok" ? "ok" : "degraded",
      entries: typeof body.entries === "number" ? body.entries : 0,
      triples: typeof body.triples === "number" ? body.triples : 0,
      queueDepth: typeof body.queueDepth === "number" ? body.queueDepth : 0,
      version: typeof body.version === "string" ? body.version : "unknown",
    };
  }

  async suggestWebId(webid: string, opts?: SuggestOptions): Promise<SuggestOutcome> {
    // Validate the WebID shape client-side (https IRI) before any network call.
    let canonical: string;
    try {
      const u = new URL(webid);
      if (u.protocol !== "https:") return "invalid";
      canonical = u.toString();
    } catch {
      return "invalid";
    }

    // Build the AS2 Announce as a JSON-LD object (canonical JSON-LD form, NOT a
    // hand-built triple string). `object` carries the candidate WebID; an
    // optional `actor` records provenance.
    const activity: Record<string, unknown> = {
      "@context": AS2_CONTEXT_IRI,
      type: "Announce",
      object: canonical,
    };
    if (opts?.actor) {
      activity.actor = opts.actor;
    }

    let res: Response;
    try {
      res = await this.doFetch(`${this.origin}/inbox/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/ld+json",
          Accept: "application/ld+json",
        },
        body: JSON.stringify(activity),
        // NEVER credentialed: the user's auth must not be attached to the
        // third-party index origin.
        credentials: "omit",
        signal: this.signalFor(opts?.signal),
      });
    } catch {
      // Network failure / abort → transient, the caller may retry.
      return "error";
    }

    return mapSuggestStatus(res.status);
  }
}

/**
 * Create a WebID-index consumer client, or `null` when no origin is configured.
 *
 * Returning `null` for an empty origin lets a consuming app gate the entire
 * integration on a single env var: `createIndexClient({ origin:
 * process.env.NEXT_PUBLIC_WEBID_INDEX ?? "" })` — `null` means the whole feature
 * is inert (no search box).
 *
 * @param opts.origin  the index origin; empty/whitespace ⇒ `null` (inert).
 * @param opts.fetch   injectable fetch impl (defaults to global); tests stub it.
 * @param opts.signal  client-level AbortSignal forwarded to every request.
 */
export function createIndexClient(opts: IndexClientOptions): IndexClient | null {
  const origin = (opts.origin ?? "").trim().replace(/\/+$/, "");
  if (!origin) return null;
  if (URL.canParse(origin) === false) {
    throw new Error(`createIndexClient: invalid origin: ${opts.origin}`);
  }
  return new IndexClientImpl(origin, opts);
}
