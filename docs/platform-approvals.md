# Platform approvals worksheet — data integrations

> Working copy for the maintainer, field-by-field per console. Tier A = registration
> only, no review. Console UIs drift occasionally; field names below are current as of
> 2026-06 — if a label differs slightly, the intent column tells you what it's for.

## Shared values (used on every form)

| Value | |
|---|---|
| App name | `Pod Manager` (if a platform says the name is taken, use `Pod Manager — Solid`) |
| Short description | `Import your data from the services you use into your personal Solid pod — storage you own and control.` |
| Long description | `Pod Manager imports your data from services you use into your personal Solid pod — storage you own and control. It reads only the data you explicitly authorize and writes it to your private pod. Your data is never shared with the developer or any third party; it goes only to your own storage.` |
| Website / homepage | `https://app.solid-test.jeswr.org` |
| Privacy policy URL | `https://app.solid-test.jeswr.org/privacy` ⚠️ real page being added — fine to enter now; Notion + Tier-B reviews check content, so do Notion last |
| Terms of use URL | `https://app.solid-test.jeswr.org/terms` ⚠️ same |
| Redirect / callback URI | `https://app.solid-test.jeswr.org/oauth-callback.html` |
| App icon (when asked) | `/tmp/pod-manager-icons/icon-512.png` (also 256/128 there) |
| Email (when asked) | jesse@jeswr.org |

---

## 1. Spotify — developer.spotify.com/dashboard

Log in → **Create app**. Form fields:

| Field | Enter |
|---|---|
| App name | `Pod Manager` |
| App description | the short description |
| Website | the homepage |
| Redirect URIs | the redirect URI → click **Add** |
| Which API/SDKs are you planning to use? | ✅ **Web API** only |
| Terms checkbox | accept (Spotify Developer Terms) |

After **Save**: open the app → **Settings** → copy the **Client ID** → paste to me.
(Ignore the client secret — not needed, Spotify does secretless PKCE.)

> Dev-mode cap: 25 users, and each must be allow-listed under **User Management**
> (add your own Spotify account email there now). Extended quota = a later review.

## 2. Discord — discord.com/developers/applications

**New Application** → Name: `Pod Manager` → Create.

| Where | What |
|---|---|
| General Information | Description: short description · App icon: icon-512.png (optional) |
| OAuth2 → Redirects | **Add Redirect** → the redirect URI → Save Changes |
| OAuth2 → Client information | copy **Client ID** → paste to me |
| OAuth2 → **Public Client** toggle | **ON** (required — lets the token exchange run without a secret) |

## 3. Reddit — reddit.com/prefs/apps

Scroll to bottom → **create another app…**:

| Field | Enter |
|---|---|
| name | `Pod Manager` |
| type (radio) | ✅ **installed app** (not "web app", not "script") |
| description | the short description |
| about url | the homepage |
| redirect uri | the redirect URI |

**create app**. The **client ID is the string directly under the app name** in the
created card (there is no labelled field; installed apps have no secret). Paste it to me.

## 4. Dropbox — dropbox.com/developers/apps

**Create app**:

| Step | Choose |
|---|---|
| 1. Choose an API | **Scoped access** |
| 2. Choose the type of access | **Full Dropbox** (the adapter reads file/folder metadata across the account) |
| 3. Name your app | `Pod Manager` (globally unique — suffix if taken) |

Then in the app's console:

| Tab | What |
|---|---|
| **Permissions** | tick `files.metadata.read` and `account_info.read` → **Submit** (do this BEFORE anyone connects) |
| **Settings** | Redirect URIs → add the redirect URI → Add. Copy **App key** (= the client ID) → paste to me. Ignore App secret. |

> Dev-mode cap: 50 connected users; "Production" is a self-serve button + checklist later.

## 5. GitHub — github.com/settings/developers

**OAuth Apps** → **New OAuth App**:

| Field | Enter |
|---|---|
| Application name | `Pod Manager` |
| Homepage URL | the homepage |
| Application description | the short description |
| Authorization callback URL | the redirect URI |
| Enable Device Flow | leave unchecked |

**Register application** → copy **Client ID** (paste to me) → **Generate a new client
secret** → store the secret somewhere safe (1Password etc.) — it goes on the box later,
never in chat.

## 6. Strava — strava.com/settings/api

(One app per account; 2 minute form. Strava **requires** an icon upload.)

| Field | Enter |
|---|---|
| Application Name | `Pod Manager` |
| Category | `Data Importer` (or the closest available) |
| Club | leave blank |
| Website | the homepage |
| Application Description | the short description |
| Authorization Callback Domain | `app.solid-test.jeswr.org` ← **domain only, no https://, no path** |
| App Icon | upload `/tmp/pod-manager-icons/icon-512.png` |

After save the page shows **Client ID** (paste to me) and **Client Secret** (store safely).

