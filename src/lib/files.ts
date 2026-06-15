// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * The file/folder browser data layer — Wave 1 (Files) of the Pod-Manager
 * feature-completeness plan. A CLIENT-ONLY build over the standard Solid/LDP
 * surface prod-solid-server already exposes (containers, PUT/POST, conditional
 * writes via ETag, content negotiation, DELETE).
 *
 * This module is the ONE place the files UI touches pod I/O for path-addressed
 * browsing and raw-byte editing. It COMPOSES the existing `pod-data` primitives
 * (`listContainer`, `deleteResource`, `nameFromUrl`) rather than duplicating
 * them, and adds only what the browser needs that the category model did not:
 *
 *   - breadcrumb / parent-path computation over storage-relative paths;
 *   - safe slug → child-URL minting for "New folder" / "New file";
 *   - container creation (PUT an empty container, LDP-style);
 *   - raw-body read (text body + content-type + ETag) for the source editor and
 *     download; raw-body write (PUT) with conditional `If-Match` / `If-None-Match`
 *     so a concurrent edit fails with 412 instead of clobbering;
 *   - file upload (PUT with the picked file's Content-Type);
 *   - copy + rename (client copy-then-delete — the server has no MOVE/COPY).
 *
 * Pure functions (path math, slug handling, content-type guessing) are kept
 * separate from the I/O functions so they are unit-testable without a pod.
 *
 * SECURITY: every read/write here uses the auth-patched global `fetch` (the
 * `fetchImpl` parameter is test-only — omit in production). Callers MUST gate
 * the target URL through `isInOwnPods` (pod-scope SEC-1) BEFORE invoking any
 * I/O here — a path-addressed browser is exactly the confused-deputy surface
 * that guard exists for. `files.ts` does not re-check scope (the UI owns the
 * active-storage list); it assumes the caller already constrained the URL.
 */
import { RdfFetchError } from "@jeswr/fetch-rdf";
import { Parser } from "n3";
import { listContainer, type PodItem } from "./pod-data.js";
import { ResourceWriteError, ResourceDeleteError, ItemReadError } from "./errors.js";

export type { PodItem } from "./pod-data.js";
export { nameFromUrl } from "./pod-data.js";

/** One breadcrumb hop: a display label + the absolute container URL it opens. */
export interface Crumb {
  label: string;
  /** Absolute URL of the container this crumb navigates to (always ends "/"). */
  url: string;
}

/** Ensure a container URL ends in exactly one trailing slash. */
export function asContainerUrl(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** True when a URL addresses an LDP container (path ends in "/"). */
export function isContainerUrl(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith("/");
  } catch {
    return url.endsWith("/");
  }
}

/**
 * The parent container of a resource or container URL, or `undefined` when the
 * URL is already at (or above) the storage root — there is nothing to go "up"
 * to. `root` is the pod storage URL; we never walk above it (a files browser is
 * scoped to one storage). Both are normalised so trailing-slash differences
 * don't matter.
 */
export function parentContainer(url: string, root: string): string | undefined {
  let u: URL;
  let r: URL;
  try {
    u = new URL(url);
    r = new URL(asContainerUrl(root));
  } catch {
    return undefined;
  }
  if (u.origin !== r.origin) return undefined;
  // Strip a trailing slash so a container and a resource compute the same way.
  const segments = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  const rootSegments = r.pathname.split("/").filter(Boolean);
  if (segments.length <= rootSegments.length) return undefined;
  segments.pop();
  const parentPath = segments.length ? `/${segments.join("/")}/` : "/";
  return `${u.origin}${parentPath}`;
}

/**
 * Build the breadcrumb trail from the storage root down to `current`, inclusive.
 * The first crumb is the storage root (labelled "Pod"); the last is `current`.
 * Returns a single root crumb when `current` is the root or lies outside it.
 *
 * Pure — the display model for the browser's breadcrumb nav.
 */
export function breadcrumbs(current: string, root: string): Crumb[] {
  const rootUrl = asContainerUrl(root);
  const trail: Crumb[] = [{ label: "Pod", url: rootUrl }];
  let r: URL;
  let c: URL;
  try {
    r = new URL(rootUrl);
    c = new URL(asContainerUrl(current));
  } catch {
    return trail;
  }
  if (c.origin !== r.origin || !c.pathname.startsWith(r.pathname)) return trail;

  const rootSegments = r.pathname.split("/").filter(Boolean);
  const allSegments = c.pathname.split("/").filter(Boolean);
  const relative = allSegments.slice(rootSegments.length);

  let acc = rootUrl;
  for (const seg of relative) {
    acc = `${acc}${seg}/`;
    trail.push({ label: decodeSegment(seg), url: acc });
  }
  return trail;
}

function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/**
 * URI-safe slug for a new resource/folder name: lower-cased, hyphenated,
 * ASCII-only, `:`-free (an ACL-matching hazard on some servers — AGENTS.md
 * §Access control). Mirrors the productivity-store `toSlug`, but kept here so
 * the files layer has no cross-import. Empty input yields `""`.
 */
export function toFileSlug(input: string | undefined): string {
  if (!input) return "";
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-") // keep dots (extensions) and alphanumerics
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64)
    .replace(/[-.]+$/g, "");
}

