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

Phase P3 (Photos / Events / Bookmarks viewers) — new files:

- `src/lib/typed-views/photo-view.ts` — `schema:ImageObject`/`Photograph`
  matcher + extractor (title/contentUrl/width/height/source). Grounded in
  `MediaItem` (`integrations/core/vocab.ts`) as written by `google-photos` and
  `pinterest` adapters; excludes `schema:VideoObject` from the photo grid.
- `src/lib/typed-views/photo-view.test.ts`
- `src/lib/typed-views/event-view.ts` — `schema:Event` matcher + extractor
  (title/start/end/location/description/source). Grounded in `CalendarEvent`
  (`google-calendar` adapter). Keeps raw ISO dates; the card formats them.
- `src/lib/typed-views/event-view.test.ts`
- `src/lib/typed-views/bookmark-view.ts` — `bookmark:Bookmark` /
  `bookmark:recalls` matcher + extractor (title/href/host). Targets the generic
  interop shape (no integration writes bookmarks today); accepts `schema:url`
  and dc/dct/rdfs title fallbacks; `safeLinkHref`-gates the outbound link.
- `src/lib/typed-views/bookmark-view.test.ts`
- `src/components/typed-views/photo-grid.tsx` — thumbnail grid (remote
  `schema:contentUrl`, `safeLinkHref`-gated) + caption + source action.
- `src/components/typed-views/event-card.tsx` — date/location/title cards;
  locale formatting of the ISO dates via `Intl` in the render layer.
- `src/components/typed-views/bookmark-card.tsx` — favicon (host-keyed) + title
  + host + Open action.

Phase P3 — touched (registration / matcher additions only):

- `src/lib/typed-views/select.ts` — registers `photoViewer`/`eventViewer`/
  `bookmarkViewer` in `TYPED_VIEWERS` (priority 60).
- `src/lib/typed-views/sources.ts` — adds Google Calendar / Google Photos /
  Pinterest matchers to the source-action table.
- `src/lib/typed-views/sources.test.ts` — coverage for the new matchers.
- `src/components/typed-views/registry.tsx` — binds the three viewers to cards.
- `src/components/typed-views/source-action.tsx` — maps the `calendar` icon name
  to the Lucide `CalendarDays` component.

SolidOS-parity QUICK WINS (`docs/solidos-feature-parity.md` §3 Phase A — A2/A3/
A4/A5) — new files:

- `src/lib/literal-format.ts` — A2 pure: human-readable rendering of common RDF
  literal datatypes (xsd date/dateTime/time/duration/boolean/numbers, language
  tags) + `looksLikeMarkdown` heuristic. Unknown/unparsable → raw lexical value
  (never loses data). Uses `Intl` (locale-overridable for deterministic tests).
- `src/lib/literal-format.test.ts`
- `src/lib/typed-views/view-modes.ts` — A3 pure: which view modes a resource
  offers (typed / data / table / source), the initial mode (always `typed` when
  a typed view exists → no-raw-RDF-by-default), and whether to show the tray.
- `src/lib/typed-views/view-modes.test.ts`
- `src/lib/typed-views/table-of-class.ts` — A5 pure: `buildClassTable` (all
  instances of an `rdf:type` → columns/rows model, member-capped) +
  `dominantTabulatableClass` (the class with >= 2 instances) + `classesInDataset`.
- `src/lib/typed-views/table-of-class.test.ts`
- `src/components/typed-views/rdf-table.tsx` — the generic raw-triples table,
  extracted from `resource-viewer.tsx` for reuse by the view-switcher's "Data"
  mode and the under-the-hood panel. Now humanises literals via `formatLiteral`
  (A2) with a subtle language chip; IRIs stay `safeLinkHref`-gated (SEC-2).
- `src/components/typed-views/view-switcher.tsx` — A3 segmented tray; renders the
  pure `view-modes` options, maps icon names to Lucide, reports the chosen mode.
- `src/components/typed-views/under-the-hood.tsx` — A4 collapsed-by-default
  `<details>` panel: URI / content-type / size + raw triples (reuses
  `RdfViewer`); accepts caller-owned `actions` (e.g. the existing Delete).
- `src/components/typed-views/class-table.tsx` — A5 accessible instances table;
  literals humanised (A2), IRIs `safeLinkHref`-gated, "showing N of M" cap note.

SolidOS-parity QUICK WINS — touched:

- `src/lib/resource-view.ts` — `PropertyValue` now carries `datatype`/`language`
  from the parsed literal (enables A2 formatting); `termValue` reads them.
- `src/lib/resource-view.test.ts` — assertion relaxed to `toMatchObject` for the
  new datatype field.
- `src/components/resource-viewer.tsx` — now a client component: the `rdf` kind
  renders the typed card by default with the A3 switcher tray (typed ↔ data ↔
  table ↔ source) and the always-available A4 under-the-hood panel; the `text`
  kind renders Markdown (A2) for `text/markdown` and markdown-ish `text/plain`.
  Extracted `RdfViewer` to `rdf-table.tsx`.
- `src/components/typed-views/registry.tsx` — adds `viewMetaFor(resource)`
  reporting `{ hasTypedView, source, tableClass }` for the switcher.

## Advisory SHACL validation (ADR-0014 Phase 1) — Claude Opus 4.8 (Fable unavailable)

The swappable `ShaclValidator` seam + vendored, hash-pinned shapes + advisory
(non-blocking) validation at the pod write seam. Backed by `rdf-validate-shacl`
now; replaceable by sparq's engine (sparq #162) at `getDefaultValidator()`.
Fable unavailable at authoring time; upgrade candidates pending re-review.

New files:

- `src/lib/shacl/validator.ts` — the `ShaclValidator` interface + the
  `rdf-validate-shacl`-backed impl + the `getDefaultValidator()` swap point.
- `src/lib/shacl/shape-registry.ts` — `forClass` → vendored shape (Turtle).
- `src/lib/shacl/advisory.ts` — the write-seam bridge: validate, surface a
  warning on violation, NEVER throw / NEVER block.
- `src/lib/shacl/ttl.d.ts` — `*.ttl` raw-text module declaration.
- `src/lib/shacl/shapes/issue.ttl` — vendored from `jeswr/solid-issues`
  (byte-identical, hash-pinned).
- `src/lib/shacl/shapes/README.md`, `src/lib/shacl/shapes-lock.json` — provenance
  + hash-pin manifest.
- `scripts/check-shapes.mjs` — the `check:shapes` drift guard.
- `src/lib/shacl/validator.test.ts`, `src/lib/shacl/advisory.test.ts`,
  `src/lib/shacl/shapes-lock.test.ts` — tests.

Touched (wire-in only):

- `src/lib/productivity-store.ts` — `StoreConfig.validate` opt-in + `onAdvisory`
  ctor option; runs advisory validation AFTER each create/update write.
- `src/lib/issues.ts` — `ISSUES_CONFIG.validate = true` (first opted-in
  write-type); `issuesStore` forwards `onAdvisory`.
- `src/components/use-productivity.ts` — default advisory surface (sonner
  warning toast) wired into every store.
- `next.config.ts` / `vitest.config.ts` — `.ttl` raw-text import (webpack
  `asset/source` + a Vite transform).
