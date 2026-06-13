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

Phase P2 (Music / liked-songs viewer) — new files:

- `src/lib/typed-views/music-view.ts` — `schema:MusicRecording`/`MusicPlaylist`
  matcher + extractor (title/artist/album/duration/source) and
  `humanizeDuration`. Reads `schema:image`/`schema:thumbnailUrl` *if present*
  (none imported today) and degrades to a music-note icon.
- `src/lib/typed-views/music-view.test.ts`
- `src/components/typed-views/music-card.tsx` — cover-art rows + "Open in
  Spotify" action; icon fallback when no art triple exists.

Phase P2 — touched (registration / follow-up note only):

- `src/lib/typed-views/select.ts` — registers `musicViewer` in `TYPED_VIEWERS`.
- `src/components/typed-views/registry.tsx` — binds the music viewer to its card.
- `src/lib/integrations/spotify/adapter.ts` — comment-only FOLLOW-UP note that a
  one-line `album.images[0].url` → `schema:image` change would populate real
  cover art (no behaviour change made).
