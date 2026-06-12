# Integrations catalog — connect your accounts to your pod

> Status: SPEC. Drives `src/lib/integrations/` and the `/connect` surface.
> The catalog is **tier-honest**: every app below is visible in the UI, labelled with
> exactly what works today. We never fake a live connection.

## The common adapter shape

Every integration implements `IntegrationAdapter` (`src/lib/integrations/core/types.ts`):

| Member | Contract |
|---|---|
| `metadata` | id, name, tier, `authKind`, OAuth scopes, pod categories it writes, plain-language "what you get" copy, and an honest `requirements` list (what the maintainer must register for live mode). |
| `authorize()` | End-user **OAuth2 authorization-code + PKCE** in a popup, via the shared engine (`core/oauth.ts`). Tokens live **in memory only** — never `localStorage`, never sent anywhere except the app's own platform token endpoint (or the adapter's declared token-exchange proxy, when the platform refuses secretless PKCE). |
| `import(ctx)` | Pull from the source API (`ctx.api` — token-backed when live, fixture-backed in demo), normalise to RDF with **standard vocabularies** (schema.org / FOAF via typed `@rdfjs/wrapper` classes — never hand-built triples), and write into the pod through `ctx.write(...)` → `src/lib/pod-data.writeResource` + Type-Index registration. Returns an incremental `cursor` where the API supports one. |

**Idempotency**: imports write whole collection documents at deterministic URLs
(`<podRoot>integrations/<app>/<collection>.ttl`) with deterministic fragment IRIs —
re-import overwrites in place, never duplicates.

## Live-readiness policy (demo vs live)

- An adapter is **enabled-live** iff its `NEXT_PUBLIC_<APP>_CLIENT_ID` env var is present
  at build time. Nothing else flips it.
- Without a client id the adapter renders in **demo mode**: the full UX runs against the
  adapter's recorded fixtures and writes that demo data into the pod, labelled with a
  visible **"Demo data"** badge. Demo is honest staging, never fake-live.
- Platforms whose token endpoint requires a client secret (no public-client PKCE) also
  need `NEXT_PUBLIC_<APP>_TOKEN_PROXY` — a tiny serverless code-for-token exchanger the
  maintainer deploys. Until both are set, those adapters stay demo.
- **Tier B** apps require platform partnership/app-review before any user can connect →
  shown as "Coming soon — needs platform approval".
- **Tier C** apps have no user-grade API → shown as "Import from export file"; each has
  a shipped parser for its official data export (`src/lib/integrations/file-adapters.ts`).

## Live robustness (sparse-response contract)

The recorded fixtures are tidy; the live APIs are not. Adapters must treat every
nested property on an API response as possibly absent/null, because real
accounts hit shapes the fixtures never exercised (the canonical example: a live
Spotify `/me/playlists` item with no `tracks` object at all, which crashed the
import with *"Cannot read properties of undefined (reading 'total')"*). The
contract for the live-capable Tier-A adapters (spotify, discord, github, strava,
twitch, notion):

- Missing arrays default to `[]`; missing counts to `0`; missing optional fields
  **omit the triple** (the typed vocab setters drop `undefined` — we never write
  the literal string `"undefined"`/`"null"`).
- Null array entries, and items missing the one field they cannot exist without
  (a stable id for their fragment IRI), are **skipped, not fatal** — one bad item
  never aborts the whole import. The skipped count is surfaced honestly on
  `ImportOutcome.skipped` → `ImportReport.skipped`.
- A malformed/absent date is omitted rather than allowed to reach
  `Date.toISOString()` (which throws on `Invalid Date`).
- Each adapter has a `survives a sparse live response …` regression test feeding
  the null-laden shape the live API actually returns and asserting the import
  completes, writes valid Turtle (re-parsed with N3), and leaks no literal
  `undefined`/`null`.

Honest field caveats (advertised "what you get" vs what the live API reliably
gives):

- **GitHub** — repo `description`, `homepage` and `language` are `null` for a
  large fraction of repos; the profile `name` and `bio` are often `null`. These
  render as "not set" (the triple is omitted), not as empty strings.
- **Discord** — the server list depends on the `guilds` scope being granted; if
  it isn't, "your servers" is legitimately empty. `approximate_member_count` is
  only present when the guild listing was requested with counts, so a server's
  member-count line can be absent.
- **Spotify** — playlist track counts come from `tracks.total`, which some
  playlist items omit; those show a count of `0` rather than failing. Items you
  no longer have access to can arrive as `null` and are skipped.
- **Strava** — manual activities carry no `distance`/`moving_time`; those rows
  omit distance/duration rather than showing `NaN`.
- **Notion** — a page with no title property is labelled "Untitled"; a database
  with no title "Untitled database". Pages with no `properties` object at all are
  handled, not crashed.