> New Strava apps are capped to **1 connected athlete** (you) until you request a
> capacity increase — fine for now.

## 7. Twitch — dev.twitch.tv/console/apps

(Your Twitch account needs **2FA enabled** before it can register apps.)

**Register Your Application**:

| Field | Enter |
|---|---|
| Name | `Pod Manager` (globally unique — suffix if taken) |
| OAuth Redirect URLs | the redirect URI → Add |
| Category | `Website Integration` |
| Client Type | **Confidential** (we exchange via the server-side proxy) |

**Create** → **Manage** → copy **Client ID** (paste to me) → **New Secret** (store safely).

## 8. Notion — notion.so/my-integrations  ⚠️ DO THIS LAST

Notion's **public** integration form requires real privacy + terms URLs (being added)
and more company details:

**New integration** → Name `Pod Manager`, workspace: yours → after creation switch
type to **Public integration**, which asks:

| Field | Enter |
|---|---|
| Company / developer name | `Jesse Wright` |
| Website | the homepage |
| Privacy policy URL | the privacy URL (wait until I confirm the real page is live) |
| Terms of use URL | the terms URL (same) |
| Support email | jesse@jeswr.org |
| Redirect URIs | the redirect URI |
| Capabilities | **Read content** ✅ · Read user information **without email** ✅ · no write/insert |

From the integration's secrets section: **OAuth client ID** (paste to me) +
**OAuth client secret** (store safely).

---

## What happens with what you hand me

- **Client IDs (all 8)** → chat is fine (public identifiers). I bake them into the next
  app image as `NEXT_PUBLIC_<APP>_CLIENT_ID` and deploy; each integration flips from
  "Demo data" to live.
- **Client secrets (GitHub, Strava, Twitch, Notion)** → never in chat. The token-exchange
  proxy (in build) holds them on the box; I'll give you the exact `.env.prod` key names
  when its PR lands, and you add them in one SSM session.

## Tier C — file imports: where to get each export

No registration or approval at all — the user downloads their export and feeds it to the
app. Direct links (also being added as "Get your export ↗" links on each connect page):

| Source | Export lives at | Notes |
|---|---|---|
| Google Takeout | <https://takeout.google.com> | choose **My Activity**, format **JSON**; the app reads `MyActivity.json` from the unzipped archive |
| Netflix | <https://www.netflix.com/viewingactivity> | per-profile "Download all" CSV; full archive via <https://www.netflix.com/account/getmyinfo> (takes a day) |
| Amazon orders | <https://www.amazon.co.uk/hz/privacy-central/data-requests/preview.html> | "Request Your Information" → Your Orders (`.com` for US accounts); arrives by email link |
| Uber | <https://myprivacy.uber.com/privacy/exploreyourdata/download> | "Download your data"; ZIP arrives by email |
| Apple Health | *(no web page)* | iPhone **Health app** → your profile picture → **Export All Health Data** → share the `export.zip` |
| WhatsApp | *(no web page)* | in a chat → **⋮ → More → Export chat** → *Without media* (TXT); per-chat only |
| Goodreads | <https://www.goodreads.com/review/import> | **Export Library** button → CSV |
| Steam | <https://help.steampowered.com/en/accountdata> | "Data Related to Your Steam Account" pages; export via the account-data tool |
| ChatGPT | <https://chatgpt.com> | Settings → **Data controls** → **Export data**; ZIP arrives by email (`conversations.json`) |
| Bank statements | your online banking | look for Statements / Export → **CSV** or **OFX** |

## Tier B reviews (drafts on request — say "draft <platform>")

Realistic: **Fitbit** (personal app works immediately; server-type review is light) and
**Google Calendar** (OAuth verification questionnaire + demo video; our
data-goes-only-to-your-own-pod story is strong). Out of reach for a test deployment:
Meta/TikTok/LinkedIn (business verification with legal-entity documents). X requires a
paid API tier. Slack works without review for workspaces you admin. YouTube history
scopes are effectively closed — use Google Takeout (Tier C) instead.

## Registered so far (2026-06-12)

| Platform | Client ID | Status |
|---|---|---|
| Spotify | `784e49da3e3a41738f4325e328bda8c8` | **LIVE** (remember: add your Spotify account email under User Management — dev mode is allow-listed) |
| Discord | `1514927045430214667` | **LIVE** (check the Public Client toggle is ON) |
| GitHub | `Ov23lifeDQdTb2j1XB3l` | ID baked; **demo until token proxy deploys** + secret on box |

### Discord follow-up TODOs (maintainer-requested, tracked as task #54)
- [ ] Add tags to the Discord application (developer portal, cosmetic)
- [ ] Interaction Endpoint URL — needs a signature-verifying server endpoint (app public key `2302f2b6…bcef`, ed25519)
- [ ] Linked Roles Verification URL — new server surface, design when prioritised