/**
 * Mint a child resource URL under `container` from a user-supplied name. The
 * name is slugged; an optional `extension` (without dot) is appended when the
 * slug doesn't already carry one. Throws if the slug is empty after cleaning
 * (the caller should surface "please enter a valid name").
 */
export function childResourceUrl(
  container: string,
  name: string,
  extension?: string,
): string {
  const base = toFileSlug(name);
  if (!base) throw new Error("That name can't be used. Try letters and numbers.");
  let file = base;
  if (extension && !base.includes(".")) file = `${base}.${toFileSlug(extension)}`;
  return `${asContainerUrl(container)}${file}`;
}

/**
 * Mint a child CONTAINER URL under `container` from a user-supplied folder name
 * (always ends in "/"). Throws on an empty slug.
 */
export function childContainerUrl(container: string, name: string): string {
  const base = toFileSlug(name);
  if (!base) throw new Error("That folder name can't be used. Try letters and numbers.");
  return `${asContainerUrl(container)}${base}/`;
}

/** A resource's raw body as the source editor / download path consumes it. */
export interface RawResource {
  url: string;
  /** Decoded text body. */
  text: string;
  /** Normalised-ish content type from the response (`text/turtle`, …). */
  contentType: string | undefined;
  /** Strong validator for a later conditional write (may be null). */
  etag: string | null;
}

/**
 * True iff `url` is a DIRECT child of `container` (one path segment deeper,
 * same origin) — i.e. a member the listing could legitimately point at. A
 * container's own `ldp:contains` is attacker-influenceable, so we never trust a
 * member that is cross-origin or not directly under the listed container (SEC-1:
 * row actions call the authenticated fetch on `item.url`, which must never reach
 * outside the pod). Pure.
 */
export function isDirectChild(url: string, container: string): boolean {
  let u: URL;
  let c: URL;
  try {
    u = new URL(url);
    c = new URL(asContainerUrl(container));
  } catch {
    return false;
  }
  if (u.origin !== c.origin) return false;
  if (!u.pathname.startsWith(c.pathname)) return false;
  const rest = u.pathname.slice(c.pathname.length);
  if (rest === "") return false; // the container itself, not a child
  // A child resource has no further "/"; a child container ends in exactly one.
  const trimmed = rest.endsWith("/") ? rest.slice(0, -1) : rest;
  return trimmed.length > 0 && !trimmed.includes("/");
}

/**
 * List a container's direct children. Wraps `pod-data.listContainer`
 * (QLever-backed; folders-first, name-sorted) AND filters out any member that
 * is not a direct, same-origin descendant of the listed container — a hostile
 * `ldp:contains` pointing at an external/foreign URL must never become a clickable
 * row whose actions fire the DPoP-authenticated fetch (SEC-1). A 404/403 surfaces
 * as the underlying `RdfFetchError` for the caller to branch on.
 */
