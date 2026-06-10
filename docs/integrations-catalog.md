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
- **Tier C** apps have no user-grade API → shown as "Import from export file" (a later
  increment parses their official data-export archives).

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
| Garmin | `garmin` | Health, Mobility | Partner-program (Health/Connect API) approval |
| Instagram | `instagram` | Media, Social & interests | Meta app review |
| Facebook | `facebook` | Social & interests | Meta app review |
| TikTok | `tiktok` | Media, Social & interests | TikTok developer audit |
| LinkedIn | `linkedin` | Work & education | Marketing/Member-data program approval |
| X (Twitter) | `x-twitter` | Social & interests | Paid API tier + elevated access |
| Slack | `slack` | Work & education | Workspace-admin install approval model |
| Pinterest | `pinterest` | Media, Social & interests | Trial-access review |

## Tier C — no user-grade API: import from export file (visible, file-import later)

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

## Vocabulary map (normalisation targets)

| Source data | RDF class | Category |
|---|---|---|
| Spotify track / playlist | `schema:MusicRecording` / `schema:MusicPlaylist` | Media |
| GitHub repo / profile | `schema:SoftwareSourceCode` / `foaf:OnlineAccount` | Work & education |
| Strava run/workout | `schema:ExerciseAction` | Health |
| Strava ride/commute | `schema:TravelAction` | Mobility |
| Reddit saved post / subreddit | `schema:SocialMediaPosting` / `foaf:Group` | Social & interests |
| Discord profile / guild | `foaf:OnlineAccount` / `foaf:Group` | Social & interests |
| Twitch followed channel | `schema:WatchAction` | Media |
| Notion page / database | `schema:TextDigitalDocument` / `schema:Dataset` | Documents |
| Dropbox file/folder metadata | `schema:DigitalDocument` | Documents |
