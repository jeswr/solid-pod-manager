/**
 * Shared CRUD scaffolding for the first-party productivity apps (Notes,
 * Calendar, Contacts). Each app keeps its records as **one resource per item**
 * under a dedicated container in the pod (`notes/`, `calendar/`, `contacts/`)
 * and registers that container in the Type Index so the data also surfaces
 * under "My data".
 *
 * Why one-resource-per-item (not a single collection document): it keeps each
 * write small and conflict-scoped, lets per-item ACLs differ later, and maps
 * cleanly onto the Type-Index `solid:instanceContainer` discovery model
 * (`solid-scale-and-sharding` skill — permission-driven splitting). The trade
 * is an extra GET per item when opening one; acceptable at personal scale.
 *
 * This module is the ONE place app modules touch pod I/O — it composes the
 * `pod-data` primitives (read/write/list/delete) and `type-index-write`
 * registration. App modules supply only: their container slug, their RDF
 * class, and a parse/serialise pair built from typed `@rdfjs/wrapper` accessors
 * (house rule: never hand-build quads, never inline Turtle).
 */
import { Store } from "n3";
import { RdfFetchError } from "@jeswr/fetch-rdf";
import { ItemReadError } from "./errors.js";
import {
  deleteResource,
  listContainer,
  nameFromUrl,
  readResource,
  writeResource,
} from "./pod-data.js";
import { ensureTypeRegistrations } from "./type-index-write.js";

/**
 * A productivity item as the UI consumes it: a stable `url`, its `etag` for
 * conditional writes, and the parsed `data` payload. Generic over the payload
 * `T` so each app names its own fields.
 */
export interface StoredItem<T> {
  url: string;
  /** ETag from the last read — pass back on save to guard against clobbering. */
  etag: string | null;
  data: T;
}

/**
 * Per-app configuration that turns the generic store into a typed one.
 *
 * @typeParam T - the app's plain-data payload (e.g. a `Note`).
 */
export interface StoreConfig<T> {
  /** Container slug under the pod root, e.g. `"notes/"` (must end in `/`). */
  containerSlug: string;
  /** The RDF class registered in the Type Index for discovery. */
  forClass: string;
  /** Turtle prefix map for readable documents. */
  prefixes: Record<string, string>;
  /**
   * Parse a single item's dataset into the payload. `itemUrl` is the resource
   * URL (the item's subject is `${itemUrl}#it`). Return `undefined` when the
   * document holds no item of this class (so a stray file is skipped).
   */
  parse(itemUrl: string, dataset: import("@rdfjs/types").DatasetCore): T | undefined;
  /** Serialise a payload into a fresh dataset rooted at `${itemUrl}#it`. */
  build(itemUrl: string, data: T): Store;
}

/**
 * A typed CRUD handle for one productivity app, bound to a pod root.
 *
 * Construct via {@link createStore}. Production callers pass NO `fetchImpl`
 * (the auth-patched global runs); tests inject one (AGENTS.md §Reading data).
 */
export class ProductivityStore<T> {
  private readonly containerUrl: string;

  constructor(
    private readonly cfg: StoreConfig<T>,
    private readonly podRoot: string,
    private readonly webId: string,
    private readonly fetchImpl?: typeof fetch,
  ) {
    this.containerUrl = new URL(cfg.containerSlug, podRoot).toString();
  }

  /** The container these items live in (always ends in `/`). */
  get container(): string {
    return this.containerUrl;
  }

  /**
   * Mint a fresh, collision-resistant resource URL inside the container.
   * `slugHint` (e.g. a note title) seeds a readable, URI-safe prefix; a random
   * suffix guarantees uniqueness without a round-trip. Never contains `:` (an
   * ACL-matching hazard on some servers — AGENTS.md §Access control).
   */
  newItemUrl(slugHint?: string): string {
    const slug = toSlug(slugHint);
    const rand = Math.random().toString(36).slice(2, 8);
    const file = slug ? `${slug}-${rand}.ttl` : `${rand}.ttl`;
    return `${this.containerUrl}${file}`;
  }

