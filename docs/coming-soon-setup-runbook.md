# "Coming soon" integration setup runbook — operator follow-along

> **Audience:** the maintainer (technical, wants copy-pasteable steps).
> **Goal:** take any "coming soon" / demo-mode / not-yet-live integration in the Pod
> Manager and flip it live, end to end.
> **Scope:** OAuth console registration, env wiring, the token-proxy go-live, image
> rebuild/redeploy, and the file-import (Tier C) + URL-input enhancement.
>
> This doc is the **umbrella**. It links into the detailed companions and does not
> duplicate them:
> - Per-console form fields → [`docs/platform-approvals.md`](./platform-approvals.md)
> - Adapter model, tiers, demo-vs-live policy → [`docs/integrations-catalog.md`](./integrations-catalog.md)
> - Token-proxy internals/security → [`prod-solid-server/services/token-proxy/README.md`](../../prod-solid-server/services/token-proxy/README.md)
> - Box compose/Caddy wiring → `prod-solid-server/deploy/docker-compose.single.yml`,
>   `prod-solid-server/deploy/Caddyfile.single`, `prod-solid-server/deploy/.env.prod.example`
>
> **Nothing in this runbook is executed for you.** Every `aws`/`ssm`/`docker`/build
> command is for the operator to run. Anything not yet built is marked **PROPOSED**.

---

## 1. Overview, the two auth models, and the golden rules

### 1.1 The two auth models

Every OAuth integration in the Pod Manager uses **authorization-code + PKCE in a popup**;
the tokens live **in memory only** (never `localStorage`). They differ only in how the
final `code → token` exchange is performed:

| Model | When | What the browser holds | Where the secret lives | Env vars to set |
|---|---|---|---|---|
| **PUBLIC** (secretless PKCE) | platform supports public-client PKCE | client ID only | **no secret exists** | `NEXT_PUBLIC_<APP>_CLIENT_ID` only |
| **PROXY** (confidential) | platform's token endpoint demands a client secret | client ID only | **server-side**, in the token-proxy on the box | `NEXT_PUBLIC_<APP>_CLIENT_ID` **and** `NEXT_PUBLIC_<APP>_TOKEN_PROXY` (build time) **plus** `PSS_TOKEN_PROXY_<APP>_CLIENT_ID` + `PSS_TOKEN_PROXY_<APP>_CLIENT_SECRET` in the box `.env.prod` |

An adapter is **enabled-live iff** its `NEXT_PUBLIC_<APP>_CLIENT_ID` is present at build
time (and, for PROXY apps, its `NEXT_PUBLIC_<APP>_TOKEN_PROXY` too). Without that, it
renders in honest **demo mode** against recorded fixtures with a "Demo data" badge — see
[integrations-catalog.md → Live-readiness policy](./integrations-catalog.md).

### 1.2 The golden rules

1. **One redirect/callback URI, registered identically at every console:**

   ```
   https://app.solid-test.jeswr.org/oauth-callback.html
   ```

   Some consoles want a **domain only** (Strava): use `app.solid-test.jeswr.org` — no
   scheme, no path. App production origin is `https://app.solid-test.jeswr.org`.

2. **Client IDs are PUBLIC.** They go in `.env.production` (committed) and are baked into
   the image at build by `npm run build:prod`. Chat/email is fine for them.

3. **Client SECRETS never touch the repo or the image.** They go **only** into the box at
   `/opt/pss/src/deploy/.env.prod` as `PSS_TOKEN_PROXY_<APP>_CLIENT_SECRET` (one SSM
   session). Never in `.env.production`, never in `NEXT_PUBLIC_*`, never in chat.