export async function listFolder(
  container: string,
  fetchImpl?: typeof fetch,
): Promise<PodItem[]> {
  const items = await listContainer(container, fetchImpl);
  return items.filter((item) => isDirectChild(item.url, container));
}

/**
 * Read a resource's body as DECODED TEXT, keeping its content-type and ETag for
 * a later conditional write. This is the SOURCE-EDITOR path only — it decodes
 * the body as a string, which is correct for text/RDF but would corrupt binary
 * content. For download / copy / rename of arbitrary (possibly binary)
 * resources, use {@link readBytes}, which preserves the exact bytes.
 *
 * Uses the auth-patched global fetch unless a test `fetchImpl` is supplied.
 *
 * @throws ItemReadError on any non-2xx (branch on `.status`; 404 = not found,
 *   403/401 = forbidden).
 */
export async function readRaw(
  url: string,
  fetchImpl?: typeof fetch,
): Promise<RawResource> {
  const f = fetchImpl ?? fetch;
  const res = await f(url, { headers: { accept: "*/*", "cache-control": "no-cache" } });
  if (!res.ok) throw new ItemReadError(url, res.status);
  const text = await res.text();
  return {
    url,
    text,
    contentType: res.headers.get("content-type") ?? undefined,
    etag: res.headers.get("etag"),
  };
}

/** A resource's exact bytes (download / copy / rename — never decoded as text). */
export interface RawBytes {
  url: string;
  blob: Blob;
  contentType: string | undefined;
  etag: string | null;
}

/**
 * Read a resource's EXACT BYTES (as a `Blob`), preserving content for any media
 * type — images, PDFs, audio, video, and text alike. This is the byte-exact
 * path for download, copy, and rename, so a binary resource is never mangled by
 * a text decode/re-encode round-trip.
 *
 * @throws ItemReadError on any non-2xx.
 */
export async function readBytes(
  url: string,
  fetchImpl?: typeof fetch,
): Promise<RawBytes> {
  const f = fetchImpl ?? fetch;
  const res = await f(url, { headers: { accept: "*/*", "cache-control": "no-cache" } });
  if (!res.ok) throw new ItemReadError(url, res.status);
  const blob = await res.blob();
  return {
    url,
    blob,
    contentType: res.headers.get("content-type") ?? undefined,
    etag: res.headers.get("etag"),
  };
}

/** Options for a raw-body write (source editor save, upload). */
export interface WriteRawOptions {
  /** MIME type to send as `Content-Type` (defaults to `text/turtle`). */
  contentType?: string;
  /** `If-Match` — fail with 412 on a concurrent edit instead of clobbering. */
  etag?: string | null;
  /** `If-None-Match: *` — create only; 412 if the target already exists. */
  createOnly?: boolean;
  /** Test-only override; omit in production so the auth-patched global runs. */
  fetchImpl?: typeof fetch;
}

/**
 * PUT a raw body (string or binary) to `url`. The source editor round-trips the
 * literal text body here; uploads pass the picked `File`/`Blob` straight
 * through with its own type. Always sends an explicit `Content-Type`
 * (AGENTS.md §Writing data).
 *
 * @throws ResourceWriteError on any non-2xx (412 = precondition failed: a
 *   concurrent edit under `etag`, or "already exists" under `createOnly`).
 */
export async function writeRaw(
  url: string,
  body: string | Blob | ArrayBuffer | Uint8Array,
  opts: WriteRawOptions = {},
): Promise<{ etag: string | null }> {
  const headers: Record<string, string> = {
    "content-type": opts.contentType ?? "text/turtle",
  };
  if (opts.etag) headers["if-match"] = opts.etag;
  if (opts.createOnly) headers["if-none-match"] = "*";
  const init: RequestInit = { method: "PUT", headers, body: body as BodyInit };
  const f = opts.fetchImpl ?? fetch;
  const res = await f(url, init);
  if (!res.ok) throw new ResourceWriteError(url, res.status);
  return { etag: res.headers.get("etag") };
}

