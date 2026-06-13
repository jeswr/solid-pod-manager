// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * The pure rebase decision for the inline edit hook (`useFormEdit`).
 *
 * The hook keeps a LOCAL baseline (the dataset + ETag it saves against) so that
 * after a successful save it can chain a second edit off the new state without a
 * refetch. It must adopt a *fresh read* from its parent (e.g. after a "changed
 * elsewhere" reload) — but it must NOT clobber that local baseline just because
 * the parent re-rendered with a newly-allocated `fields` array (a common React
 * footgun: an auto-form computed inline is a new array every render).
 *
 * This isolates that decision as a pure predicate so it can be regression-tested
 * in node without a DOM: rebase iff the upstream dataset OBJECT identity or the
 * ETag value actually changed. `fields`/`subject` identity is deliberately NOT a
 * trigger.
 */
import type { DatasetCore } from "@rdfjs/types";

/** The upstream read the hook is handed each render. */
export interface UpstreamRead {
  dataset: DatasetCore;
  etag: string | null;
}

/**
 * Should the hook rebase its local baseline onto `next`? True only when the
 * upstream dataset object changed (a genuinely new parse) or the ETag value
 * changed. A reallocated-but-equivalent `fields` array does not affect this.
 */
export function shouldRebase(prev: UpstreamRead, next: UpstreamRead): boolean {
  return prev.dataset !== next.dataset || prev.etag !== next.etag;
}
