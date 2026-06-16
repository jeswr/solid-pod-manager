// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Maps a write-type's RDF class to the vendored SHACL shape that validates it
 * (ADR-0014 Phase 1).
 *
 * The shapes are vendored, byte-identical to upstream, and hash-pinned in
 * `shapes-lock.json` (guarded by `npm run check:shapes`). They are imported as
 * raw Turtle text so the validator (which parses with N3) is engine-agnostic
 * and works in the browser bundle.
 *
 * Add a shape here ONLY when its `sh:targetClass` matches a class the PM
 * actually writes — see `shapes/README.md`. A class with no registered shape
 * simply isn't validated (advisory validation is opt-in per write-type).
 */
import taskShape from "./shapes/task.ttl";

const WF = "http://www.w3.org/2005/01/wf/flow#";

/**
 * `forClass` IRI → SHACL shapes graph (Turtle). The PM writes `wf:Task` issues
 * via `src/lib/issues.ts` (delegating to `@jeswr/solid-task-model`); the vendored
 * SHARED task shape (`task.ttl`, byte-identical to the package's `taskShapeTtl()`)
 * validates them for federation compatibility with solid-issues and every other
 * suite app. The shape constrains BOTH `wf:description` and `dct:description`
 * (the dual-predicate body the shared model co-writes), the `wf:assignee` WebID,
 * and the binary `wf:Open`/`wf:Closed` state.
 */
const SHAPES_BY_CLASS: Readonly<Record<string, string>> = {
  [`${WF}Task`]: taskShape,
};

/**
 * The vendored shapes graph (Turtle) that validates writes of `forClass`, or
 * `undefined` when no shape is registered for that class (then validation is
 * simply skipped — never an error).
 */
export function shapesForClass(forClass: string): string | undefined {
  return SHAPES_BY_CLASS[forClass];
}

/** True when a vendored shape exists for `forClass`. */
export function hasShapeForClass(forClass: string): boolean {
  return forClass in SHAPES_BY_CLASS;
}
