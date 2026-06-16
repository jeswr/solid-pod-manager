# Vendored SHACL shapes

These are **vendored, hash-pinned** SHACL shapes the Pod Manager validates its
pod writes against (advisory only — see `../validator.ts` and ADR-0014 Phase 1).

Each file is **byte-identical** to its upstream source so its content hash is
verifiable against that source. They are pinned in `../shapes-lock.json`
(sha256 + source repo/path/commit) and guarded by `npm run check:shapes`, which
fails if any vendored shape drifts from the lock — a shape can never change
silently.

## Where each shape came from

| File | Source | Describes |
|---|---|---|
| `task.ttl` | [`jeswr/solid-task-model` `shapes/task.ttl`](https://github.com/jeswr/solid-task-model/blob/main/shapes/task.ttl) (commit `eebcaf7`) | The SHARED federated Task/Issue model — the cross-app common denominator of the suite's `wf:Task` contract: `dct:title`, body (BOTH `wf:description` AND `dct:description`), `wf:assignee` (WebID), timestamps, `prov:endedAtTime`, and the binary `wf:Open`/`wf:Closed` state. The PM writes `wf:Task` via `src/lib/issues.ts` (delegating to `@jeswr/solid-task-model`); validating against this shape keeps PM-authored issues federation-compatible with solid-issues and every other suite app. Byte-identical to the package's `shapes/task.ttl` (== `taskShapeTtl()`), asserted in `../shapes-lock.test.ts`. |

## Updating a vendored shape

1. Re-copy the file from its upstream source (keep it byte-identical — do **not**
   hand-edit).
2. Recompute its sha256 (`shasum -a 256 <file>`) and update the entry in
   `../shapes-lock.json`, bumping `source.commit`.
3. Commit the `.ttl` and the lock bump **in the same change**.
4. `npm run check:shapes` must pass.

## Why not vendor every suite shape?

Only shapes whose `sh:targetClass` matches a class the PM actually writes are
useful here — an unmatched shape would either never fire or (worse) fire false
advisories. The contacts crawler's `foaf:Person` shape (`jeswr/contacts`), for
example, requires a `dct:source` ingest-provenance field the PM's
`vcard:Individual` contacts model does not carry, so it is deliberately **not**
vendored. Add a shape here only when it matches a PM write-type, register it in
`../shape-registry.ts`, and pin it in the lock.
