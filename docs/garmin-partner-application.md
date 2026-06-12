# Garmin Connect Developer Program — application draft

> Status: READY TO SUBMIT (pending the program reopening — see "Program status",
> below). Drafted 2026-06-12 for the maintainer to paste into Garmin's access
> request form. Square-bracketed fields are placeholders the maintainer must
> fill before submitting.

## Where to apply

- **Application form**: <https://www.garmin.com/en-US/forms/GarminConnectDeveloperAccess/>
  ("Garmin Connect Developer Program Access Request Form" — the entry point the
  [Program FAQ](https://developer.garmin.com/gc-developer-program/program-faq/)
  and [program overview](https://developer.garmin.com/gc-developer-program/) route to).
- **Program contact**: `connect-support@developer.garmin.com`; general developer
  contact form: <https://www.garmin.com/en-US/forms/developercontactus/>.
- After approval, apps and API keys are managed in the developer portal:
  <https://developerportal.garmin.com/developer-programs/connect-developer-api>.

### Program status (honest caveat — verified 2026-06-12)

New access requests are currently **paused**: the request form has been pulled
and Garmin forum staff have confirmed the program is on hold with no projected
reopening date (official guidance: watch developer.garmin.com and use the
developer contact form above). This draft exists so we can submit the day it
reopens. Until then the app's Garmin integration honestly ships as a **file
import of the user's own Garmin Connect export** (`Activities.csv` / GPX / TCX
— see `src/lib/integrations/garmin/file-adapter.ts`), which needs no API
access at all.

Sources: [Program FAQ](https://developer.garmin.com/gc-developer-program/program-faq/) ·
[Access request form](https://www.garmin.com/en-US/forms/GarminConnectDeveloperAccess/) ·
[forum thread confirming the pause](https://forums.garmin.com/apps-software/mobile-apps-web/f/garmin-connect-mobile-andriod/433735/is-the-garmin-connect-developer-program-down-i-can-t-submit-a-request/2029936) ·
[Activity API](https://developer.garmin.com/gc-developer-program/activity-api/) ·
[Health API](https://developer.garmin.com/gc-developer-program/health-api/).

> Note: the FAQ states the program is "available for enterprise use" with a
> ~2-business-day application review and a 1–4-week integration (no licensing
> fee for the standard APIs). If Garmin rejects a personal/open-source
> applicant, the fallback remains the shipped export-file import.

## Application answers (paste-ready)

### Applicant / company

| Field | Value |
|---|---|
| Contact name | [MAINTAINER FULL NAME — Jesse Wright] |
| Contact email | [jesse@jeswr.org] |
| Company / organisation | [LEGAL ENTITY OR "Individual developer / open-source project" — confirm before submitting] |
| Company website | <https://app.solid-test.jeswr.org> (app) · [project/org site if preferred] |
| Country | [United Kingdom] |
| App name | Pod Manager |
| App / marketing URL | <https://app.solid-test.jeswr.org> |
| OAuth redirect URI | `https://app.solid-test.jeswr.org/oauth-callback.html` |
| Privacy policy | <https://app.solid-test.jeswr.org/privacy> (live) |
| Terms of service | <https://app.solid-test.jeswr.org/terms> (live) |

### Requested APIs

- **Activity API** — activity summaries (type, start time, duration, distance,
  calories) for the user's own recorded activities. This is the core need.
- **Health API** — daily wellness summaries (steps, heart rate, sleep), if the
  program bundles it; we request the minimum scope Garmin offers
  (`activity:read`-equivalent) and nothing write-side.

Not requested: Training API, Courses API, Women's Health API, device SDKs.

### Use-case description (the "how will you use Garmin data" answer)

> Pod Manager (https://app.solid-test.jeswr.org) is a client-side web app that
> helps a person collect *their own* data into their personal **Solid pod** — a
> standards-based personal data store (W3C Solid protocol) that the user
> controls. With the user's explicit, per-connection consent, Pod Manager
> fetches the user's Garmin activity summaries and writes them into the user's
> own pod as schema.org RDF (workouts as `schema:ExerciseAction`, journeys as
> `schema:TravelAction`).
>
> Key properties of the integration:
>
> - **User-initiated, user-scoped**: data is only ever fetched when the signed-in
>   user clicks "Connect Garmin" and completes Garmin's OAuth consent. Each user
>   accesses only their own account.
> - **No third-party sharing**: Garmin data goes from Garmin, through the user's
>   browser, into the user's own pod. There is no analytics, advertising,
>   resale, aggregation, or any server-side copy held by us.
> - **Data minimisation**: we request the smallest scope that covers activity
>   summaries; we store only summary fields (name, type, start time, duration,
>   distance, calories) — no raw sensor streams.
> - **Token handling**: OAuth tokens are held in browser memory only — never in
>   localStorage and never logged; the code→token exchange runs through a
>   minimal stateless proxy solely because Garmin requires a confidential
>   client. The user can disconnect at any time and delete the imported data
>   from their pod themselves (it is their storage).
> - **Open source**: the integration code is reviewable by Garmin on request.

### Expected volumes

- Deployment stage: **test deployment** (app.solid-test.jeswr.org).
- Users: single-digit to low tens of users during evaluation; projected
  < 1,000 users in the first year.
- API load: one activity-list pull per user-initiated import (typically a few
  per user per month), ~100 activity summaries per pull, no polling and no
  background sync in the current design.

### Data privacy & retention summary

- Personal data processed: the user's own Garmin activity summaries.
- Storage location: the **user's own Solid pod** (storage provider chosen by
  the user); the application operator retains **no copy**.
- Retention: controlled entirely by the user — they can delete the imported
  documents from their pod at any time; disconnecting Garmin revokes our access
  (tokens are in-memory, so closing the tab already drops them).
- Sub-processors / sharing: none.
- Applicable policy: <https://app.solid-test.jeswr.org/privacy>.

## After approval — integration checklist (maps to the adapter)

1. Create the app in the developer portal; record the client id.
2. Set `NEXT_PUBLIC_GARMIN_CLIENT_ID` at build time.
3. Deploy the confidential code→token exchange proxy; set
   `NEXT_PUBLIC_GARMIN_TOKEN_PROXY`.
4. Confirm the redirect URI `https://app.solid-test.jeswr.org/oauth-callback.html`
   matches the portal registration.
5. The Tier-B adapter (`src/lib/integrations/garmin/adapter.ts`) then goes live
   automatically per the catalog's live-readiness policy; the file import keeps
   working as the no-API fallback.
