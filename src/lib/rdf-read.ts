/**
 * The app's one way to GET a pod RDF document: `fetchRdf` plus forced
 * revalidation.
 *
 * Solid servers (CSS included — verified against v7) send `ETag` and
 * `Last-Modified` but NO `Cache-Control`, so browsers apply HEURISTIC
 * freshness (≈10% of the document's age) and may answer a GET straight from
 * cache without revalidating. For a pod manager that is a correctness bug,
 * observed in e2e: right after a demo import bootstraps the type index and
 * links it from the profile, the My-data page re-read the PROFILE from the
 * browser cache (pre-import copy, no index link) and showed "No media items
 * yet" for data that was sitting in the pod. The same staleness class hands
 * read-modify-write paths (type-index, ACLs) an out-of-date ETag, turning
 * into spurious `412`s on `If-Match` writes.
 *
 * The request header `Cache-Control: no-cache` keeps the HTTP cache but
 * forces conditional revalidation — the server answers `304` when nothing
 * changed, so freshness costs one cheap conditional GET. (`no-store` would
 * disable caching outright; revalidation is enough.)
 *
 * @see https://developer.mozilla.org/docs/Web/HTTP/Caching#heuristic_caching
 */
import { fetchRdf } from "@jeswr/fetch-rdf";

/** Request headers that force conditional revalidation through HTTP caches. */
export const REVALIDATE_HEADERS = { "cache-control": "no-cache" } as const;

/**
 * Fetch + parse a pod RDF document, always revalidating any cached copy.
 *
 * Same contract as `fetchRdf` (errors propagate as `RdfFetchError`; keep the
 * returned `etag` for conditional writes).
 *
 * @param fetchImpl - test-only override; **omit in production** so the
 *   auth-patched global fetch runs (AGENTS.md §Reading data).
 */
export function freshRdf(
  url: string,
  fetchImpl?: typeof fetch,
): ReturnType<typeof fetchRdf> {
  return fetchRdf(
    url,
    fetchImpl
      ? { fetch: fetchImpl, headers: REVALIDATE_HEADERS }
      : { headers: REVALIDATE_HEADERS },
  );
}
