// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Typed-viewer registry + selection (design: `docs/typed-data-views.md` §4.3).
 *
 * The pure half of the registry: the list of registered `TypedViewer`s and the
 * selection algorithm. Binding each viewer to its React renderer happens in the
 * render-side registry (`src/components/typed-views/registry.tsx`); this layer
 * stays DOM-free and node-testable.
 *
 * Selection is `rdf:type`-first (read from the resource's own quads), priority
 * ordered, with category + predicate-shape as secondary signals *inside* each
 * viewer's `matches`. No candidate → `undefined` → the caller falls back to the
 * generic `RdfViewer` triple table (the explicit unknown-type fallback, §4.5).
 */
import type { DatasetCore, Quad } from "@rdfjs/types";
import type { TypedViewer, ViewerContext } from "./types.js";
import { contactsViewer } from "./contacts-view.js";
import { musicViewer } from "./music-view.js";
import { photoViewer } from "./photo-view.js";
import { eventViewer } from "./event-view.js";
import { bookmarkViewer } from "./bookmark-view.js";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/**
 * The registered viewers, highest specificity first (registration order is the
 * tie-break for equal priorities). New viewers are added here — one line each.
 * Contacts and Music share priority 70 but target disjoint shapes (vcard vs
 * schema music); Photo/Event/Bookmark sit at 60. All target disjoint shapes, so
 * the tie-break never decides between them in practice.
 */
export const TYPED_VIEWERS: readonly TypedViewer[] = [
  contactsViewer,
  musicViewer,
  photoViewer,
  eventViewer,
  bookmarkViewer,
];

/** Collect every `rdf:type` IRI on any subject in the dataset (precompute). */
export function collectTypes(dataset: DatasetCore): Set<string> {
  const types = new Set<string>();
  for (const quad of dataset as Iterable<Quad>) {
    if (quad.predicate.value === RDF_TYPE && quad.object.termType === "NamedNode") {
      types.add(quad.object.value);
    }
  }
  return types;
}

/**
 * Build a {@link ViewerContext} from a parsed resource. `types` is precomputed
 * once here so each viewer's `matches` is a cheap set lookup.
 */
export function buildViewerContext(
  url: string,
  dataset: DatasetCore,
  categoryId?: string,
): ViewerContext {
  return { url, dataset, types: collectTypes(dataset), categoryId };
}

/**
 * Pick the best typed viewer for a context, or `undefined` if none match (the
 * caller then renders the generic fallback table). Stable: among equal-priority
 * matches, the one registered earlier in {@link TYPED_VIEWERS} wins.
 */
export function selectTypedViewer(
  ctx: ViewerContext,
  registry: readonly TypedViewer[] = TYPED_VIEWERS,
): TypedViewer | undefined {
  let best: { viewer: TypedViewer; index: number } | undefined;
  registry.forEach((viewer, index) => {
    if (!viewer.matches(ctx)) return;
    if (
      best === undefined ||
      viewer.priority > best.viewer.priority ||
      // equal priority → keep the earlier registration (lower index)
      (viewer.priority === best.viewer.priority && index < best.index)
    ) {
      best = { viewer, index };
    }
  });
  return best?.viewer;
}