## Tier A — end-user OAuth, adapters shipped (this increment)

| App | id | Categories | What you get | PKCE without secret? |
|---|---|---|---|---|
| Spotify | `spotify` | Media | Your top tracks and playlists | Yes |
| GitHub | `github` | Work & education | Your profile and repositories | No — token proxy required |
| Strava | `strava` | Health, Mobility | Workouts, runs and rides | No — token proxy required |
| Reddit | `reddit` | Social & interests | Saved posts and communities | Yes (installed-app flow) |
| Discord | `discord` | Social & interests | Your profile and servers | Yes |
| Twitch | `twitch` | Media | Channels you follow | No — token proxy required |
| Notion | `notion` | Documents | Pages and databases | No — token proxy required |
| Dropbox | `dropbox` | Documents | File and folder metadata | Yes |

Go-live checklist per app (the honest list) lives in each adapter's
`metadata.requirements` and is rendered on the app's connect page.

## Tier B — needs platform approval (visible, "Coming soon")

| App | id | Categories | Blocker |
|---|---|---|---|
| Google Calendar | `google-calendar` | Calendar | OAuth verification + restricted-scope review |
| Google Photos | `google-photos` | Media | Photos Library API approval |
| YouTube | `youtube` | Media | API audit for watch/like history scopes |
| Fitbit | `fitbit` | Health | Developer app review for intraday data |
| Garmin | `garmin` | Health, Mobility | Partner-program (Health/Connect API) approval. **Hybrid**: a file import of the user's own Garmin Connect export ships today (see Tier C); the partner application draft is `docs/garmin-partner-application.md` |
| Instagram | `instagram` | Media, Social & interests | Meta app review |
| Facebook | `facebook` | Social & interests | Meta app review |
| TikTok | `tiktok` | Media, Social & interests | TikTok developer audit |
| LinkedIn | `linkedin` | Work & education | Marketing/Member-data program approval |
| X (Twitter) | `x-twitter` | Social & interests | Paid API tier + elevated access |
| Slack | `slack` | Work & education | Workspace-admin install approval model |
| Pinterest | `pinterest` | Media, Social & interests | Trial-access review |

## Tier C — no user-grade API: import from export file (file imports shipped)

| App | id | Categories | Export format |
|---|---|---|---|
| Netflix | `netflix` | Media | Viewing-activity CSV |
| Amazon orders | `amazon-orders` | Finance | Order-history export |
| Uber | `uber` | Mobility, Finance | Data download (ZIP/CSV) |
| Apple Health | `apple-health` | Health | `export.zip` (XML) |
| WhatsApp | `whatsapp` | Social & interests | Chat export (TXT) |
| Goodreads | `goodreads` | Documents | Library export CSV |
| Steam | `steam` | Media, Social & interests | Account-data export |
| ChatGPT | `chatgpt` | Documents | Conversations export (JSON) |
| Bank statements | `bank-statements` | Finance | CSV / OFX statements |
| Google Takeout | `google-takeout` | Documents, Media, Calendar | Takeout archive |
| Garmin *(Tier-B hybrid)* | `garmin` | Health, Mobility | `Activities.csv` ("Export CSV" on the activities list — Garmin only exports the rows loaded, so scroll first) or a single per-activity GPX/TCX file. The full archive ("Export Your Data", `DI_CONNECT/…/summarizedActivities.json`) is a large ZIP we deliberately don't parse — the CSV carries the same summaries without a ZIP reader. |

A Tier-B app may also appear here when its self-serve export already works (Garmin):
the connect page then shows the approval-gated OAuth path **and** the file import.

## Vocabulary map (normalisation targets)

| Source data | RDF class | Category |
|---|---|---|
| Spotify track / playlist | `schema:MusicRecording` / `schema:MusicPlaylist` | Media |
| GitHub repo / profile | `schema:SoftwareSourceCode` / `foaf:OnlineAccount` | Work & education |
| Strava run/workout | `schema:ExerciseAction` | Health |
| Strava ride/commute | `schema:TravelAction` | Mobility |
| Garmin run/workout (CSV/GPX/TCX) | `schema:ExerciseAction` | Health |
| Garmin ride/commute (CSV/GPX/TCX) | `schema:TravelAction` | Mobility |
| Reddit saved post / subreddit | `schema:SocialMediaPosting` / `foaf:Group` | Social & interests |
| Discord profile / guild | `foaf:OnlineAccount` / `foaf:Group` | Social & interests |
| Twitch followed channel | `schema:WatchAction` | Media |
| Notion page / database | `schema:TextDigitalDocument` / `schema:Dataset` | Documents |
| Dropbox file/folder metadata | `schema:DigitalDocument` | Documents |
