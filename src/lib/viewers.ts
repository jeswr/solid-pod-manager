/**
 * Content-type-aware viewer dispatch (PodOS pattern, DESIGN.md §4/R2): given a
 * resource's media type, choose the *kind* of viewer to render. A friendly
 * renderer for known types, a safe generic otherwise — the UI maps each kind to
 * a component. Pure classification, no rendering, so it is unit-testable and the
 * UI layer stays free of content sniffing.
 *
 * The "safe generic" default matters for security: an unknown type is shown as
 * inert metadata / downloadable, never executed or embedded as live HTML.
 */

/** The viewer kinds the UI knows how to render. */
export type ViewerKind =
  | "rdf" // Turtle / JSON-LD — structured pod data, rendered as a property table
  | "image" // raster/vector image — <img>
  | "text" // plain text / markdown / csv — monospace text
  | "pdf" // PDF — embedded object or download
  | "audio"
  | "video"
  | "generic"; // anything else — metadata card + download link (the safe default)

/** Result of classifying a resource. */
export interface ViewerChoice {
  kind: ViewerKind;
  /** The normalised media type (no parameters), for display. */
  mediaType: string;
  /**
   * Whether the content is safe to embed/preview inline. `false` → the UI
   * offers download/metadata only (e.g. raw HTML, unknown binaries).
   */
  embeddable: boolean;
}

const RDF_TYPES = new Set([
  "text/turtle",
  "application/ld+json",
  "application/n-triples",
  "application/n-quads",
  "application/trig",
  "text/n3",
]);

const TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/xml",
  "text/xml",
]);

/** Strip parameters and lowercase: `text/turtle; charset=utf-8` → `text/turtle`. */
export function normaliseMediaType(contentType: string | undefined): string {
  if (!contentType) return "";
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * Classify a resource for viewing from its media type, with the resource URL as
 * a fallback hint (extension) when the type is missing or generic.
 */
export function chooseViewer(
  contentType: string | undefined,
  url?: string,
): ViewerChoice {
  let mediaType = normaliseMediaType(contentType);
  if (!mediaType || mediaType === "application/octet-stream") {
    mediaType = mediaTypeFromExtension(url) ?? mediaType;
  }

  if (RDF_TYPES.has(mediaType)) return { kind: "rdf", mediaType, embeddable: true };
  if (mediaType.startsWith("image/")) return { kind: "image", mediaType, embeddable: true };
  if (mediaType === "application/pdf") return { kind: "pdf", mediaType, embeddable: true };
  if (mediaType.startsWith("audio/")) return { kind: "audio", mediaType, embeddable: true };
  if (mediaType.startsWith("video/")) return { kind: "video", mediaType, embeddable: true };
  if (TEXT_TYPES.has(mediaType) || mediaType.startsWith("text/")) {
    // text/html is deliberately NOT inline-embeddable (could carry script).
    const embeddable = mediaType !== "text/html";
    return { kind: embeddable ? "text" : "generic", mediaType, embeddable };
  }
  return { kind: "generic", mediaType: mediaType || "unknown", embeddable: false };
}

const EXTENSION_TYPES: Record<string, string> = {
  ttl: "text/turtle",
  jsonld: "application/ld+json",
  nt: "application/n-triples",
  nq: "application/n-quads",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  html: "text/html",
};

function mediaTypeFromExtension(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const path = new URL(url).pathname;
    const ext = path.split(".").at(-1)?.toLowerCase();
    return ext ? EXTENSION_TYPES[ext] : undefined;
  } catch {
    return undefined;
  }
}

/** Human label for a viewer kind (for badges/empty states). */
export function viewerKindLabel(kind: ViewerKind): string {
  switch (kind) {
    case "rdf":
      return "Structured data";
    case "image":
      return "Image";
    case "text":
      return "Text";
    case "pdf":
      return "PDF";
    case "audio":
      return "Audio";
    case "video":
      return "Video";
    default:
      return "File";
  }
}
