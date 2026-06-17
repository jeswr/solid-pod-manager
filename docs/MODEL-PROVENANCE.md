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

## Offline-first durable read cache — Claude Opus 4.8 (Fable unavailable)

A durable, WebID-scoped, versioned `localStorage` snapshot of the expensive pod
read models, mirrored by the in-memory SWR cache, so a cold open / app reopen
paints the last-good value instantly (no loading screen) and revalidates in the
background. Same shape as `jeswr/solid-issues` `issue-cache.ts`, generalised to
any `(WebID, key)` model. Fable unavailable at authoring time; upgrade candidate.

New files:

- `src/lib/durable-cache.ts` — the durable snapshot layer (WebID-scoped +
  versioned + age-bounded + best-effort `localStorage`); injectable `SyncStorage`.
- `src/lib/durable-cache.test.ts` — WebID-scoping, version/age/mismatch misses,
  clear-on-logout/account-switch, best-effort error handling.

Touched:

- `src/lib/swr-cache.ts` — `DurableStore` port + `hydrate()`; `set` mirrors to
  durable, `clearWebId`/`clearAll`/`invalidate` wipe durable too.
- `src/lib/swr-cache.test.ts` — durable-persistence + cold-open survival tests.
- `src/components/use-swr-read.ts` — synchronous `hydrate()` seed on mount.
- `src/components/use-activity.ts` — "Recent activity" routed through `useSwrRead`
  (was raw fetch-on-mount; now survives navigation + cold open, shared feed).
- `src/app/page.tsx` — non-blocking "Refreshing…" affordance on Recent activity.

## WebID-index people search — Claude Opus 4.8 (Fable unavailable)

