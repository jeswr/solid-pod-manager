/**
 * Pod data orchestration — turns Type-Index discovery into the human category
 * model the UI renders (DESIGN.md §3/§4). This is the read model for "My data":
 *
 *   profile → type-index registrations → group by category → list items.
 *
 * Pure functions (grouping, summarising) are separated from the I/O functions
 * (listing a container) so the grouping logic is unit-testable without a pod.
 */
import { fetchRdf } from "@jeswr/fetch-rdf";
import { ContainerDataset } from "@solid/object";
import { DataFactory, Writer } from "n3";
import { ResourceWriteError } from "./errors.js";
import {
  CATEGORIES,
  UNCATEGORISED,
  categoryForClass,
  type DataCategory,
} from "./categories.js";
import type { RegisteredLocation } from "./type-index.js";

/** A data category annotated with what was discovered in the pod. */
export interface CategorySummary {
  category: DataCategory;
  /** Distinct locations (instances/containers) registered for this category. */
  locations: RegisteredLocation[];
  /** True when at least one registration mapped here. */
  hasData: boolean;
}

/**
 * Group discovered registrations into the full category list. Every known
 * category appears (so the UI can show empty ones with an "add" CTA); the
 * `other` bucket appears only when something landed in it.
 *
 * Pure — no I/O. The display model for the "My data" home.
 */
export function summariseCategories(
  locations: RegisteredLocation[],
): CategorySummary[] {
  const byCategoryId = new Map<string, RegisteredLocation[]>();
  for (const loc of locations) {
    const cat = categoryForClass(loc.forClass);
    const list = byCategoryId.get(cat.id) ?? [];
    list.push(loc);
    byCategoryId.set(cat.id, list);
  }

  const summaries: CategorySummary[] = CATEGORIES.map((category) => {
    const locs = dedupeLocations(byCategoryId.get(category.id) ?? []);
    return { category, locations: locs, hasData: locs.length > 0 };
  });

  const otherLocs = dedupeLocations(byCategoryId.get(UNCATEGORISED.id) ?? []);
  if (otherLocs.length > 0) {
    summaries.push({
      category: UNCATEGORISED,
      locations: otherLocs,
      hasData: true,
    });
  }
  return summaries;
}

/** Count of categories that have at least one registration. */
export function categoriesWithDataCount(summaries: CategorySummary[]): number {
  return summaries.filter((s) => s.hasData).length;
}

function dedupeLocations(locs: RegisteredLocation[]): RegisteredLocation[] {
  const seen = new Set<string>();
  const out: RegisteredLocation[] = [];
  for (const l of locs) {
    const key = `${l.forClass}|${l.instance ?? ""}|${l.container ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

/** One browsable item inside a category. */
export interface PodItem {
  /** Resource URL. */
  url: string;
  /** Friendly name (from the container listing, else the URL tail). */
  name: string;
  isContainer: boolean;
  modified?: string; // ISO string — serialisable for client components
  size?: number;
  mimeType?: string;
}

/**
 * List the items a category's registrations point at.
 *
 * - `solid:instance` registrations contribute the single resource directly.
 * - `solid:instanceContainer` registrations are listed via `ContainerDataset`.
 *
 * @param fetchImpl - test-only override; **omit in production** so auth runs.
 */
export async function listCategoryItems(
  summary: CategorySummary,
  fetchImpl?: typeof fetch,
): Promise<PodItem[]> {
  const items: PodItem[] = [];
  const seen = new Set<string>();

  for (const loc of summary.locations) {
    if (loc.instance) {
      pushUnique(items, seen, {
        url: loc.instance,
        name: nameFromUrl(loc.instance),
        isContainer: false,
      });
    }
    if (loc.container) {
      const listed = await listContainer(loc.container, fetchImpl);
      for (const item of listed) pushUnique(items, seen, item);
    }
  }
  return items;
}

/**
 * List a single container's direct children as {@link PodItem}s.
 * A `404` resolves to an empty list (the container may be registered but not
 * yet created — discovery is a hint, not a guarantee; type-index skill).
 */
export async function listContainer(
  containerUrl: string,
  fetchImpl?: typeof fetch,
): Promise<PodItem[]> {
  const url = containerUrl.endsWith("/") ? containerUrl : `${containerUrl}/`;
  const { dataset } = await fetchRdf(url, fetchImpl ? { fetch: fetchImpl } : undefined);
  const container = new ContainerDataset(dataset, DataFactory).container;
  const out: PodItem[] = [];
  for (const r of container?.contains ?? []) {
    if (r.id === url) continue; // skip the container's self-description
    out.push({
      url: r.id,
      name: r.name,
      isContainer: r.isContainer,
      modified: r.modified?.toISOString(),
      size: r.size,
      mimeType: r.mimeType,
    });
  }
  return out.sort(byContainerThenName);
}

function byContainerThenName(a: PodItem, b: PodItem): number {
  if (a.isContainer !== b.isContainer) return a.isContainer ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function pushUnique(items: PodItem[], seen: Set<string>, item: PodItem): void {
  if (seen.has(item.url)) return;
  seen.add(item.url);
  items.push(item);
}

/** Serialise an in-memory dataset to Turtle (promisified n3 Writer). */
export function serializeTurtle(
  dataset: import("@rdfjs/types").DatasetCore,
  prefixes?: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const writer = new Writer({ format: "text/turtle", prefixes });
    for (const quad of dataset) writer.addQuad(quad);
    writer.end((err, result) => (err ? reject(err) : resolve(result)));
  });
}

export interface WriteResourceOptions {
  /** Send `If-Match` so a concurrent edit fails with 412 instead of clobbering. */
  etag?: string | null;
  /** Send `If-None-Match: *` — create only, never overwrite (412 if it exists). */
  createOnly?: boolean;
  /** Test-only override; **omit in production** so the auth-patched global runs. */
  fetchImpl?: typeof fetch;
  /** Optional Turtle prefix map for readable documents. */
  prefixes?: Record<string, string>;
}

/**
 * The minimal pod write path: serialise the dataset and `PUT` it as Turtle.
 *
 * Always sends an explicit `Content-Type` (AGENTS.md §Writing data). Servers
 * that support it create intermediate containers on PUT, so writing
 * `…/integrations/app/doc.ttl` needs no separate container creation.
 *
 * @throws ResourceWriteError on any non-2xx answer (412 = precondition failed:
 *   either a concurrent edit under `etag` or "already exists" under
 *   `createOnly` — callers branch on `.status`).
 */
export async function writeResource(
  url: string,
  dataset: import("@rdfjs/types").DatasetCore,
  opts: WriteResourceOptions = {},
): Promise<{ etag: string | null }> {
  const body = await serializeTurtle(dataset, opts.prefixes);
  const headers: Record<string, string> = { "content-type": "text/turtle" };
  if (opts.etag) headers["if-match"] = opts.etag;
  if (opts.createOnly) headers["if-none-match"] = "*";
  const init: RequestInit = { method: "PUT", headers, body };
  const res = opts.fetchImpl ? await opts.fetchImpl(url, init) : await fetch(url, init);
  if (!res.ok) throw new ResourceWriteError(url, res.status);
  return { etag: res.headers.get("etag") };
}

/** Derive a friendly name from a resource URL (last non-empty path segment). */
export function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    const last = segments.at(-1);
    return last ? decodeURIComponent(last) : u.hostname;
  } catch {
    return url;
  }
}
