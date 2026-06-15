# Rich Typed Data-View System — Design

> Status: DESIGN (for review). 2026-06-13. Read-only investigation; no code changed.
> Scope: a pluggable, typed-viewer system for the shared `ResourceViewer`, so that wherever the app
> **knows the data model** it renders a **domain-appropriate view with no hint of the raw RDF/URLs** —
> profile cards for contacts, cover-art + "Open in Spotify" for music — and falls back to the existing
> generic triple table only for **unknown** shapes.

---

## 0. The intent in one line

The current detail screen always renders the same generic property table for any RDF resource
(`RdfViewer` in `src/components/resource-viewer.tsx`). We want: **known type → human view; URLs → actions;
raw triples only as the unknown-type fallback.**

---

## 1. How rendering works today (investigation)

The detail path is short and already cleanly layered:

1. **Route** — `src/app/my-data/[category]/item/page.tsx` (server shell) → `item-view.tsx` (client).
   `ItemView` reads `?url=`, enforces `isInOwnPods(url, storages)` (`src/lib/pod-scope.ts`, SEC-1), then
   renders `<ResourceViewer resource={data} />` (`item-view.tsx:168`).
2. **Fetch + classify** — `useResource(url)` (`src/components/use-resource.ts`) does one `fetch`, reads
   `content-type`, and calls `chooseViewer(contentType, url)`. For `rdf` kinds it reads the body, calls
   `parseRdf(body, mediaType, { baseIRI: url })`, and `readResourceProperties(url, dataset)`. The result is a
   `LoadedResource { url, viewer, contentType, size, text?, properties? }` (`use-resource.ts:10-19`).
3. **Classify by media type** — `chooseViewer` (`src/lib/viewers.ts:62`) maps a **content type** to a
   `ViewerKind` (`"rdf" | "image" | "text" | "pdf" | "audio" | "video" | "generic"`). It is purely
   content-type-driven; **it has no notion of `rdf:type`** — every Turtle/JSON-LD document becomes `"rdf"`.
4. **Render** — `ResourceViewer` (`src/components/resource-viewer.tsx:9`) switches on `resource.viewer.kind`.
   For `"rdf"` it renders `RdfViewer` — the generic property table (`resource-view.ts` `PropertyGroup[]`),
   with `safeLinkHref` gating IRI links (SEC-2). The `generic` default is the safe metadata + download card.

