// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Advisory SHACL validation at the pod write seam (ADR-0014 Phase 1, pss-gc1).
 *
 * The Pod Manager runs the {@link ShaclValidator} against the graph it is about
 * to write, matched to the vendored shape for the write's RDF class. A
 * violation is surfaced as an **advisory** (a warning) and NEVER blocks or
 * rejects the user's write — the PM is a consumer app; shapes guide, they do
 * not gate. This module is the bridge the generic `ProductivityStore` calls; it
 * is deliberately side-effect-isolated:
 *
 * - it serialises the built dataset, validates it, and on a violation calls the
 *   caller-supplied `onAdvisory` handler (a UI toast, a log line) — but it
 *   ALWAYS resolves, never throws, even if validation itself errors. The write
 *   path proceeds regardless.
 */
import type { DatasetCore } from "@rdfjs/types";
import { serializeTurtle } from "../pod-data.js";
import { getDefaultValidator, type ShaclValidator, type ValidationResult } from "./validator.js";
import { shapesForClass } from "./shape-registry.js";

/** What the UI/log layer receives when a write fails advisory validation. */
export interface AdvisoryNotice {
  /** The RDF class that was validated (the write-type). */
  forClass: string;
  /** The resource URL being written. */
  url: string;
  /** The constraint violations (non-empty). */
  results: ValidationResult[];
}

/**
 * Called with an {@link AdvisoryNotice} when a write does not conform. The
 * handler MUST be non-blocking (a toast, a console warning); it must not throw
 * and must not be relied on to gate the write. Synchronous by contract — the
 * write seam does not await it.
 */
export type AdvisoryHandler = (notice: AdvisoryNotice) => void;

/** Options controlling one advisory-validation pass. */
export interface AdvisoryValidationOptions {
  forClass: string;
  url: string;
  /** Where a violation is surfaced. Omit to skip surfacing (still logs). */
  onAdvisory?: AdvisoryHandler;
  /** Override the engine (default: {@link getDefaultValidator}). */
  validator?: ShaclValidator;
}

/**
 * Validate `dataset` against the vendored shape for `forClass`, advisory-only.
 *
 * - No shape registered for `forClass` → no-op (resolves, nothing surfaced).
 * - Conforms → no-op.
 * - Violates → `console.warn` + `onAdvisory(notice)`.
 * - Validation itself errors (parse/engine) → swallowed with a `console.warn`;
 *   NEVER propagated. Advisory validation can never break a write.
 *
 * Returns the report-ish summary (for tests); callers MUST NOT branch on it to
 * decide whether to write — the write proceeds unconditionally.
 */
export async function validateAdvisory(
  dataset: DatasetCore,
  opts: AdvisoryValidationOptions,
): Promise<{ validated: boolean; conforms: boolean; results: ValidationResult[] }> {
  const shapesTtl = shapesForClass(opts.forClass);
  if (!shapesTtl) {
    // No shape for this write-type → advisory validation is opt-in per class.
    return { validated: false, conforms: true, results: [] };
  }

  try {
    const dataTtl = await serializeTurtle(dataset);
    const validator = opts.validator ?? getDefaultValidator();
    const report = await validator.validate(dataTtl, shapesTtl);
    if (!report.conforms) {
      // Advisory only: surface, never throw, never block.
      console.warn(
        `[shacl] advisory: ${opts.url} does not conform to the ${opts.forClass} shape ` +
          `(${report.results.length} issue(s)) — write proceeds anyway.`,
        report.results,
      );
      opts.onAdvisory?.({ forClass: opts.forClass, url: opts.url, results: report.results });
    }
    return { validated: true, conforms: report.conforms, results: report.results };
  } catch (e) {
    // A validation/parse failure must never break the write — it is advisory.
    console.warn(`[shacl] advisory validation skipped for ${opts.url} (validator error):`, e);
    return { validated: false, conforms: true, results: [] };
  }
}