/**
 * Create an (empty) LDP container at `url` by PUTting it with the container
 * link type. prod-solid-server (like CSS) creates the container on a PUT to a
 * trailing-slash URL; we send the `Link: rel="type"` Container header so the
 * intent is explicit and content-negotiation-independent.
 *
 * Idempotent-ish: a server that 412/409s an existing container is surfaced as
 * a `ResourceWriteError` for the caller to message ("a folder with that name
 * already exists").
 *
 * @throws ResourceWriteError on any non-2xx.
 */
export async function createContainer(
  url: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const target = asContainerUrl(url);
  const init: RequestInit = {
    method: "PUT",
    headers: {
      "content-type": "text/turtle",
      link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
      // Create-only so we never silently re-PUT over an existing folder.
      "if-none-match": "*",
    },
    body: "",
  };
  const f = fetchImpl ?? fetch;
  const res = await f(target, init);
  if (!res.ok) throw new ResourceWriteError(target, res.status);
}

/**
 * Upload a file into a container, deriving a safe child URL from the file's
 * name and sending its own MIME type. Returns the created resource URL.
 *
 * Create-only by default (`overwrite: false`) so a same-named upload doesn't
 * silently clobber — the caller catches the 412 and can offer "replace?".
 *
 * @throws ResourceWriteError on any non-2xx.
 */
