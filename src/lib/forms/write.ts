// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * The form-engine write path (Wave 5). Composes the pure edit engine
 * (`subject-edit.ts`) with the existing conditional-PUT primitive
 * (`pod-data.ts writeResource`) so saving a field edit:
 *
 *  1. starts from the dataset that was read (with its ETag),
 *  2. surgically replaces only the edited statements (unrelated triples kept),
 *  3. PUTs the whole document back with `If-Match: <etag>` — so a concurrent
 *     edit fails with 412 instead of clobbering (never silently overwrite),
 *  4. surfaces 403 (no write permission) distinctly from 412 (stale).
 *
 * The fresh ETag from the response is returned so a subsequent edit in the same
 * session can chain without a re-read. Production callers pass NO `fetchImpl`
 * (the auth-patched global runs); tests inject one.
 */
import type { DatasetCore } from "@rdfjs/types";
import { writeResource } from "../pod-data.js";
import { ResourceWriteError } from "../errors.js";
import type { FieldSpec } from "./field-types.js";
import { applyFieldEdit, applyFieldEdits, FieldValidationError } from "./subject-edit.js";

/** Turtle prefixes the form engine emits for readable documents. */
export const FORM_PREFIXES = {
  schema: "https://schema.org/",
  vcard: "http://www.w3.org/2006/vcard/ns#",
  foaf: "http://xmlns.com/foaf/0.1/",
  bookmark: "http://www.w3.org/2002/01/bookmark#",
  dct: "http://purl.org/dc/terms/",
  ui: "http://www.w3.org/ns/ui#",
} as const;

/** The outcome a caller branches on. `stale`/`forbidden` need re-read / permission. */
export type SaveResult =
  | { ok: true; etag: string | null }
  | { ok: false; reason: "stale" | "forbidden" | "validation" | "error"; message: string; fieldId?: string };

export interface SaveOptions {
  /** Test-only fetch override; **omit in production** so the auth-patched global runs. */
  fetchImpl?: typeof fetch;
  /** ETag from the read, sent as `If-Match` (omit only for a deliberate force). */
  etag?: string | null;
  /** Turtle prefixes (defaults to {@link FORM_PREFIXES}). */
  prefixes?: Record<string, string>;
}

/** Map a thrown write/validation error to a structured {@link SaveResult}. */
function toResult(err: unknown): SaveResult {
  if (err instanceof FieldValidationError) {
    return { ok: false, reason: "validation", message: err.message, fieldId: err.fieldId };
  }
  if (err instanceof ResourceWriteError) {
    if (err.status === 412)
      return {
        ok: false,
        reason: "stale",
        message: "This item changed elsewhere. Reload it and try again.",
      };
    if (err.status === 403 || err.status === 401)
      return {
        ok: false,
        reason: "forbidden",
        message: "You do not have permission to edit this item.",
      };
    return { ok: false, reason: "error", message: "Could not save your change. Please try again." };
  }
  return { ok: false, reason: "error", message: "Could not save your change. Please try again." };
}

/**
 * Save a single field edit on a subject. Reads from `dataset`, replaces only the
 * field's triples, and conditionally PUTs the result. Never throws — returns a
 * {@link SaveResult} the UI branches on.
 */
export async function saveFieldEdit(
  url: string,
  dataset: DatasetCore,
  subject: string,
  spec: FieldSpec,
  rawValue: string,
  opts: SaveOptions = {},
): Promise<SaveResult> {
  try {
    const next = applyFieldEdit(dataset, subject, spec, rawValue);
    const { etag } = await writeResource(url, next, {
      etag: opts.etag,
      fetchImpl: opts.fetchImpl,
      prefixes: opts.prefixes ?? FORM_PREFIXES,
    });
    return { ok: true, etag };
  } catch (err) {
    return toResult(err);
  }
}

/**
 * Save several field edits in one document write. `values` is keyed by field
 * `id`; absent keys are left untouched. Validates everything before writing, so
 * a single bad value aborts the whole save with a precise message.
 */
export async function saveFormEdits(
  url: string,
  dataset: DatasetCore,
  subject: string,
  fields: readonly FieldSpec[],
  values: Readonly<Record<string, string>>,
  opts: SaveOptions = {},
): Promise<SaveResult> {
  try {
    const next = applyFieldEdits(dataset, subject, fields, values);
    const { etag } = await writeResource(url, next, {
      etag: opts.etag,
      fetchImpl: opts.fetchImpl,
      prefixes: opts.prefixes ?? FORM_PREFIXES,
    });
    return { ok: true, etag };
  } catch (err) {
    return toResult(err);
  }
}
