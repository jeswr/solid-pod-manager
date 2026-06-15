// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Form resolution (Wave 5 §2): given a subject to edit (and optionally a `ui:`
 * form description), pick the field set, in this precedence:
 *
 *  1. an explicit Solid `ui:` form (`parseUiForm`) — authored, most specific;
 *  2. a first-party typed-view edit map (`edit-map.ts`) — when a known typed
 *     viewer matches the resource (contacts/music/photo/event/bookmark);
 *  3. an auto-generated form from the subject's own properties
 *     (`auto-form.ts`) — the "edit anything" floor.
 *
 * Pure: takes parsed datasets, returns a `ResolvedForm`. The renderer + writer
 * are shared across all three, so the editing UX is identical regardless of
 * which path produced the fields.
 */
import type { DatasetCore } from "@rdfjs/types";
import type { FieldSpec } from "./field-types.js";
import { parseUiForm } from "./ui-form.js";
import { editFieldsFor } from "./edit-map.js";
import { autoFormFor } from "./auto-form.js";
import { buildViewerContext, selectTypedViewer } from "../typed-views/select.js";

/** Where the resolved fields came from (drives UI hints + analytics). */
export type FormSource = "ui-form" | "typed-view" | "auto";

export interface ResolvedForm {
  /** The ordered editable fields. */
  fields: FieldSpec[];
  /** Which strategy produced them. */
  source: FormSource;
  /** The matched typed-viewer id, when `source === "typed-view"`. */
  viewerId?: string;
}

export interface ResolveFormOptions {
  /** A parsed `ui:` form description dataset (overrides everything when present). */
  formDataset?: DatasetCore;
  /** The form's root subject within `formDataset` (auto-discovered when omitted). */
  formSubject?: string;
  /** The Type-Index category id the resource was discovered under (selection hint). */
  categoryId?: string;
}

/**
 * Resolve the editable field set for `subject` inside `dataset`. `dataset` is
 * the resource being edited; `opts.formDataset` (if any) is a separate `ui:`
 * form description.
 */
export function resolveForm(
  url: string,
  dataset: DatasetCore,
  subject: string,
  opts: ResolveFormOptions = {},
): ResolvedForm {
  // 1. An authored ui: form wins.
  if (opts.formDataset) {
    const fields = parseUiForm(opts.formDataset, opts.formSubject);
    if (fields.length > 0) return { fields, source: "ui-form" };
  }

  // 2. A first-party typed-view edit map, when a known viewer matches.
  const ctx = buildViewerContext(url, dataset, opts.categoryId);
  const viewer = selectTypedViewer(ctx);
  if (viewer) {
    const fields = editFieldsFor(viewer.id);
    if (fields && fields.length > 0) {
      return { fields: [...fields], source: "typed-view", viewerId: viewer.id };
    }
  }

  // 3. Auto-generate from the subject's own properties.
  return { fields: autoFormFor(dataset, subject), source: "auto" };
}