export async function uploadFile(
  container: string,
  file: File,
  opts: { overwrite?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<{ url: string }> {
  const fileName = uploadFileName(file.name);
  const url = `${asContainerUrl(container)}${fileName}`;
  await writeRaw(url, file, {
    contentType: file.type || guessContentType(file.name) || "application/octet-stream",
    createOnly: !opts.overwrite,
    fetchImpl: opts.fetchImpl,
  });
  return { url };
}

/**
 * Derive the storage file name for an uploaded file: slug the BASE name (with
 * the length cap applied to the base alone) and re-attach the FULL extension
 * chain, so a long name never truncates mid-extension and a multi-part
 * extension like `.tar.gz` is preserved. Throws on a name that slugs to empty.
 *
 * `archive.tar.gz` → `archive.tar.gz`; a 200-char base keeps its `.gz`.
 */
export function uploadFileName(name: string): string {
  const ext = extensionChain(name); // "" or ".tar.gz"
  const base = ext ? name.slice(0, name.length - ext.length) : name;
  const baseSlug = toFileSlug(base);
  // The extension chain is slugged segment-by-segment so each part stays clean
  // (and a leading "." is kept), without the 64-char cap eating it.
  const extSlug = ext
    ? `.${ext.slice(1).split(".").map((e) => toFileSlug(e)).filter(Boolean).join(".")}`
    : "";
  const combined = `${baseSlug}${extSlug === "." ? "" : extSlug}`;
  const final = combined.replace(/^[-.]+|[-.]+$/g, "");
  if (!final) throw new Error("That file name can't be used.");
  return final;
}

/**
 * The full leading-dot extension chain of a file name: `archive.tar.gz` →
 * `.tar.gz`, `photo.jpg` → `.jpg`, `noext` → `""`. A dot-file with no real
 * extension (`.gitignore`) yields `""`. Pure.
 */
export function extensionChain(name: string): string {
  // Ignore a leading dot (dot-file) when locating the first extension dot.
  const stripped = name.replace(/^\.+/, "");
  const dot = stripped.indexOf(".");
  if (dot < 0) return "";
  // Map the index back onto the original name.
  const offset = name.length - stripped.length;
  return name.slice(offset + dot);
}

/**
 * Delete a resource or container. Pass-through over `pod-data.deleteResource`
 * (idempotent: 404/410 resolve as success). Re-exported so the files UI imports
 * deletion from one place.
 *
 * NOTE: deleting a non-empty container fails on most servers (409) — the UI
 * surfaces that as "empty the folder first". We do NOT recursively delete here
 * (a destructive multi-request operation belongs to an explicit, confirmed UI
 * flow, not a silent helper).
 *
 * @throws ResourceDeleteError on any non-2xx other than 404/410.
 */
export async function deleteEntry(
  url: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const f = fetchImpl ?? fetch;
  const res = await f(url, { method: "DELETE" });
  if (res.ok || res.status === 404 || res.status === 410) return;
  throw new ResourceDeleteError(url, res.status);
}

/**
 * Copy a single (non-container) resource to a new URL, byte-for-byte, carrying
 * its content type. Read raw → write raw (create-only so a copy never clobbers
 * an existing target). Returns the destination URL.
 *
 * @throws ItemReadError if the source can't be read; ResourceWriteError if the
 *   destination write fails (412 = target already exists).
 */
export async function copyResource(
  from: string,
  to: string,
  fetchImpl?: typeof fetch,
): Promise<{ url: string }> {
  // Byte-exact: read the source as a Blob (never a text decode) so binary
  // resources — images, PDFs, audio — copy without corruption.
  const src = await readBytes(from, fetchImpl);
  await writeRaw(to, src.blob, {
    contentType: src.contentType ?? src.blob.type ?? "application/octet-stream",
    createOnly: true,
    fetchImpl,
  });
  return { url: to };
}

/**
 * Rename (= move) a single resource: copy to the new URL, then delete the old.
 * The server exposes no MOVE/COPY verb (per the plan), so this is the
 * client-side equivalent. If the destination write fails the source is left
 * untouched (we only delete after a successful copy) — fail-safe, never losing
 * data on a half-move.
 *
 * Containers are NOT renamed here (that is a recursive subtree move — out of
 * Wave 1 scope); the UI disables rename for folders.
 *
 * @throws on a read/write/delete failure (see `copyResource` / `deleteEntry`).
 */
export async function renameResource(
  from: string,
  to: string,
  fetchImpl?: typeof fetch,
): Promise<{ url: string }> {
  if (isContainerUrl(from)) {
    throw new Error("Folders can't be renamed yet — create a new folder and move items into it.");
  }
  await copyResource(from, to, fetchImpl);
  await deleteEntry(from, fetchImpl);
  return { url: to };
}

/**
 * Result of a client-side Turtle syntax check before a source-editor save.
 * `ok: false` carries a human-readable message (and a 1-based line when n3
 * reports one) so the editor can point at the problem instead of letting the
 * server reject a malformed PUT.
 */
export type SyntaxCheck =
  | { ok: true }
  | { ok: false; message: string; line?: number };

/**
 * Parse Turtle (or N-Triples/N-Quads — n3 auto-detects) purely to validate it.
 * Pure (no I/O): the editor calls this before a conditional PUT so a typo is
 * caught client-side. Non-RDF content types skip the check (`ok: true`) — a
 * plain-text/markdown file has no Turtle grammar to satisfy.
 */
export function checkTurtleSyntax(body: string, baseIRI?: string): SyntaxCheck {
  try {
    const parser = new Parser({ baseIRI });
    parser.parse(body); // synchronous, throws on the first grammar error
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const lineMatch = /line (\d+)/i.exec(message);
    return {
      ok: false,
      message,
      line: lineMatch ? Number(lineMatch[1]) : undefined,
    };
  }
}

/** True when a content type is RDF we can syntax-check as Turtle-family. */
export function isTurtleEditable(contentType: string | undefined): boolean {
  const t = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  return (
    t === "text/turtle" ||
    t === "application/n-triples" ||
    t === "application/n-quads" ||
    t === "text/n3"
  );
}

/** The file name without its last extension: `a.b.ttl` → `a.b`. */
export function fileBaseName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** The last extension (no dot), lower-cased: `a.TTL` → `ttl`; none → "". */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** A small extension → MIME map for uploads/new-file when the browser is mute. */
const EXTENSION_MIME: Record<string, string> = {
  ttl: "text/turtle",
  jsonld: "application/ld+json",
  nt: "application/n-triples",
  nq: "application/n-quads",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
};

/** Best-effort content type from a file name's extension, else `undefined`. */
export function guessContentType(name: string): string | undefined {
  return EXTENSION_MIME[fileExtension(name)];
}

/** Re-export so the UI's "is this 404/forbidden?" branch has one import home. */
export { RdfFetchError };