Wires the Pod Manager's contacts page to the `solid-webid-index` consumer
client so users can search the public WebID index by name/WebID, add a result as
a contact (PM's existing contacts store), or suggest a WebID to the index's LDN
inbox. Gated entirely on the `NEXT_PUBLIC_WEBID_INDEX` build-time env var (feature
hidden when unset). The client is a vendored thin copy of
`jeswr/solid-webid-index` `src/lib/client/` (that repo is `private:true` with no
`exports` map, so not yet GitHub-installable as `solid-webid-index/client`).
Fable unavailable at authoring time; upgrade candidates.

New files:

- `src/lib/webid-index-client.ts` — vendored framework-agnostic index client
  (search / fetchPage / isIndexed / checkHealth / suggestWebId); same-origin
  `fetchPage` guard, `https:`-only photo guard, fail-closed `isIndexed`,
  credentials-omit on every request; `createIndexClient` returns `null` when no
  origin is configured. Cited mirror of the upstream source.
- `src/lib/webid-index-client.test.ts` — exhaustive client tests (RDF projection,
  SSRF/same-origin guard, photo guard, fail-closed lookup, suggest mapping +
  validation, credentials-omit, env-gated null factory).
- `src/lib/native-fetch.ts` — a snapshot of the UNPATCHED native `fetch`, taken
  at module-load time (before Solid auth patches `globalThis.fetch`); used for
  third-party index requests so the user's DPoP auth / 401-upgrade is never
  attached to the foreign index origin.
- `src/lib/webid-index.ts` — `NEXT_PUBLIC_WEBID_INDEX` config + shared client +
  `isWebIdIndexEnabled` flag (passes `nativeFetch`, never the auth fetch).
- `src/components/use-webid-search.ts` — `useWebIdSearch` / `useIsIndexed` hooks
  over the client via the shared `useSwrRead` cache (keyed `webid-search:<q>` /
  `webid-indexed:<webid>`); gated on the feature flag; pure `searchKey`/`indexedKey`.
- `src/components/use-webid-search.test.ts` — gating/keying tests + structural guard.
- `src/components/webid-index-search.tsx` — the search panel (box → name/avatar/
  WebID result cards with "Add as contact" + "Suggest to index"); pure
  `indexEntryToContact` mapping.
- `src/components/webid-index-search.test.tsx` — render + add-as-contact + suggest tests.

Touched:

- `src/app/contacts/page.tsx` — mounts the search panel above the contacts list,
  gated on `isWebIdIndexEnabled`.
- `src/components/session-provider.tsx` — eager `import "@/lib/native-fetch"` so
  the native-fetch snapshot is taken before `registerGlobally()` patches the
  global fetch.
- `src/components/instant-nav.test.ts` — classifies `use-webid-search.ts` as a
  READ hook + exempts its query-driven hooks from the page registry (with reasons).

## Private type index → preferences file (task #87, G1/P0 privacy) — Claude Opus 4.8 (Fable unavailable)

Relocates the `solid:privateTypeIndex` link OFF the world-readable WebID card and
INTO the owner-private Preferences Document (`space:preferencesFile`), per the
type-index spec (https://solid.github.io/type-indexes/). The card-hosted link
leaked the existence + URL of the user's private data index to the whole web;
the fix discovers (or creates + WAC-locks owner-only) the prefs file, links the
private index from there, migrates a legacy card link (move to prefs + strip
from the card, idempotent), and falls back to the card for legacy pods. The
public type index stays on the card (it is meant to be public). Fable unavailable
at authoring time; upgrade candidates.

New files:

- `src/lib/preferences.ts` — typed `ProfilePreferencesAnchor` (card →
  `space:preferencesFile`) + `PreferencesDoc` (`space:ConfigurationFile`) wrappers;
  `ensurePreferencesFile` (discover/create-and-link, owner-only WAC via
  `lockOwnerOnly` built on `@solid/object` `Authorization`/`AclResource`);
  `resolvePrivateIndex` legacy-fallback helper lives in `type-index.ts`.
- `src/lib/preferences.test.ts` — `parseRdf`/`n3.Writer`-driven tests (fetch
  stubbed): owner-only ACL creation, create-and-link, reuse, fail-closed ACL PUT.

Touched:

- `src/lib/type-index.ts` — `resolvePrivateIndex` (prefs-first, legacy-card
  fallback) + `discoverRegistrations` now resolves the private index that way.
- `src/lib/type-index-write.ts` — `ensurePrivateIndexLink` + `migratePrivateIndexLink`
  (move legacy card link to prefs, strip from card); bootstraps the private index
  in the prefs file; tolerates a dangling legacy index pointer (mint-on-404).
- `src/lib/type-index-manage.ts` — `listAllRegistrations` resolves the private
  index via the prefs file (the `/settings/type-index` manager view).
- `src/app/settings/type-index/page.tsx` — one-line privacy assurance on the
  private-index card.
- `src/lib/integrations/core/testing.ts` — memory pod now serves a
  `Link: rel="acl"` header so ACL discovery works in write-path tests.
- `src/lib/type-index-write.test.ts`, `src/lib/assign-task.test.ts` — updated to
  the prefs-file-hosted private index + migration coverage.

## App preferences in the pod (task #89, G2/P0) — Claude Opus 4.8 (Fable unavailable)

Moves Pod Manager's own UI/UX preferences (Community channel subscriptions +
per-thread read markers, theme, a generic small key→value escape hatch) OUT of
`localStorage` (which no longer follows the user across devices/browsers and is
lost on cache-clear) and INTO the owner-private pod preferences file, composing
with G1 (#87): app-prefs are a dedicated `pm:AppPreferences` subject
(`<prefsFile>#podmanager`) inside G1's `space:preferencesFile`, inheriting its
owner-only WAC. The pod is AUTHORITATIVE; `localStorage` survives only as the
SWR-durable instant-paint MIRROR (the `app-prefs:` durable codec) and the source
of the one-time migration. Reads go through `useSwrRead("app-prefs:<storage>",
…)` (cache-first paint + background pod revalidate + durable cold-open); writes
are optimistic + non-blocking (paint+cache now, persist async, revert + toast on
failure, "Saving…" indicator). A one-time, idempotent migration writes legacy
localStorage Community prefs up to the pod on first load when the pod has none.
Typed `@rdfjs/wrapper` accessors only; the write is conditional (`If-Match`) and
preserves every foreign triple (G1's `solid:privateTypeIndex` link survives).
Fable unavailable at authoring time; upgrade candidates.

New files:

- `src/lib/app-prefs.ts` — the pod-backed model: typed `AppPreferences` /
  `PrefEntry` `@rdfjs/wrapper` subjects (`pm:` vocab, `https://w3id.org/jeswr/pod-manager#`);
  `readAppPrefs`/`buildAppPrefsDataset` (RDF round-trip, foreign-triple-preserving
  read-modify-write); `fetchAppPrefs`/`writeAppPrefs` (ensure-via-G1 → conditional
  PUT); `migrateLegacyPrefs` (one-time, idempotent) + its gates
  (`isUnstoredDefault`/`legacyHasCustomisation`); `persistOptimistic`
  (optimistic write + revert); `appPrefsKey` (storage-scoped SWR key).
- `src/components/use-app-prefs.ts` — `useAppPrefs` read hook (SWR over the
  durable mirror + background pod revalidate), optimistic `setPrefs`/`setCommunity`,
  one-time migration effect, "Saving…" flag.
- `src/lib/app-prefs.test.ts` — `parseRdf`/`n3.Writer`-driven tests (fetch
  stubbed; in-memory storage/cache doubles): RDF round-trip, foreign-triple
  preservation, orphan removal, read-from-pod (defaults on miss), one-time +
  idempotent migration, optimistic write + revert, cross-storage key isolation,
  localStorage-mirror cold-open.

Touched:

- `src/components/use-community.ts` — `useCommunityPrefs` is now a thin
  Community-view-shaped facade over `useAppPrefs` (pod-backed); the Community
  page is unchanged. `useCommunityFeed` wiring untouched.
- `src/lib/community-prefs.ts` — doc note updated: pod is authoritative,
  localStorage is the mirror + migration source; the pure `CommunityPrefs`
  shape + helpers remain.
- `src/lib/durable-cache.ts` — registers the `app-prefs:` JSON durable codec
  (the localStorage mirror).
- `src/lib/prefetch.ts` — proactive prefetch target for `useAppPrefs`
  (instant first visit to /community + /settings).
- `src/components/instant-nav-registry.ts`, `src/components/instant-nav.test.ts`,
  `src/components/instant-nav-prefetch.test.ts`, `src/components/use-community.test.ts`
  — registry entry + structural/storage-switch/prefetch-completeness coverage
  for `useAppPrefs`; updated `useCommunityPrefs` exemption + facade assertions.

## Federations discovery view (`/federations`, pss #90) — Opus 4.8

Gated, read-only directory of registry-asserted federation memberships consumed
from `@jeswr/federation-client`'s `discoverFromRegistry`. Feature-gated on
`NEXT_PUBLIC_FEDERATION_REGISTRY` (ships dark). Authored by Claude Opus 4.8
(Fable unavailable) — re-review/upgrade candidate.

New:

- `src/lib/federation-registry.ts` — env-gated config + thin SDK consumer;
  passes the pristine pre-patch native fetch to the third-party registry origin.
- `src/lib/federation-members.ts` — pure presentation helpers (friendly name,
  status badge variant, authority label, document-error builder).
- `src/components/use-federation-registry.ts` — `useFederationMembers` over
  `useSwrRead` (instant-nav), gated + empty-key-inert.
- `src/app/federations/page.tsx` — the read-only list view (honest, no-crypto-
  trust copy).
- `src/lib/node-net-browser-shim.ts` / `src/lib/empty-module.ts` — browser
  replacements for the SDK's Node-only `node:net`/`node:dns/promises` (static
  export). REMOVED in feat/drop-net-shim (pss #96): the upstream follow-up
  shipped — `@jeswr/federation-client` ≥ `5ec0461` (pss #92) has a browser-safe
  DNS-less SSRF mode (no top-level `node:` import), so the shim + the
  `NormalModuleReplacementPlugin` are no longer needed.
- Tests: `use-federation-registry.test.ts`, `federations-page.test.tsx`,
  `nav-items.test.ts`, `federation-members.test.ts`.

Touched (additive):

- `src/components/nav-items.ts` — one conditional `/federations` nav entry +
  `visibleNavItems()`; `src/components/sidebar-nav.tsx` renders `visibleNavItems()`.
- `src/components/instant-nav-registry.ts` / `instant-nav.test.ts` — registry +
  READ_HOOKS + PREFETCH_EXEMPT entries for the new read hook.
- `package.json` — `@jeswr/federation-client` (github:#main); `next.config.ts` —
  formerly carried a `NormalModuleReplacementPlugin` for the SDK's `node:`
  builtins (removed in feat/drop-net-shim / pss #96 — see above).

## Claude Opus 4.8 — SolidOS `meeting:LongChat` reader (task #95 / G4)

Read-first interop: PM's `/chat` renders a SolidOS-authored `meeting:LongChat`
channel read-only. Terms primary-source-confirmed against
`solidos/chat-pane/shapes/longchat-shapes.ttl` + the two example fixtures.

Net-new:

- `src/lib/longchat.ts` — typed `@rdfjs/wrapper` accessors + `parseLongChatMessages`
  (edit chains collapse to latest, `schema:dateDeleted` → tombstone, plain-text
  bodies only).
- `src/lib/longchat.test.ts` — fixtures from the SolidOS example shapes.

Touched:

- `src/lib/chat.ts` — detect-and-read (`Chat.messages` probes `index.ttl`;
  `meeting:LongChat` → read-only long-chat reader incl. dated `YYYY/MM/DD` files,
  else native `sioc:Note`); foreign-origin read-only path via `getNativeFetch` +
  `agent-target` SSRF guard, gated on `NEXT_PUBLIC_FOREIGN_CHAT_READ`;
  `chatContainerFromUrl` normaliser; read-only `send` guard.
- `src/components/use-chat.ts` — `readOnly` flag; `allowForeign` wiring.
- `src/app/chat/page.tsx` — read-only "external chat" note replaces the compose box.

## Claude Opus 4.8 — shared `wf:Tracker` read path (task #100 / G7 Builder consumer)

Read-only consumption of the newly-published shared `wf:Tracker` model. PM's
`/issues` read path surfaces the tracker-document metadata (title, issue class,
state store, categories, assignee group, workflow states + transitions) when the
Issues container carries a `wf:Tracker` config doc (`<container>index.ttl#this`,
the SolidOS / solid-issues convention). Typed via the shared model — never raw
RDF (#61). Same-pod authenticated read (NOT the foreign-origin boundary).

Dependency: `@jeswr/solid-task-model` pinned to `github:jeswr/solid-task-model#e5ee9ee`
(v0.2.0, the published `./tracker` client-safe subexport). Imported ONLY from
`@jeswr/solid-task-model/tracker` — the barrel `.` pulls `node:fs` via shape.ts
and would break the Next static export.

Net-new:

- `src/lib/tracker.ts` — `readTrackerMeta` (probes `index.ttl`, 404 ⇒ none,
  403/5xx/parse ⇒ fail-closed re-throw, 200-non-tracker ⇒ none), `toTrackerMeta`,
  `toWorkflowStates` (resolves open/closed + transitions via the shared
  `statusState`/`canTransition`), `shortIriLabel`, `trackerKey`/`TRACKER_KEY_PREFIX`.
- `src/lib/tracker.test.ts` — parse round-trip via the shared `serializeTracker`,
  404/403/5xx/non-tracker paths, key + label helpers.
- `src/components/use-tracker.ts` — `useTrackerMeta` over `useSwrRead`
  (keyed `tracker:<container>`, implicitly storage-scoped; watches the doc URL).
- `src/components/tracker-meta-panel.tsx` — collapsible read-only metadata panel.

Touched (ADD-ONLY shared registries):

- `src/app/issues/page.tsx` — renders the tracker panel when a config is present.
- `src/lib/prefetch.ts` — `tracker:<issuesContainer>` prefetch target.
- `src/components/instant-nav-registry.ts` — `useTrackerMeta` registry entry.
- `src/components/instant-nav.test.ts` — `use-tracker.ts` in READ_HOOKS.
- `src/components/instant-nav-prefetch.test.ts` — tracker mock + expected key.
