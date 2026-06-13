# Model provenance

Some files in this repository were authored by an AI model and are flagged for
human re-review (and possible re-authoring with a stronger model when one is
available). Each such file carries a top-of-file `// AUTHORED-BY …` marker.

## Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate

Authored as part of the rich typed data-views work (`docs/typed-data-views.md`,
phase P1). Fable was unavailable at authoring time; these are upgrade
candidates pending re-review.

Pure layer (`src/lib/typed-views/`):

- `src/lib/typed-views/types.ts`
- `src/lib/typed-views/select.ts`
- `src/lib/typed-views/sources.ts`
- `src/lib/typed-views/contacts-view.ts`
- `src/lib/typed-views/sources.test.ts`
- `src/lib/typed-views/select.test.ts`
- `src/lib/typed-views/contacts-view.test.ts`

React layer (`src/components/typed-views/`):

- `src/components/typed-views/registry.tsx`
- `src/components/typed-views/contacts-card.tsx`
- `src/components/typed-views/source-action.tsx`

Touched (wire-in only, not net-new files):

- `src/components/use-resource.ts` — keeps `dataset`/`categoryId` on
  `LoadedResource` for the `rdf` kind (no extra fetch).
- `src/components/resource-viewer.tsx` — the `"rdf"` branch tries the typed-view
  registry first, then falls back to the generic `RdfViewer` triple table.
