// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Enumerate the editable subjects of a typed-view resource (Wave 5 §1). A
 * typed-view document can describe several subjects (e.g. an address book with
 * many `vcard:Individual`s, or a "liked songs" document of many recordings).
 * Inline editing needs the same subject set the matching extractor renders, so
 * each card maps 1:1 to an editable subject.
 *
 * The extractors already expose this: every view-model is `{ items: [...] }`
 * where each item's `id` is its subject IRI. So we run the matched viewer's
 * pure `extract` and read the ids back — guaranteeing the editable subjects are
 * exactly the rendered ones, with no second matching pass to drift out of sync.
 */
import type { DatasetCore } from "@rdfjs/types";
import { buildViewerContext, selectTypedViewer } from "../typed-views/select.js";

/** A subject the UI can offer for inline editing, with a friendly label. */
export interface EditableSubject {
  /** The subject IRI. */
  id: string;
  /** A human label (the item's title/name when the model carries one). */
  label: string;
}

/** A model item carries at least an `id`; most carry a `title` or `name`. */
interface ViewItem {
  id: string;
  title?: string;
  name?: string;
}

/**
 * The editable subjects for a resource, in the typed viewer's own order. Returns
 * `{ viewerId, subjects }` when a viewer matches, else `undefined` (the caller
 * then falls back to auto-form over the document's primary subject).
 */
export function editableSubjects(
  url: string,
  dataset: DatasetCore,
  categoryId?: string,
): { viewerId: string; subjects: EditableSubject[] } | undefined {
  const ctx = buildViewerContext(url, dataset, categoryId);
  const viewer = selectTypedViewer(ctx);
  if (!viewer) return undefined;
  const model = viewer.extract(ctx) as { items?: ViewItem[] };
  const items = model.items ?? [];
  return {
    viewerId: viewer.id,
    subjects: items.map((it) => ({ id: it.id, label: it.title ?? it.name ?? it.id })),
  };
}