  /**
   * List every item in the container. Skips sub-containers and any resource
   * that doesn't parse to this app's class. Unreadable individual items are
   * skipped rather than failing the whole list (resilience over strictness).
   */
  async list(): Promise<StoredItem<T>[]> {
    let entries: { url: string }[];
    try {
      entries = await listContainer(this.containerUrl, this.fetchImpl);
    } catch (e) {
      // A missing container just means "nothing created yet".
      if (e instanceof RdfFetchError && (e.status === 404 || e.status === 403)) {
        return [];
      }
      throw e;
    }

    const items: StoredItem<T>[] = [];
    for (const entry of entries) {
      if (entry.url.endsWith("/")) continue; // sub-container
      try {
        const item = await this.read(entry.url);
        if (item) items.push(item);
      } catch {
        // Skip an item that vanished or failed to parse; the rest still load.
      }
    }
    return items;
  }

  /**
   * Read one item by URL. Returns `undefined` when the resource holds no item
   * of this class.
   *
   * @throws ItemReadError when the resource cannot be fetched (wraps the
   *   underlying `RdfFetchError`; 404 surfaces as `.status === 404`).
   */
  async read(url: string): Promise<StoredItem<T> | undefined> {
    let dataset: import("@rdfjs/types").DatasetCore;
    let etag: string | null;
    try {
      ({ dataset, etag } = await readResource(url, this.fetchImpl));
    } catch (e) {
      if (e instanceof RdfFetchError) throw new ItemReadError(url, e.status ?? 0, { cause: e });
      throw e;
    }
    const data = this.cfg.parse(url, dataset);
    if (data === undefined) return undefined;
    return { url, etag, data };
  }

  /**
   * Create a new item. Registers the container in the Type Index on first use
   * (idempotent), then writes the resource create-only so a colliding URL is
   * never silently overwritten.
   *
   * @returns the new item URL and its ETag.
   */
  async create(data: T, slugHint?: string): Promise<{ url: string; etag: string | null }> {
    await this.ensureRegistered();
    const url = this.newItemUrl(slugHint);
    const dataset = this.cfg.build(url, data);
    const { etag } = await writeResource(url, dataset, {
      createOnly: true,
      fetchImpl: this.fetchImpl,
      prefixes: this.cfg.prefixes,
    });
    return { url, etag };
  }

  /**
   * Overwrite an existing item. Sends `If-Match` when an `etag` is supplied so
   * a concurrent edit fails with 412 instead of clobbering (the caller re-reads
   * and retries).
   */
  async update(
    url: string,
    data: T,
    etag?: string | null,
  ): Promise<{ etag: string | null }> {
    const dataset = this.cfg.build(url, data);
    return writeResource(url, dataset, {
      etag,
      fetchImpl: this.fetchImpl,
      prefixes: this.cfg.prefixes,
    });
  }

  /** Delete an item (idempotent — a missing resource resolves to success). */
  async remove(url: string): Promise<void> {
    await deleteResource(url, this.fetchImpl);
  }

  /** Register this app's container in the user's Type Index (idempotent). */
  async ensureRegistered(): Promise<void> {
    await ensureTypeRegistrations({
      webId: this.webId,
      podRoot: this.podRoot,
      registrations: [{ forClass: this.cfg.forClass, container: this.containerUrl }],
      fetchImpl: this.fetchImpl,
    });
  }
}

/** Build a typed store for an app, bound to the active pod + WebID. */
export function createStore<T>(
  cfg: StoreConfig<T>,
  opts: { podRoot: string; webId: string; fetchImpl?: typeof fetch },
): ProductivityStore<T> {
  return new ProductivityStore(cfg, opts.podRoot, opts.webId, opts.fetchImpl);
}

/**
 * Lower-case, hyphenated, ASCII-only slug — URI-safe and `:`-free. Empty input
 * (or input with no usable characters) yields `""` so the caller falls back to
 * a purely random name. Capped so URLs stay reasonable.
 */
export function toSlug(input: string | undefined): string {
  if (!input) return "";
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

/** Re-export the friendly-name helper for app modules that need it. */
export { nameFromUrl };
