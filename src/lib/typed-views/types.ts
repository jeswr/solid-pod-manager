// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * The pure, node-testable contract for typed data-views (design:
 * `docs/typed-data-views.md` §4). A typed viewer is a *matcher* + a pure
 * *extractor* producing a plain, serialisable view-model. No React, no DOM, no
 * I/O — the React renderers in `src/components/typed-views/` consume the models.
 *
 * Selection is primarily by `rdf:type` (most specific, always read from the
 * resource's own quads), with the Type-Index category id and a predicate-shape
 * check as secondary signals inside each viewer's `matches`. When nothing
 * matches, the caller falls back to the existing generic `RdfViewer` triple
 * table — the explicit unknown-type fallback.
 */
import type { DatasetCore } from "@rdfjs/types";

/** Everything a viewer needs to decide + extract, with zero I/O. */
export interface ViewerContext {
  /** The resource (document) URL. */
  url: string;
  /** Parsed quads of the resource. */
  dataset: DatasetCore;
  /** `rdf:type` IRIs present on any subject in the resource (precomputed). */
  types: ReadonlySet<string>;
  /** Optional Type-Index category id the resource was discovered under (§3). */
  categoryId?: string;
}

/**
 * A typed viewer = a matcher + a pure extractor producing a serialisable model.
 * `M` is the view-model the bound React renderer consumes.
 */
export interface TypedViewer<M = unknown> {
  /** Stable id, e.g. "contacts", "music". */
  id: string;
  /** Higher wins when several match; ties broken by registration order (§4.4). */
  priority: number;
  /** Cheap predicate: does this viewer understand the resource? */
  matches(ctx: ViewerContext): boolean;
  /** Pure extraction into a plain model the React renderer consumes. */
  extract(ctx: ViewerContext): M;
}
