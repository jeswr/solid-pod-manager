// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * A swappable SHACL-validation seam (ADR-0014 Phase 1).
 *
 * ## Why a seam
 *
 * The Pod Manager validates the RDF it is about to write to a pod against
 * vendored SHACL shapes — **advisory only** (it never blocks or rejects a
 * user's write; shapes guide, they do not gate). Today the backing engine is
 * [`rdf-validate-shacl`](https://github.com/zazuko/rdf-validate-shacl). The
 * **migration trigger** is sparq #162: once sparq lands a callable SHACL API,
 * a `SparqShaclValidator` becomes a drop-in replacement here. Every call site
 * depends ONLY on the {@link ShaclValidator} interface and
 * {@link getDefaultValidator} — so swapping the engine is changing one factory,
 * not the consumers.
 *
 * ## Browser-safe by construction
 *
 * The PM is `output: "export"` (a static client-side bundle), so the validator
 * runs in the browser. We use `@zazuko/env` (the browser-safe dataset factory)
 * — NOT `@zazuko/env-node`, which pulls Node `fs`/stream parsers we neither
 * need nor can ship to the browser. Turtle is parsed with the N3 parser the PM
 * already depends on; quads are fed straight into an env dataset (no
 * serialise round-trip), exactly the pattern solid-issues' shape tests use, so
 * results match.
 */
import { Parser, type Quad } from "n3";
import env from "@zazuko/env";
import RdfValidateShacl from "rdf-validate-shacl";

/** A single SHACL constraint violation, flattened to the fields the UI needs. */
export interface ValidationResult {
  /** The constraint path that failed (e.g. `http://purl.org/dc/terms/title`). */
  path?: string;
  /** The focus node the violation is about. */
  focusNode?: string;
  /** A human-readable message (the shape's `sh:message`, when present). */
  message?: string;
  /**
   * Severity IRI — `sh:Violation` (default), `sh:Warning`, or `sh:Info`. The PM
   * treats ALL of these as advisory; severity is surfaced so the UI can phrase
   * the warning, never to gate a write.
   */
  severity?: string;
}

/** The outcome of validating a data graph against a shapes graph. */
export interface ValidationReport {
  /** `true` when the data graph satisfies every shape. */
  conforms: boolean;
  /** One entry per violation (empty when `conforms`). */
  results: ValidationResult[];
}

/**
 * The swappable validation seam. An implementation validates a data graph
 * against a shapes graph and returns a structured, engine-agnostic report.
 *
 * Inputs are Turtle text so the interface is engine-neutral: an
 * `rdf-validate-shacl` impl parses with N3; a future `sparq` impl can parse
 * however it likes. Neither the shape source nor the data builder need to know
 * which engine is behind the seam.
 */
export interface ShaclValidator {
  /**
   * Validate `dataTtl` against `shapesTtl`.
   *
   * @param dataTtl   - the data graph to check, as Turtle.
   * @param shapesTtl - the SHACL shapes graph, as Turtle.
   * @returns a conformance report. Implementations MUST NOT throw on a
   *   *non-conforming* graph (that is a normal `conforms:false` result); they
   *   may reject only on a genuinely unparseable input.
   */
  validate(dataTtl: string, shapesTtl: string): Promise<ValidationReport>;
}

/** Parse Turtle into a `@zazuko/env` dataset (clownface-capable, as the engine needs). */
function ttlToDataset(ttl: string) {
  const ds = env.dataset();
  const quads = new Parser().parse(ttl) as Quad[];
  for (const q of quads) ds.add(q);
  return ds;
}

/**
 * The current default implementation, backed by `rdf-validate-shacl`.
 *
 * Replaceable per ADR-0014 / sparq #162: a `SparqShaclValidator implements
 * ShaclValidator` would be substituted in {@link getDefaultValidator} with no
 * change to any caller.
 */
export class RdfValidateShaclValidator implements ShaclValidator {
  async validate(dataTtl: string, shapesTtl: string): Promise<ValidationReport> {
    const shapes = ttlToDataset(shapesTtl);
    const data = ttlToDataset(dataTtl);
    const validator = new RdfValidateShacl(shapes, { factory: env });
    const report = await validator.validate(data);
    return {
      conforms: report.conforms,
      results: report.results.map((r) => ({
        path: r.path?.value,
        focusNode: r.focusNode?.value,
        message:
          r.message
            ?.map((m) => m.value)
            .filter(Boolean)
            .join(" ") || undefined,
        severity: r.severity?.value,
      })),
    };
  }
}

let defaultValidator: ShaclValidator | undefined;

/**
 * The process-wide default validator (lazily constructed).
 *
 * **This is the single swap point.** To migrate to sparq's engine (sparq #162),
 * change the constructor here — every consumer (the write seam, tests) goes
 * through this factory and the {@link ShaclValidator} interface, so nothing
 * else changes.
 */
export function getDefaultValidator(): ShaclValidator {
  defaultValidator ??= new RdfValidateShaclValidator();
  return defaultValidator;
}

/** Test-only override of the default validator (e.g. to inject a fake/spy). */
export function setDefaultValidatorForTesting(v: ShaclValidator | undefined): void {
  defaultValidator = v;
}