4. **Any `NEXT_PUBLIC_*` change requires an image rebuild + redeploy.** The static export
   inlines these at build time; editing `.env.production` alone changes nothing live until
   you rebuild and re-pin the image digest (see [§5](#5-rebuild--redeploy-the-pod-manager-image)).

5. **Secrets-only changes (`.env.prod` on the box) do NOT need an image rebuild** — they
   only need the token-proxy container restarted (see [§4](#4-deploying-the-token-proxy-go-live)).

> ⚠️ **Naming reconciliation (verified against the box files).** The box `.env.prod` keys
> are prefixed **`PSS_TOKEN_PROXY_`** (e.g. `PSS_TOKEN_PROXY_GITHUB_CLIENT_SECRET`). The
> compose file (`deploy/docker-compose.single.yml`) maps those to the container env vars
> the service actually reads — **`TOKEN_PROXY_<PLATFORM>_CLIENT_ID/_CLIENT_SECRET`** (no
> `PSS_` prefix). So: in `.env.prod` use `PSS_TOKEN_PROXY_*`; the service inside sees
> `TOKEN_PROXY_*`. Earlier hand-off notes that said to set raw `TOKEN_PROXY_*` in
> `.env.prod` were wrong — use the `PSS_`-prefixed keys.

---

## 2. Master table

Auth model: **PUBLIC** = secretless PKCE; **PROXY** = needs token-proxy + secret on box;
**FILE** = no OAuth, import an export file.

| Integration | Tier | Auth model | Build-time env vars | Box `.env.prod` secret keys | Live blocker |
|---|---|---|---|---|---|
| Spotify | A | PUBLIC | `NEXT_PUBLIC_SPOTIFY_CLIENT_ID` | — | **LIVE** |
| Discord | A | PUBLIC | `NEXT_PUBLIC_DISCORD_CLIENT_ID` | — | **LIVE** |
| Reddit | A | PUBLIC | `NEXT_PUBLIC_REDDIT_CLIENT_ID` | — | register installed-app, set ID, rebuild |
| Dropbox | A | PUBLIC | `NEXT_PUBLIC_DROPBOX_CLIENT_ID` | — | register app, set ID, rebuild |
| GitHub | A | PROXY | `NEXT_PUBLIC_GITHUB_CLIENT_ID` (✅ set), `NEXT_PUBLIC_GITHUB_TOKEN_PROXY` | `PSS_TOKEN_PROXY_GITHUB_CLIENT_ID/_SECRET` | **token-proxy not deployed** |
| Strava | A | PROXY | `NEXT_PUBLIC_STRAVA_CLIENT_ID`, `NEXT_PUBLIC_STRAVA_TOKEN_PROXY` | `PSS_TOKEN_PROXY_STRAVA_CLIENT_ID/_SECRET` | register + token-proxy |
| Twitch | A | PROXY | `NEXT_PUBLIC_TWITCH_CLIENT_ID`, `NEXT_PUBLIC_TWITCH_TOKEN_PROXY` | `PSS_TOKEN_PROXY_TWITCH_CLIENT_ID/_SECRET` | register + token-proxy |
| Notion | A | PROXY | `NEXT_PUBLIC_NOTION_CLIENT_ID`, `NEXT_PUBLIC_NOTION_TOKEN_PROXY` | `PSS_TOKEN_PROXY_NOTION_CLIENT_ID/_SECRET` | register (do **last**) + token-proxy |
| Google Calendar | B | PROXY* | — | — | OAuth verification + restricted-scope review |
| Google Photos | B | PROXY* | — | — | Photos Library API approval |
| YouTube | B | PROXY* | — | — | watch/like history scopes effectively closed (use Takeout) |
| Fitbit | B | PROXY* | — | — | developer app review for intraday data |
| Garmin | B (hybrid) | PROXY* | — | — | Health/Connect partner program; **file import ships today** |
| Instagram | B | PROXY* | — | — | Meta app review + business verification |
| Facebook | B | PROXY* | — | — | Meta app review + business verification |
| TikTok | B | PROXY* | — | — | TikTok developer audit |
| LinkedIn | B | PROXY* | — | — | Marketing/Member-data program approval |
| X / Twitter | B | **PUBLIC** | `NEXT_PUBLIC_XTWITTER_CLIENT_ID` (**PROPOSED** — see note) | — | paid API tier + elevated access |
| Slack | B | PROXY* | — | — | workspace-admin install approval |
| Pinterest | B | PROXY* | — | — | trial-access review |
| Netflix | C | FILE | — | — | no API — viewing-activity CSV |
| Amazon Orders | C | FILE | — | — | no API — order-history export (emailed link) |
| Uber | C | FILE | — | — | no API — data download ZIP (emailed link) |
| Apple Health | C | FILE | — | — | no API — `export.zip` from iPhone (local only) |
| WhatsApp | C | FILE | — | — | no API — per-chat TXT (local only) |
| Goodreads | C | FILE | — | — | no API — library CSV |
| Steam | C | FILE | — | — | no API — account-data export |
| ChatGPT | C | FILE | — | — | no API — conversations ZIP (emailed link) |
| Bank statements | C | FILE | — | — | no API — CSV/OFX from online banking |
| Google Takeout | C | FILE | — | — | no API — Takeout archive (emailed link) |

\* **Tier-B "PROXY"** is the model these *would* use once approved: all the Tier-B OAuth
apps except X/Twitter require a client secret, so they will each need the token-proxy.
**The token-proxy code currently allowlists only `github`, `strava`, `twitch`, `notion`**
(`services/token-proxy/src/platforms.ts`). Adding any Tier-B PROXY provider needs a
**code change to that allowlist + per-platform auth-style entry** before it can exchange —
mark that work **PROPOSED** until a provider's review actually clears.

---

## 3. Per-provider setup walkthroughs

> For exact console form labels, field-by-field, follow the linked section in
> [`platform-approvals.md`](./platform-approvals.md). Below is the operator's "what / where
> / which env" summary plus the box keys for PROXY apps.

### 3.A Tier A — end-user OAuth (adapters shipped)

The redirect URI for every one of these is
`https://app.solid-test.jeswr.org/oauth-callback.html` (Strava: domain only).

#### Spotify — **LIVE** (PUBLIC)
- Console: <https://developer.spotify.com/dashboard> · fields: [platform-approvals §1](./platform-approvals.md#1-spotify--developerspotifycomdashboard)
- Scopes/API: **Web API** only. Secretless PKCE — ignore the client secret.
- Env: `NEXT_PUBLIC_SPOTIFY_CLIENT_ID=784e49da3e3a41738f4325e328bda8c8` (already in `.env.production`).
- Dev-mode cap: 25 users, each allow-listed under **User Management** (add your own Spotify email).

#### Discord — **LIVE** (PUBLIC)
- Console: <https://discord.com/developers/applications> · fields: [platform-approvals §2](./platform-approvals.md#2-discord--discordcomdevelopersapplications)
- Must have **Public Client toggle ON** (lets the token exchange run without a secret).
- Env: `NEXT_PUBLIC_DISCORD_CLIENT_ID=1514927045430214667` (already set). App ID `1514927045430214667`.
- "your servers" needs the `guilds` scope; see Discord follow-ups in [§7](#7-discord-follow-ups--byod-domain-purchase-operator-notes).

#### Reddit — PUBLIC (installed-app flow)
- Console: <https://reddit.com/prefs/apps> · fields: [platform-approvals §3](./platform-approvals.md#3-reddit--redditcomprefsapps)
- Type radio = **installed app** (no secret). Client ID is the string **directly under the app name** in the card.
- Env: `NEXT_PUBLIC_REDDIT_CLIENT_ID=<id>` → rebuild image.

#### Dropbox — PUBLIC
- Console: <https://dropbox.com/developers/apps> · fields: [platform-approvals §4](./platform-approvals.md#4-dropbox--dropboxcomdevelopersapps)
- Scoped access · Full Dropbox · Permissions: `files.metadata.read` + `account_info.read` (set **before** anyone connects). App key = client ID.
- Env: `NEXT_PUBLIC_DROPBOX_CLIENT_ID=<app key>` → rebuild image.

#### GitHub — PROXY (ID baked; demo until proxy deployed)
- Console: <https://github.com/settings/developers> → OAuth Apps · fields: [platform-approvals §5](./platform-approvals.md#5-github--githubcomsettingsdevelopers)
- Generate a client secret → it goes on the box, never in chat.
- Build-time env (in `.env.production`):
  - `NEXT_PUBLIC_GITHUB_CLIENT_ID=Ov23lifeDQdTb2j1XB3l` (already set)
  - `NEXT_PUBLIC_GITHUB_TOKEN_PROXY=https://app.solid-test.jeswr.org/oauth-token-proxy/exchange/github` (currently commented out — uncomment when proxy is live, then rebuild)
- Box `.env.prod`: `PSS_TOKEN_PROXY_GITHUB_CLIENT_ID=Ov23lifeDQdTb2j1XB3l`, `PSS_TOKEN_PROXY_GITHUB_CLIENT_SECRET=<secret>`
- PKCE: GitHub supports optional S256 PKCE; the proxy forwards `code_verifier` for GitHub.

#### Strava — PROXY
- Console: <https://www.strava.com/settings/api> · fields: [platform-approvals §6](./platform-approvals.md#6-strava--stravacomsettingsapi)
- **Authorization Callback Domain = `app.solid-test.jeswr.org`** (domain only). Icon upload required.
- Build-time env: `NEXT_PUBLIC_STRAVA_CLIENT_ID=<id>`, `NEXT_PUBLIC_STRAVA_TOKEN_PROXY=https://app.solid-test.jeswr.org/oauth-token-proxy/exchange/strava`
- Box `.env.prod`: `PSS_TOKEN_PROXY_STRAVA_CLIENT_ID=<id>`, `PSS_TOKEN_PROXY_STRAVA_CLIENT_SECRET=<secret>`
- No PKCE (verifier not forwarded). New apps capped to 1 athlete until a capacity increase.
- ⚠️ If the live exchange 404s, switch the endpoint via `PSS_TOKEN_PROXY_STRAVA_TOKEN_ENDPOINT` → maps to `TOKEN_PROXY_STRAVA_TOKEN_ENDPOINT` (`https://www.strava.com/api/v3/oauth/token`). *(Verify this passthrough exists in compose before relying on it; if not wired, set it on the container env directly.)*

#### Twitch — PROXY
- Console: <https://dev.twitch.tv/console/apps> (needs 2FA on your Twitch account) · fields: [platform-approvals §7](./platform-approvals.md#7-twitch--devtwitchtvconsoleapps)
- Client Type = **Confidential**.
- Build-time env: `NEXT_PUBLIC_TWITCH_CLIENT_ID=<id>`, `NEXT_PUBLIC_TWITCH_TOKEN_PROXY=https://app.solid-test.jeswr.org/oauth-token-proxy/exchange/twitch`
- Box `.env.prod`: `PSS_TOKEN_PROXY_TWITCH_CLIENT_ID=<id>`, `PSS_TOKEN_PROXY_TWITCH_CLIENT_SECRET=<secret>`
- No PKCE for auth-code grant.

#### Notion — PROXY (**register LAST** — review checks privacy/terms content)
- Console: <https://notion.so/my-integrations> · fields: [platform-approvals §8](./platform-approvals.md#8-notion--notionsomy-integrations--do-this-last)
- Switch to **Public integration**; capabilities: Read content, read user info **without email**, no write.
- Build-time env: `NEXT_PUBLIC_NOTION_CLIENT_ID=<id>`, `NEXT_PUBLIC_NOTION_TOKEN_PROXY=https://app.solid-test.jeswr.org/oauth-token-proxy/exchange/notion`
- Box `.env.prod`: `PSS_TOKEN_PROXY_NOTION_CLIENT_ID=<id>`, `PSS_TOKEN_PROXY_NOTION_CLIENT_SECRET=<secret>`
- Auth style: **HTTP Basic** (`base64(client_id:client_secret)`) + **JSON** body — handled by the proxy automatically. No PKCE.

### 3.B Tier B — "Coming soon, needs platform approval"

All Tier-B providers are visible in the UI as "Coming soon — needs platform approval".
None are connectable today. For each: the developer console, the approval blocker, scopes,
the env vars they *will* use, and what "approval" entails. **All are PROXY (need a secret +
a new token-proxy allowlist entry) except X/Twitter, which is PUBLIC.**

| Provider | Console | Approval blocker / what "approval" entails | Representative scopes | Env vars (when live) |
|---|---|---|---|---|
| Google Calendar | <https://console.cloud.google.com/apis/credentials> | OAuth consent-screen **verification**: questionnaire + **demo video** + restricted-scope review (our "data goes only to your own pod" story is strong; realistic per platform-approvals) | `calendar.readonly` | `NEXT_PUBLIC_GOOGLE_CALENDAR_CLIENT_ID` + `_TOKEN_PROXY`; box `PSS_TOKEN_PROXY_GOOGLE_CALENDAR_*` |
| Google Photos | same Google console | **Photos Library API** access approval (separate gated API) | `photoslibrary.readonly` | `NEXT_PUBLIC_GOOGLE_PHOTOS_CLIENT_ID` + `_TOKEN_PROXY`; box keys |
| YouTube | same Google console | API audit for watch/like-history scopes — **effectively closed**; prefer **Google Takeout** (Tier C) | `youtube.readonly` | (use Takeout instead) |
| Fitbit | <https://dev.fitbit.com/apps> | Personal app works immediately; **server-type / intraday review** is light | `activity heartrate sleep` | `NEXT_PUBLIC_FITBIT_CLIENT_ID` + `_TOKEN_PROXY`; box keys |
| Garmin | <https://developerportal.garmin.com> | Health/Connect **partner-program** approval. **Hybrid:** file import ships today (Tier C); partner draft = [`docs/garmin-partner-application.md`](./garmin-partner-application.md) | Health/Activity API | OAuth path gated; file import live now |
| Instagram | <https://developers.facebook.com/apps> | **Meta app review** + **business verification** (legal-entity docs) — out of reach for a test deployment | `instagram_graph_user_media` | `NEXT_PUBLIC_INSTAGRAM_CLIENT_ID` + `_TOKEN_PROXY`; box keys |
| Facebook | <https://developers.facebook.com/apps> | **Meta app review** + business verification | `user_posts` | `NEXT_PUBLIC_FACEBOOK_CLIENT_ID` + `_TOKEN_PROXY`; box keys |
| TikTok | <https://developers.tiktok.com> | TikTok **developer audit** of the app + scopes | `user.info.basic video.list` | `NEXT_PUBLIC_TIKTOK_CLIENT_ID` + `_TOKEN_PROXY`; box keys |
| LinkedIn | <https://www.linkedin.com/developers/apps> | **Marketing / Member-data program** approval | `r_liteprofile r_member_social` | `NEXT_PUBLIC_LINKEDIN_CLIENT_ID` + `_TOKEN_PROXY`; box keys |
| X / Twitter | <https://developer.twitter.com/en/portal/dashboard> | **Paid API tier** + elevated access. OAuth2 **PKCE is public-client** → **no proxy needed** | `tweet.read users.read offline.access` | `NEXT_PUBLIC_XTWITTER_CLIENT_ID` only (**PROPOSED** var name — confirm the adapter's exact `NEXT_PUBLIC_*` key when the adapter ships) |
| Slack | <https://api.slack.com/apps> | Works **without public review** for workspaces you admin (workspace-admin install model) | `channels:history users:read` | `NEXT_PUBLIC_SLACK_CLIENT_ID` + `_TOKEN_PROXY`; box keys |
| Pinterest | <https://developers.pinterest.com/apps> | **Trial-access review** to leave sandbox | `boards:read pins:read` | `NEXT_PUBLIC_PINTEREST_CLIENT_ID` + `_TOKEN_PROXY`; box keys |

> **To actually light up a Tier-B PROXY provider once its review clears:**
> 1. Register the app (redirect URI as in [§1.2](#12-the-golden-rules)).
> 2. **PROPOSED code change:** add the provider to the token-proxy allowlist
>    (`services/token-proxy/src/platforms.ts`: `PLATFORM_IDS` + a `PlatformSpec` with the
>    correct `tokenEndpoint`, `authStyle`, `forwardsCodeVerifier`), add its
>    `TOKEN_PROXY_<P>_CLIENT_ID/_SECRET` to compose, and ship a matching app-side adapter.
> 3. Then follow the Tier-A PROXY go-live ([§4](#4-deploying-the-token-proxy-go-live)) +
>    image rebuild ([§5](#5-rebuild--redeploy-the-pod-manager-image)).
>
> X/Twitter is the exception: PUBLIC PKCE, so once you have the paid tier it needs only the
> client ID + a rebuild — no proxy, no allowlist change.

### 3.C Tier C — file import only (no OAuth)

These have **no user-grade OAuth API**. The user downloads their official data export and
feeds it to the app; each has a shipped parser
(`src/lib/integrations/file-adapters.ts`). Where to get each export (and the direct "Get
your export ↗" links) is documented in
[platform-approvals → Tier C](./platform-approvals.md#tier-c--file-imports-where-to-get-each-export).
No console, no secret, no env var, no rebuild needed.

| Provider | Export source | Format |
|---|---|---|
| Netflix | <https://www.netflix.com/account/getmyinfo> (full) / viewingactivity CSV | CSV |
| Amazon Orders | <https://www.amazon.co.uk/hz/privacy-central/data-requests/preview.html> | export (emailed link) |
| Uber | <https://myprivacy.uber.com/privacy/exploreyourdata/download> | ZIP (emailed link) |
| Apple Health | iPhone Health app → Export All Health Data | `export.zip` (XML) |
| WhatsApp | in-chat → Export chat → Without media | TXT (per chat) |
| Goodreads | <https://www.goodreads.com/review/import> → Export Library | CSV |
| Steam | <https://help.steampowered.com/en/accountdata> | account-data export |
| ChatGPT | Settings → Data controls → Export data | ZIP (emailed link), `conversations.json` |
| Bank statements | your online banking | CSV / OFX |
| Google Takeout | <https://takeout.google.com> | archive (emailed link) |

The URL-input enhancement for these is designed in [§6](#6-tier-c-file-import--url-input-enhancement-proposed).

---

## 4. Deploying the token-proxy (go-live)

> **Operator-run. Do not execute from here.** This flips the staged-dark proxy live so
> GitHub/Strava/Twitch/Notion can exchange codes for tokens.

### 4.1 What's already in place (verified against the box files)

- **Service is defined and hardened** in `prod-solid-server/deploy/docker-compose.single.yml`
  as service `token-proxy`, **`profiles: ["pod-manager"]`** (so it is **NOT started** by a
  normal `docker compose up`). It is staged dark.
- The compose already wires every credential: it maps `.env.prod` `PSS_TOKEN_PROXY_*` →
  container `TOKEN_PROXY_*`, and derives `TOKEN_PROXY_ALLOWED_ORIGIN=https://app.${PSS_DOMAIN}`.
- **The Caddy route already exists** — you do **not** need to add it. In
  `prod-solid-server/deploy/Caddyfile.single`, the app vhost has:

  ```caddy
  handle_path /oauth-token-proxy/* {
      reverse_proxy token-proxy:3402 {
          header_up X-Forwarded-Proto https
          header_up X-Forwarded-Host {host}
      }
  }
  ```

  `handle_path` strips the prefix, so
  `…/oauth-token-proxy/exchange/github` → `token-proxy:3402/exchange/github`, and the proxy
  is **same-origin** with the app (CORS never fires; the proxy still enforces its origin
  allowlist as defence in depth).

  > This corrects the earlier hand-off note that said the proxy lived in
  > `docker-compose.extras.yml` and the Caddy route still needed adding — both are already
  > in `*.single.{yml,Caddyfile}` and just profile-gated off.

- The public exchange path the app expects is
  `https://app.solid-test.jeswr.org/oauth-token-proxy/exchange/<platform>` — which is
  exactly what the `NEXT_PUBLIC_<APP>_TOKEN_PROXY` defaults point at ([§3.A](#3a-tier-a--end-user-oauth-adapters-shipped)).

### 4.2 Go-live steps (operator)

1. **Add the secrets** to the box `.env.prod` (`/opt/pss/src/deploy/.env.prod`), for each
   provider you're enabling — via one SSM session. The proxy enables a platform **only when
   BOTH** keys are present; otherwise that platform answers `404`:

   ```dotenv
   PSS_TOKEN_PROXY_GITHUB_CLIENT_ID=Ov23lifeDQdTb2j1XB3l
   PSS_TOKEN_PROXY_GITHUB_CLIENT_SECRET=<github oauth app secret>
   # repeat for STRAVA / TWITCH / NOTION as registered
   ```

   (`PSS_DOMAIN` must already be set — `TOKEN_PROXY_ALLOWED_ORIGIN` is derived from it.)

2. **Caddy route:** already present (§4.1) — nothing to add. Only confirm it's there if you
   suspect drift.

3. **Start the profile-gated services** by naming the `pod-manager` profile (this also
   covers the pod-manager static image). From `/opt/pss/src/deploy`:

   ```sh
   docker compose --env-file .env.prod -f docker-compose.single.yml --profile pod-manager up -d token-proxy
   # (or `--profile pod-manager up -d` to (re)start the whole pod-manager profile)
   ```

4. **Verify** (internal-only port; via the public path):

   ```sh
   curl -sI https://app.solid-test.jeswr.org/oauth-token-proxy/status   # 200 = live
   ```

   A configured platform returns a token response on `POST /exchange/<platform>`; an
   unconfigured one returns `404` (no enabled-platform oracle, by design).

5. **Flip the app side:** uncomment / set the matching `NEXT_PUBLIC_<APP>_TOKEN_PROXY` in
   `.env.production`, then **rebuild + redeploy the image** ([§5](#5-rebuild--redeploy-the-pod-manager-image)).
   Until both the proxy is live **and** the build carries the `_TOKEN_PROXY` var, the
   adapter stays in demo mode.

> **Security recap** (full detail in the
> [token-proxy README](../../prod-solid-server/services/token-proxy/README.md)): no caller
> auth (single-use codes + pinned redirect_uri + per-IP rate limit are the floor); `Origin`
> required and pinned; secrets never logged; refresh tokens in the pod are bearer
> credentials. PKCE only hardens GitHub.

---

## 5. Rebuild & redeploy the pod-manager image

> **Required whenever any `NEXT_PUBLIC_*` value changes** (new client ID, newly-enabled
> token-proxy URL). The static export bakes these in; editing `.env.production` alone does
> nothing live. **Reference only — do not run from here.** Source of truth for the build
> contract: `solid-pod-manager/Dockerfile` header and `package.json` `build:prod`.

1. **Edit `.env.production`** (commit — these are PUBLIC client IDs and proxy URLs only).

2. **Build the static export for the production origin** (this bakes
   `NEXT_PUBLIC_APP_ORIGIN=https://app.solid-test.jeswr.org` and the matching
   `clientid.jsonld`):

   ```sh
   npm run build:prod          # = NEXT_PUBLIC_APP_ORIGIN=https://app.solid-test.jeswr.org next build
   ```

3. **Build + push the image.** The Dockerfile **refuses** an export baked for the wrong
   origin (it greps `clientid.jsonld` for the `APP_ORIGIN` client_id), so a stray
   `npm run build` will fail the image build — that's intended. Build multi-arch and push
   to GHCR (the repo's normal buildx flow / supply-chain workflow):

   ```sh
   docker buildx build --platform linux/amd64,linux/arm64 \
     -t ghcr.io/jeswr/solid-pod-manager:<tag> --push .
   # (or let the CI supply-chain.yml build + sign + push, then read the digest)
   ```

4. **Re-pin the digest on the box.** The compose pulls
   `ghcr.io/jeswr/solid-pod-manager@${PSS_POD_MANAGER_IMAGE_DIGEST}` (pinned by digest, CIS
   4.2/5.27). Update `PSS_POD_MANAGER_IMAGE_DIGEST` in `.env.prod` to the new
   `sha256:…`, then:

   ```sh
   docker compose --env-file .env.prod -f docker-compose.single.yml --profile pod-manager pull pod-manager
   docker compose --env-file .env.prod -f docker-compose.single.yml --profile pod-manager up -d pod-manager
   ```

5. **Smoke check** the deployed origin (security headers exist only in the served image):

   ```sh
   curl -sI https://app.solid-test.jeswr.org/ | grep -i content-security-policy
   ```

   Then connect a newly-live integration end to end and confirm the "Demo data" badge is
   gone.

> If you use GitOps for the box (`prod-solid-server/deploy/GITOPS.md`), steps 4–5 are a
> commit bumping the digest rather than a manual `compose up`.

---

## 6. Tier C file-import + URL-input enhancement (PROPOSED)

> **Status: PROPOSED — not yet built.** This is the maintainer's feature request, designed
> here for later pickup.

### 6.1 Motivation

Several Tier C providers **email the user a download link** to their export archive rather
than a file they already have on disk. Today the user must download from that link, then
re-upload into the Pod Manager. The enhancement lets the user **paste the link** instead,
and the app fetches the archive **server-side**.

### 6.2 Which Tier C providers deliver a link vs a local file

| Provider | Delivery | URL-input viable? | Notes |
|---|---|---|---|
| **Google Takeout** | **Emailed link** (canonical example) | **Yes** | Time-limited **signed Google URL**; allows a direct unauthenticated `GET`. Best candidate. |
| Amazon Orders | Emailed link | Likely | "Request Your Information" arrives by email link; verify it's a direct-GET signed URL vs a logged-in page. |
| Uber | Emailed link | Likely | "Download your data" ZIP arrives by email; same caveat as Amazon. |
| ChatGPT | Emailed link | Likely | Export ZIP arrives by email link; typically a signed/expiring URL. |
| Netflix | Mixed | Partial | Per-profile CSV is a direct download while logged in (session-bound → URL-fetch usually **won't** work); full archive via getmyinfo is emailed later. |
| Steam | Logged-in pages | **No** | Account-data tool requires an authenticated Steam session — no shareable direct link. |
| Goodreads | Logged-in action | **No** | "Export Library" produces a CSV behind your session. |
| Bank statements | Logged-in download | **No** | Behind online-banking auth; never a public link. |
| Apple Health | **Local device export** | **No** | `export.zip` is produced on-device and shared locally; there is no URL at all. |
| WhatsApp | **Local export** | **No** | Per-chat TXT exported on-device; no link. |

**Rule of thumb:** URL-input works only for providers that hand out a **direct,
unauthenticated (signed) GET URL** — primarily **Google Takeout**, plausibly
Amazon/Uber/ChatGPT. Anything session-bound or device-local stays **upload-only**.

### 6.3 Proposed UX

Each file-import connect screen offers **both**:
- **Upload file** (existing) — drag/drop or picker.
- **Paste link to file** (new) — a URL input, shown only for providers flagged
  `urlImport: true` in their adapter metadata.

When a URL is supplied, the app does **not** fetch it from the browser (CORS would block a
cross-origin archive fetch). Instead it calls a small **server-side import-fetch route**
that streams the archive down and hands the bytes to the same parser the upload path uses.
Surface clear errors: *"This link looks expired or single-use — re-request your export"*
and *"This source needs you to be logged in; please download and upload the file instead."*

### 6.4 Security caveats (mandatory for the server route)

A server-side fetcher is an **SSRF sink**. The import-fetch route MUST:
- **Block internal/loopback/link-local/metadata targets** (no `127.0.0.0/8`, `10/8`,
  `172.16/12`, `192.168/16`, `169.254/16` incl. `169.254.169.254`, `::1`, `fc00::/7`),
  resolve+pin DNS, and re-check after redirects (deny redirects to private space). Reuse
  the server's existing SSRF-guard pattern (the WebID-profile fetch guard in
  `prod-solid-server` is the reference).
- **Allow only `https://`**, and ideally allowlist host suffixes for known providers
  (e.g. `*.google.com` / Takeout's storage host) for the first cut.
- Enforce a **max download size** (stream with a hard byte cap) and a **fetch timeout**.
- Treat the link as **single-use / expiring** — fetch once, never store the URL, surface a
  clear "expired" error.
- **Not** be the browser and **not** be a general proxy — a dedicated, narrowly-scoped
  route (token-proxy-adjacent, or its own `import-fetch` service) so it can't be abused as
  an open relay.

### 6.5 "What to implement" checklist (for later pickup)

- [ ] Add `urlImport?: boolean` (+ optional `urlImportHostAllowlist`) to file-adapter metadata; set `true` for Google Takeout (and trial Amazon/Uber/ChatGPT).
- [ ] Build an `import-fetch` server route (new service or token-proxy-adjacent): `POST /import-fetch` `{ url, provider }` → streams bytes back (or to a temp), behind the SSRF guard, https-only, size+timeout caps, redirect re-validation.
- [ ] Caddy: path-split a `/import-fetch/*` route on the app vhost (same pattern as `/oauth-token-proxy/*`) so it's same-origin.
- [ ] App: add the "Paste link to file" input to the connect screen, gated on `urlImport`; POST to `/import-fetch`; pipe the result into the existing parser; reuse the existing import/idempotency path.
- [ ] Errors: expired/single-use link, login-required source, oversize, unsupported host.
- [ ] Tests: SSRF-deny cases (internal IPs, redirect-to-private), size cap, a recorded signed-Takeout-URL happy path.
- [ ] Docs: flip the relevant rows in §6.2 from "PROPOSED" to live; cross-link from [integrations-catalog.md](./integrations-catalog.md).

---

## 7. Discord follow-ups + BYOD domain-purchase operator notes

> **Context only.** These are the operator's decisions; nothing here is instructed and
> nothing irreversible should be done from this runbook. Tracked as tasks #54 (Discord) and
> #52 (domain purchase).

### 7.1 Discord app follow-ups (App ID `1514927045430214667`)

1. **Add tags** in the Discord dev portal — **cosmetic** only; safe, no server work.
2. **Interaction Endpoint URL** — **PROPOSED / unbuilt.** Requires a server endpoint that
   verifies **ed25519** request signatures using the app public key
   `2302f2b6b29c8761213b91ff3a9155f8cf3d4345d07c34813eecd6bedc45bcef`
   (already noted as `DISCORD_APP_PUBLIC_KEY` in `.env.production` comments). Discord pings
   this URL with a signed `PING` and expects a verified `PONG`; do **not** set the URL in
   the portal until that endpoint exists, or the app save will fail validation. Design later.
3. **Linked Roles Verification URL** — **PROPOSED / unbuilt.** A new server surface for
   Discord Linked Roles. Design later; independent of (2).

(2) and (3) are unbuilt server endpoints — leave the portal fields blank until built.

### 7.2 BYOD domain purchase (Route 53 Domains) — operator decisions pending

The server-side pipeline for in-service domain purchase is **built behind a flag (PR #122)**.
The remaining items are **operator decisions only** — do not action from here:
- **IAM `route53domains` policy** — scope and attach the permissions for the purchase role.
- **Billing posture** — registrar charges are real money; decide budget/limits/approval.
- **One real, budgeted end-to-end purchase** — the first live buy to validate the pipeline.

---

## 8. Final checklist

**Per integration going live:**
- [ ] Register the app at the provider console (fields → [platform-approvals.md](./platform-approvals.md)).
- [ ] Redirect URI registered **exactly**: `https://app.solid-test.jeswr.org/oauth-callback.html` (Strava: domain only, `app.solid-test.jeswr.org`).
- [ ] Scopes/permissions set **before** anyone connects (Dropbox, Notion especially).
- [ ] **PUBLIC app:** set `NEXT_PUBLIC_<APP>_CLIENT_ID` in `.env.production` → rebuild image (§5).
- [ ] **PROXY app:** also set `NEXT_PUBLIC_<APP>_TOKEN_PROXY`; put `PSS_TOKEN_PROXY_<APP>_CLIENT_ID/_SECRET` in box `.env.prod`; secrets via SSM only, never in repo/chat/`NEXT_PUBLIC_*`.

**Token-proxy go-live (GitHub/Strava/Twitch/Notion):**
- [ ] Secrets in `.env.prod` as `PSS_TOKEN_PROXY_*` (both ID + secret per platform).
- [ ] Caddy `/oauth-token-proxy/*` route confirmed present (already wired — §4.1).
- [ ] Start with `--profile pod-manager up -d token-proxy`.
- [ ] `GET /oauth-token-proxy/status` → 200; `POST /exchange/<platform>` works for configured platforms.

**Image rebuild/redeploy (any `NEXT_PUBLIC_*` change):**
- [ ] `npm run build:prod` → `docker buildx … --push` → bump `PSS_POD_MANAGER_IMAGE_DIGEST` → `compose pull && up -d pod-manager`.
- [ ] Smoke: CSP header present; the integration shows live (no "Demo data" badge) and completes a real import.

**Open items (operator decisions — not actioned here):**
- [ ] Tier-B reviews per provider (most need a NEW token-proxy allowlist entry — PROPOSED — except X/Twitter which is PUBLIC).
- [ ] Tier C URL-input enhancement (§6) — PROPOSED; pick up the §6.5 checklist.
- [ ] Discord Interaction Endpoint + Linked Roles endpoints (§7.1) — PROPOSED/unbuilt.
- [ ] BYOD domain purchase IAM/billing/first-buy decisions (§7.2).