**Typed-ness that exists today:** *none at the resource level.* The only "typing" is media-type → viewer-kind.
The `rdf` kind is a single, un-specialised table. `resource-view.ts` deliberately walks raw quads ("the safe
generic for everything else", `resource-view.ts:1-9`). **This is exactly the layer the new system slots into:
a typed dispatch that runs `before` falling back to `RdfViewer`.**

Category browsing (`category-view.tsx` → `use-pod-data.ts` → `pod-data.ts`) is separate and stays as-is; it
lists container children as `PodItem` rows. The typed views live on the **item detail** screen first, then can
be lifted into list rendering (see §7).

Relevant design context: `docs/DESIGN.md` §4 ("content-type-aware viewer … a friendly renderer when the type
is known, a safe generic view otherwise"), §8 (R8: always expose an accessible underlying **table**).

---

## 2. The data models the app writes (provenance ground truth)

All integration data becomes triples through **one** typed-wrapper module, `src/lib/integrations/core/vocab.ts`
(house rule: never hand-build quads). Standard vocabs only: **schema.org + FOAF + vCard**. The classes and the
**provenance** mechanism are the foundation the viewers match against.

### 2.1 Provenance is a recognizable `schema:url`, not a `prov:` marker

There is **no** `prov:wasDerivedFrom` / source-app marker anywhere. Provenance is recorded as the item's
**canonical page on the source platform**, written by `PodThing.sourceUrl` → **`schema:url`**
(`vocab.ts:86-92`). Confirmed across every adapter (`grep "sourceUrl ="`):

| Source | `schema:url` host pattern | Class written |
|---|---|---|
| **Spotify** | `open.spotify.com/track/…`, `/playlist/…` | `schema:MusicRecording`, `schema:MusicPlaylist` (`spotify/adapter.ts:70,97`) |
| YouTube | `youtube.com/watch?v=…`, `/playlist?list=…` | `schema:WatchAction`, `schema:MusicPlaylist` |
| Pinterest | `pinterest.com/pin/…` | `schema:ImageObject` + `schema:SocialMediaPosting` |
| Google Photos | `productUrl` (`photos.google.com/…`) + `contentUrl` = `baseUrl` | `schema:ImageObject`/`VideoObject` |
| Strava / Fitbit / Garmin | `strava.com/activities/…`, `fitbit.com/…`, `connect.garmin.com/…` | `schema:ExerciseAction`/`TravelAction` |
| GitHub | `github.com/…` (`html_url`) | `schema:SoftwareSourceCode`, `foaf:OnlineAccount` |
| Reddit / X / Instagram / TikTok / Facebook | `reddit.com…`, `x.com…`, `instagram.com…`, `tiktok…`, `facebook.com…` | `schema:SocialMediaPosting` |
| Notion | `notion.so/…` | `schema:TextDigitalDocument`, `schema:Dataset` |
| Google Calendar | `htmlLink` (`calendar.google.com/…`) | `schema:Event` |
| Steam / Goodreads | `store.steampowered.com/app/…`, … | `schema:VideoGame`, `schema:Book` |

**Consequence for the design:** a "source" is identified by **matching the host of the resource's `schema:url`**.
That single fact powers the entire "Open in Spotify" action pattern (§5). There is no need for a new vocab term;
the source markers already in the pod are the `schema:url` hosts.

### 2.2 The shapes the initial viewers target (cite the wrappers)

- **Contacts** — `vcard:Individual` written by `src/lib/contacts.ts` (`CONTACT_CLASS`). Fields: `vcard:fn`
  (name), `vcard:hasEmail` (`mailto:` IRI), `vcard:hasTelephone` (`tel:` IRI), `vcard:note`. The first-party
  Contacts app already round-trips this via `parseContact`/`ContactDoc`. `vcard:Individual` is in the
  **Contacts** and **Identity** category class lists (`categories.ts:73,82`). WebID-style profiles
  (`foaf:Person` with `foaf:name`/`vcard:hasPhoto`) are the avatar-bearing sibling — handled by the bundled
  `ProfileAgent` (`src/lib/profile-agent.ts`), whose `displayName`/`avatarUrl` fallback chains we reuse verbatim.
- **Music / liked songs** — `schema:MusicRecording` (`vocab.ts:120-145`): `schema:name` (title),
  `schema:byArtist` (artist text), `schema:inAlbum` (album text), `schema:duration` (ISO-8601, e.g. `PT3M33S`),
  `schema:identifier` (Spotify id), and `schema:url` = the `open.spotify.com` link. **There is no album-art
  triple today** — Spotify's `album.images` is not imported (`spotify/adapter.ts` reads only `album.name`).
  See §6 Open-Q on cover art; the viewer is designed to show art **when present** and degrade gracefully.
- **Bookmarks** — `bookmark:Bookmark` (`http://www.w3.org/2002/01/bookmark#Bookmark`) is registered in the
  **Documents** category (`categories.ts:57,180`) but **no integration writes it yet**. The standard shape
  (`bookmark:recalls` → the bookmarked URL, `dct:title`) is what generic Solid bookmark apps write; the viewer
  targets that interop shape so externally-authored bookmarks render well.
- **Photos** — `schema:ImageObject` (`MediaItem`, `vocab.ts:482`): `schema:name`, `schema:contentUrl` (the
  hosted asset — `baseUrl`/Pinterest variant url), `schema:url` (source page), `width`/`height`,
  `schema:datePublished`.
- **Events** — `schema:Event` (`CalendarEvent`, `vocab.ts:451`): `schema:name`, `schema:startDate`,
  `schema:endDate`, `schema:location` (text), `schema:url` (source page). Also the first-party Calendar shape.

---

## 3. Type Index / category relationship

`src/lib/type-index.ts` reads `solid:TypeRegistration`s (`solid:forClass` → `solid:instance` /
`solid:instanceContainer`). `src/lib/categories.ts` maps **`rdf:type` IRI → category** (`BY_CLASS`,
`categoryForClass`). So the app already has **two** keys that a viewer can select on:

- **`rdf:type`** of the *subject* inside the resource (the precise key — `schema:MusicRecording`).
- **Type-Index category** of the *container* the resource came from (the coarse key — `media`).

These usually agree but can disagree (a `media` container can hold both `MusicRecording` and `MusicPlaylist`;
an `other`-bucket resource may still carry a recognizable `rdf:type`). **The registry keys primarily off
`rdf:type` read from the resource's own quads** (most specific, always available once parsed); category is an
optional secondary hint passed as context (§4.3). This matches `categories.ts`'s own "first category to claim a
class wins" specificity rule (`categories.ts:222-225`).

---

## 4. The typed-viewer registry

### 4.1 Layering (respect `vitest environment: "node"` + the RDF-only-in-`lib` rule)

`vitest.config.ts` runs in **node** (no DOM). `docs/DESIGN.md` §9 forbids RDF in `app/`+`components/`. So the
system splits in two, mirroring how `viewers.ts` (pure) and `resource-viewer.tsx` (render) already split:

- **`src/lib/typed-views/` — pure, node-testable.** Quad/`@solid/object` extraction into plain serialisable
  **view-models** + the selection logic + the source-action derivation. No React, no DOM, no I/O. Unit-tested
  against `parseRdf` fixtures exactly like `resource-view.test.ts`.
- **`src/components/typed-views/` — thin React renderers.** Each takes a view-model and returns a node. No RDF.

### 4.2 The viewer contract

```ts
// src/lib/typed-views/types.ts  (pure)
import type { DatasetCore } from "@rdfjs/types";

/** Everything a viewer needs to decide + extract, with zero I/O. */
export interface ViewerContext {
  /** The resource (document) URL. */
  url: string;
  /** Parsed quads of the resource. */
  dataset: DatasetCore;
  /** rdf:type IRIs present on any subject in the resource (precomputed set). */
  types: ReadonlySet<string>;
  /** Optional Type-Index category id the resource was discovered under (§3). */
  categoryId?: string;
}

/** A typed viewer = a matcher + a pure extractor producing a serialisable model. */
export interface TypedViewer<M = unknown> {
  /** Stable id, e.g. "contacts", "music". */
  id: string;
  /** Higher wins when several match. See §4.4. */
  priority: number;
  /** Cheap predicate: does this viewer understand the resource? */
  matches(ctx: ViewerContext): boolean;
  /** Pure extraction into a plain model the React renderer consumes. */
  extract(ctx: ViewerContext): M;
}
```

```tsx
// src/components/typed-views/registry.tsx  (render side)
/** Binds a pure TypedViewer to its React renderer. */
export interface TypedViewEntry<M = unknown> {
  viewer: TypedViewer<M>;
  Render: (props: { model: M; url: string }) => React.ReactNode;
}
```

### 4.3 Selection algorithm

`selectTypedViewer(ctx): TypedViewer | undefined` (pure, in `src/lib/typed-views/select.ts`):

1. Collect `candidates = registry.filter(v => v.matches(ctx))`.
2. If empty → return `undefined` → **caller falls back to the existing `RdfViewer` table** (§4.5).
3. Sort by `priority` desc; tie-break by registration order. Return the first.

Matching is **`rdf:type`-first** (most specific), with category and a shape check as secondary signals **inside**
each viewer's `matches`:

- **Type match** (primary): `ctx.types.has("https://schema.org/MusicRecording")` (and the `http://` legacy form,
  like `categories.ts` does).
- **Category match** (secondary hint, only when types are ambiguous/absent): `ctx.categoryId === "media"`.
- **Shape match** (SHACL-ish, the tie-breaker / unknown-type rescue): a viewer may match on the *presence of its
  signature predicates* even without an explicit `rdf:type` — e.g. Contacts matches a subject with `vcard:fn`
  even if untyped. Kept deliberately small (a predicate-presence check, not a full SHACL engine).

When `rdf:type` and category **disagree**, type wins (it is read from the actual data). Category is never
sufficient on its own to pick a *specialised* viewer — it only disambiguates between viewers that already
type-match. (Open-Q in §6.)

### 4.4 Priority / specificity ordering

`priority` encodes specificity so a more precise viewer beats a more general one:

| Viewer | priority | rationale |
|---|---|---|
| Contacts (`vcard:Individual` / `vcard:fn`) | 70 | very specific shape |
| Music (`schema:MusicRecording`) | 70 | specific class |
| Photo (`schema:ImageObject`) | 60 | specific class |
| Event (`schema:Event`) | 60 | specific class |
| Bookmark (`bookmark:Bookmark`) | 60 | specific class |
| Profile card (`foaf:Person` + name/photo) | 50 | broad; below Contacts so a typed contact wins |
| *(no match)* → generic `RdfViewer` table | — | the explicit unknown fallback |

A resource holding **multiple** typed subjects (e.g. `media/top-tracks.ttl` = many `MusicRecording`s) is the
common integration shape: the matched viewer renders a **list** of cards over all matching subjects (§7), not a
single card. The view-model is therefore `{ items: Track[] }`, not one `Track`.

### 4.5 The generic table is the explicit unknown-type fallback

In `ResourceViewer` the `"rdf"` branch becomes:

```tsx
case "rdf": {
  const entry = selectTypedView(resource); // wraps selectTypedViewer + binds Render
  if (entry) return <entry.Render model={entry.model} url={resource.url} />;
  return <RdfViewer groups={resource.properties ?? []} />; // unchanged fallback
}
```

`RdfViewer` and `resource-view.ts` are **untouched** — they remain the safe generic for everything unknown, and
the always-available "View data" equivalent (R8). A viewer may optionally surface a **"View raw data"**
disclosure that drops to the same `RdfViewer` for power users (Open-Q §6).

To feed the registry, `useResource` is extended minimally: when `viewer.kind === "rdf"` it already has the parsed
`dataset` in scope (`use-resource.ts:61`) — keep it on `LoadedResource` (e.g. `loaded.dataset = dataset`) and
precompute `types`. No extra fetch.

---

## 5. The source-aware action pattern

A small, pure registry maps a **source matcher** (run against `schema:url`) to an action descriptor. This is what
turns the Spotify URL from *displayed data* into an **"Open in Spotify"** button, and suppresses the raw URL.

```ts
// src/lib/typed-views/sources.ts  (pure)
export interface SourceAction {
  /** Stable id, e.g. "spotify". */
  id: string;
  /** Button label, e.g. "Open in Spotify". */
  label: string;
  /** Lucide icon name (resolved in the UI layer only — keeps this file DOM-free). */
  icon: string;
  /** Brand hint for styling, optional. */
  brand?: string;
}

export interface SourceMatch extends SourceAction {
  /** The safe outbound href derived from the resource. */
  href: string;
}

interface SourceMatcher {
  /** Does this matcher own the given source URL? (host check) */
  test(host: string, url: URL): boolean;
  action: SourceAction;
  /** Derive the outbound link (usually identity; lets a source rewrite if needed). */
  hrefFromResource(sourceUrl: string): string;
}

const MATCHERS: SourceMatcher[] = [
  {
    test: (h) => h === "open.spotify.com" || h.endsWith(".spotify.com"),
    action: { id: "spotify", label: "Open in Spotify", icon: "external-link", brand: "spotify" },
    hrefFromResource: (u) => u,
  },
  // youtube.com, pinterest.com, github.com, strava.com, … added incrementally.
];

/** Resolve the source action for a resource's schema:url, if recognised + safe. */
export function sourceActionFor(sourceUrl: string | undefined): SourceMatch | undefined { /* … */ }
```

**Rules:**

1. **Safety first.** Reuse `safeLinkHref` (`src/lib/pod-scope.ts`, SEC-2) so only `http(s)` IRIs become links;
   the import side already dropped delimiter-injecting IRIs via `safeIri` (`vocab.ts:37`). The action's `href`
   always opens in a new tab with `rel="noopener noreferrer"` (matches existing `resource-viewer.tsx` links and
   the `accessible-html-links` skill).
2. **Suppression.** When `sourceActionFor(schema:url)` returns a match, the typed viewer **renders the action,
   not the URL**, and omits `schema:url` from any field list it shows. When it returns `undefined` (unknown
   host) the viewer may show a neutral "Open original page" link (still via `safeLinkHref`) or nothing — never
   the raw IRI as a data row.
3. **Generalisable.** Adding a source = one entry in `MATCHERS`. Because every integration writes `schema:url`
   with a recognizable host (§2.1), one matcher table covers Spotify first and YouTube/Pinterest/GitHub/Strava/…
   next — for free, across all viewers.
4. **Provenance, not URL, is the unit.** The matcher takes the *host*, so the same Spotify action attaches to
   `MusicRecording` and `MusicPlaylist` alike, and the same "Open on YouTube" attaches to `WatchAction`.

This registry is consumed by viewers (a music card calls `sourceActionFor(track.sourceUrl)`), and is independently
unit-testable (host → action, including the `javascript:`/non-http rejection path).

---

## 6. Open questions for the maintainer

1. **How aggressively to hide URLs.** Proposal: a recognised source → action only, raw URL fully hidden; an
   unrecognised `schema:url` → a single neutral "Open original page" link (not a data row). Confirm we never show
   the bare IRI when the type is known. Should every typed card also offer a **"View raw data"** disclosure that
   drops to `RdfViewer` (power-user escape hatch + R8 belt-and-braces)?
2. **List vs detail.** Integration resources are multi-subject documents (50 tracks in one `.ttl`). Default:
   the typed viewer renders a **list of cards** for the whole resource. Do we also want a per-item *detail* drill
   (card → one track)? For v1, list-only is simplest and matches the data.
3. **Type vs category vs shape on disagreement.** Proposed precedence: `rdf:type` > shape > category (§4.3).
   Confirm — especially whether a Type-Index `media` category should ever *upgrade* an untyped resource to the
   music viewer (proposal: no; require the class or its signature predicates).
4. **Spotify cover art.** No album-art triple is imported today (`spotify/adapter.ts` reads `album.name` only).
   Options: (a) viewer shows a music-note placeholder now, render art only `if present`; (b) a tiny adapter
   change to also write `album.images[0].url` onto `schema:image` of the `MusicRecording`, which the viewer then
   shows. Recommend (a) for this design (no integration change), with (b) as a follow-up so "cover-art icon" is
   real. Note: remote image loading is a privacy/CSP consideration (same as `docs/DESIGN.md` Open-Q on remote
   app logos) — gate behind the same policy.
5. **Profile-card avatars are remote IRIs.** Contacts hold `mailto:`/`tel:` (no photo); WebID profiles hold a
   remote `vcard:hasPhoto`. Same remote-image/CSP decision as Q4.
6. **Where typed views appear.** v1: item **detail** only. Lifting cover-art/profile-card rendering into the
   category **list** (`category-view.tsx` rows) is higher-value but needs the list to fetch+parse each resource
   (today it only does a container listing). Defer to a follow-up (§7).

---

## 7. Reuse impact (task #58 in-place viewer + offline layer)

The whole system lands **inside the shared `ResourceViewer`** (`src/components/resource-viewer.tsx`) — the single
render entry point used by the item detail screen. Therefore:

- **Task #58 (in-place storage-URL viewer)** inherits typed views automatically: anything that fetches a
  `LoadedResource` and renders `<ResourceViewer>` gets cards-for-known-types for free. The only requirement is
  that the producer of `LoadedResource` populates `dataset`/`types` for `rdf` kinds (the `useResource` change in
  §4.5) — anything bypassing `useResource` must do the same parse step.
- **Offline layer** inherits it too: selection + extraction are **pure functions over an already-parsed dataset**
  (no network), so a cached/offline dataset renders identically. The source-action `href`s are outbound links,
  not pod fetches, so they are offline-neutral.

**Coupling that could block reuse — and the mitigations:**

- `useResource` reads the session (`useSession`) and uses the auth-patched global `fetch`. The **pure typed-views
  layer takes a dataset, not a session** — so it has *no* Pod-Manager-provider coupling. Keep all provider
  dependence in `use-resource.ts`; the registry stays portable.
- Icons: the pure `sources.ts`/view-models carry **icon names (strings)**, resolved to Lucide components only in
  `components/` (same pattern as `category-icon.tsx` / `CategoryIconName`). This keeps `lib/` DOM-free and the
  models serialisable (important for offline/SSR).
- No coupling to `categories.ts` is required — `categoryId` is an optional context hint, so the registry works
  even where the Type Index is absent.

---

## 8. File-level, smallest-deliverable build plan

Each phase is independently shippable, type-checked, linted, and unit-tested. Tests follow the existing
`resource-view.test.ts` / `viewers.test.ts` pattern: pure functions over `parseRdf` fixtures, **node** env
(`vitest.config.ts`). Use the real integration fixtures (`spotify/fixtures.ts`, etc.) and the real wrappers
(`contacts.ts`, `vocab.ts`) to author fixtures, so viewers match **real** data, not invented shapes.

### P1 — Framework + source-actions + Contacts (the spine)

New (pure, `src/lib/typed-views/`):
- `types.ts` — `ViewerContext`, `TypedViewer`, model interfaces.
- `select.ts` — `collectTypes(dataset)`, `selectTypedViewer(ctx)`. **Tests:** `select.test.ts` (type-first,
  priority tie-break, no-match → undefined).
- `sources.ts` — `MATCHERS` (Spotify only to start), `sourceActionFor`. **Tests:** `sources.test.ts` (host
  match, http-only safety, unknown → undefined).
- `contacts-view.ts` — `matches` (`vcard:Individual` or `vcard:fn` present) + `extract` → `{ items: ContactCard[] }`
  reusing `parseContact`/`ContactDoc` (`contacts.ts`) and `ProfileAgent` (`profile-agent.ts`) for name/avatar.
  **Tests:** `contacts-view.test.ts` against a `buildContact(...)` fixture + a `foaf:Person` profile fixture.

New (render, `src/components/typed-views/`):
- `registry.tsx` — `TypedViewEntry[]`, `selectTypedView(resource)`.
- `contacts-card.tsx` — avatar (shadcn `Avatar`) + name + email/phone **actions** (`mailto:`/`tel:` from the
  stored URIs), no triples.
- `source-action.tsx` — renders a `SourceMatch` as a button/link (resolves icon name → Lucide).

Wire-in:
- `src/components/use-resource.ts` — keep `dataset` + `types` on `LoadedResource` for `rdf` kinds (no new fetch).
- `src/components/resource-viewer.tsx` — `"rdf"` branch tries `selectTypedView` first, else `RdfViewer` (§4.5).

Ships: contacts render as profile cards; everything else unchanged. Smallest end-to-end proof of the registry.

### P2 — Music / Spotify viewer

- `src/lib/typed-views/music-view.ts` — `matches` (`schema:MusicRecording`/`MusicPlaylist`), `extract` →
  `{ items: { title, artist, album, duration, source: SourceMatch? }[] }` via the `MusicRecording`/`MusicPlaylist`
  wrappers (`vocab.ts`), calling `sourceActionFor(rec.sourceUrl)`. **Tests:** `music-view.test.ts` against the
  recorded `spotify/fixtures.ts` (TOP_TRACKS / PLAYLISTS) — asserts artist/title/duration extraction and that the
  Spotify action is derived, raw URL suppressed.
- `src/components/typed-views/music-card.tsx` — cover-art icon (art `if present`, music-note placeholder
  otherwise — Open-Q §6.4), title + artist + album + humanised duration, **"Open in Spotify"** action.
- Register both at priority 70/… .

Ships: liked songs / playlists render as cover-art rows with Open-in-Spotify, no URLs.

### P3+ — The rest (each its own slice)

- **Photos** — `photo-view.ts` (`schema:ImageObject`) → thumbnail grid from `schema:contentUrl`; `photo-grid.tsx`.
  Adds the matching source actions (Pinterest/Google Photos) to `MATCHERS`.
- **Events** — `event-view.ts` (`schema:Event`) → date/time + title + location; "Open in Google Calendar" action.
- **Bookmarks** — `bookmark-view.ts` (`bookmark:Bookmark`, `bookmark:recalls`) → favicon + title + **Open link**
  action (targets the generic interop shape, §2.2).
- Extend `MATCHERS` with YouTube/GitHub/Strava/Reddit/… as their viewers land — each one line.

Every new typed view = one pure `*-view.ts` (+ test) + one `*-card.tsx` + one `registry` line + (optionally) one
`MATCHERS` entry. No change to `viewers.ts`, `resource-view.ts`, or the fallback.

---

## 9. Summary

The app already records exactly what a typed-view system needs: standard-vocab `rdf:type`s through one wrapper
module, and provenance as a recognizable `schema:url` per item. The design adds a **pure, node-testable typed-viewer
registry** selected primarily by `rdf:type` (with category + shape as secondary signals), a **source-action
registry** that turns `schema:url` hosts into actions like **"Open in Spotify"** while suppressing the raw URL, and
a thin set of React cards — all behind the existing `ResourceViewer`, with the current `RdfViewer` triple table kept
intact as the **explicit unknown-type fallback**. P1 proves the spine with Contacts; P2 delivers the
cover-art + Open-in-Spotify music view; P3+ adds photos, events, and bookmarks, each independently shippable.
