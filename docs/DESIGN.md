# Pod Manager — Interface Design Plan

> Status: PLAN (for review). 2026-06-09. A consumer Pod-management web app — a personal-data
> dashboard where a non-technical person views/adds/organises the data in their Solid Pod and
> controls which apps may access which categories. Mirrors the Tim Theys / ODI "Solid Pod" demo.
> Standalone Solid client (uses Solid APIs directly) → moves to its own repo.

Grounded in a cited UX research pass (`docs/research/` summary below) + the `solid-ai-coding`
`AGENTS.md` stack guide.

## 1. What the research decided (the load-bearing findings)

| # | Finding | Design consequence |
|---|---|---|
| R1 | Solid Pods raise perceived **transparency & control** but **NOT trust, usability, or intention-to-use** (Theys et al., *Interacting with Computers* 2025). | **Trust + usability are explicit design goals**, not free side-effects — invest in onboarding, plain-language copy, reliability cues, polish, undo. This is the #1 product risk. |
| R2 | Existing Solid tools (Penny, PodOS) are **developer-oriented**; PodOS has **no** sharing/permission component. | A consumer Pod Manager is a real gap. The **consent manager is built fresh**. Reuse PodOS's *content-type → viewer* pattern for category/detail screens (don't depend on its components). |
| R3 | Password-manager IA (1Password): **fixed two-tier taxonomy** (short "Common" tier + long tail) + cross-cutting sidebar; security dashboard ("Watchtower") is **first-class**, not buried. | Pod categories → a short common tier + tail; the **permission manager is a top-level section**, like Watchtower. |
| R4 | Permission model (Android/iOS/OAuth dashboards): **per-app**, **just-in-time/contextual**, **graduated** (one-time / ongoing), **one-click revoke anytime**. | Per-app detail screen + graduated grants + prominent revoke. Revoke is one click (UX norm; not over-claimed as legal mandate). |
| R5 | Consent screens must be **GDPR-valid, dark-pattern-free**: Accept/Reject **equal visual weight**, **per-purpose/per-category**, plain language, clear affirmative action, **no consent wall** (never gate the user's own data behind third-party grants). | The grant/consent screen spec in §5. The user's *own* dashboard is never gated on any third-party grant. |
| R6 | Trust cues: Apple-style **one-sentence "privacy assurances"** per category/app + a **concrete benefit rationale per request** (12% → up to 81% grant lift; Tan et al. CHI'14). | Copy patterns in §6: "[app] wants your [data] so you can [benefit]"; per-category assurance lines. |
| R7 | Data-dense dashboards: **inverted pyramid + progressive disclosure**, minimise scrolling, no horizontal scroll, limit clicks-to-data (UK Gov). | Home surfaces headlines; detail is one drill-down deeper. |
| R8 | **WCAG 2.2 AA**: 4.5:1 contrast, 200% resize, 400% reflow; aggregate dense views + always provide an accessible underlying **table** (View-Data equivalent). | Accessibility is a build requirement (§8), not a polish phase. |

Open questions the research flagged (carried to §11): optimal common-tier category set (needs user
validation), which interventions actually move trust, access-log IA for non-technical users,
onboarding/empty-state design.

## 2. Product principles
1. **Transparency & control are the product** — and trust/usability must be *earned* (R1).
2. **Plain language, never jargon** — no "WebID", "ACL", "container", "RDF" in the default UI.
3. **The user's data is theirs, unconditionally** — no consent walls; managing your own pod never
   requires granting anyone anything (R5).
4. **Honest by construction** — equal-weight choices, accurate "who can see what", easy revoke (R4/R5).
5. **Calm, trustworthy, fast** — privacy-first tone; every async surface has loading/empty/error.
6. **Accessible by default** — WCAG 2.2 AA from the first component (R8).

## 3. Information architecture

Primary nav (persistent sidebar on desktop, bottom-bar/drawer on mobile):

| Section | Purpose |
|---|---|
| **Home** | Inverted-pyramid dashboard: "N apps have access", recent activity, alerts, quick actions (R7). |
| **My data** | Browse pod data by **category**. Two-tier (R3): a short **Common** tier (Identity, Contacts, Health, Finance, Calendar, Media) above an **Other** tail (Work & education, Mobility, Documents, …). Each category → list/detail. |
| **Connected apps** | The permission manager (the "Watchtower" — first-class, R3/R4). Per-app list → app detail (which categories, when last accessed, revoke). |
| **Activity** | Plain-language access log: which app read/wrote which category, when (R-openQ; v2-friendly). |
| **Settings** | Account, pod/profile basics, recovery, sign-out. Minimal. |

**Category taxonomy** maps to Solid storage + **Type Index** registrations (§9): each category is a
set of `solid:TypeRegistration`s / containers; the UI shows categories, never paths.

## 4. Key screens

1. **Onboarding / first-run** — a logged-in, never-heard-of-Solid user reaches value in ~30s
   (AGENTS.md): a 2–3 step explainer ("your data lives in your pod; you decide who sees it"), then
   the Home dashboard. Empty categories show a friendly "Add your first …" CTA (R-openQ).
2. **Home dashboard** — headline cards (apps-with-access count, categories with data, alerts), a
   recent-activity strip, quick actions (Add data, Review apps). One drill-down to anything (R7).
3. **My data → category list** — items in a category (e.g. Health → measurements, conditions). Each
   item shows a one-line privacy assurance ("Only apps you approve can read your health data", R6).
4. **Item / resource detail** — content-type-aware viewer (PodOS pattern, R2): a friendly renderer
   when the type is known, a safe generic view otherwise; edit/delete; "who can see this".
5. **Add data / connect source** — add manually or connect a source (file upload, or an app/service
   that writes a category). Just-in-time, benefit-framed (R4/R6).
6. **Connected apps (permission manager)** — list of apps with access; each row: app name+logo,
   categories it can touch, last access, **one-click revoke** (R4). Per-app **detail**: full
   category list with per-category toggles, plain-language scope + assurance, revoke-all.
7. **Grant / consent screen** (when an app requests access) — the GDPR-valid screen (§5).
8. **Access log / activity** — chronological, plain-language, filterable by app/category (v2 depth).

Every screen: **loading / empty / error** states; mobile-first at 375/768/1280.

## 5. The consent / grant screen (dark-pattern-free) — spec

When an app requests access (or the user grants from app detail):
- **Per-category, separately** — one toggle/row per data category requested; no bundled all-or-nothing (R5).
- **Plain-language scope** per row + a **benefit rationale**: "*Mara Coach* wants your **activity &
  health** data so it can build your training plan." (R6)
- **Equal-weight Accept / Decline** — same size, style, position; Decline never smaller or hidden (R5).
- **Graduated** where it maps cleanly — e.g. "Share once" vs "Keep sharing" (R4). (Solid grants are
  ongoing ACL reads; "share once" = a time-boxed/one-shot grant — see §9 caveat.)
- **No consent wall** — declining returns the user to their pod unharmed; their own data is never gated (R5).
- A persistent assurance: "You can change or revoke this anytime in Connected apps."

## 6. Trust & transparency copy patterns (R1/R6)
- **Per-category assurance** (one sentence): "Only apps you approve can read your health data."
- **Per-request rationale**: "`{app}` wants your `{category}` so you can `{benefit}`." User-benefit framed.
- **Who-can-see-this** affordance on every item/category: a clear list of apps with current access.
- **Revoke confirmation that reassures, not scares**: "`{app}` can no longer read your `{category}`."
- Reliability/honesty cues: last-synced timestamps, clear error recovery, undo on destructive actions.

## 7. Visual / brand tone
Privacy-first, calm, modern, trustworthy — closer to a banking/health app than a dev tool.
Deliberate type hierarchy + spacing rhythm and a **chosen palette (not default grey)** per the
`web-design-guidelines` / `emil-design-eng` / `web-typography` / `color-mode-and-theme` skills.
shadcn/ui + Lucide for consistent, accessible primitives. Light + dark.

## 8. Accessibility (WCAG 2.2 AA — a build requirement) (R8)
Semantic HTML, full keyboard nav, visible focus, 4.5:1 text contrast (3:1 large), 200% resize / 400%
reflow without loss of function. Data-dense lists: aggregate where possible **and** expose the
underlying data as a properly-marked-up **accessible table**. Native `<a href>` per the
`accessible-html-links` skill; no `<div onclick>` navigation. axe-core checks in CI.

## 9. Architecture — standalone Solid client (repo-ready)

**Stack (per `AGENTS.md`):** Next.js (App Router) + TypeScript + Tailwind + **shadcn/ui** (Radix),
Lucide icons, `react-hook-form` + `zod`, `sonner`. Node ≥ 24. Vercel-deploy-shaped. **No Inrupt libs.**

**Solid layer (`src/lib/`, the only code that touches RDF):**
| Concern | Library |
|---|---|
| Browser auth (Solid-OIDC, DPoP, global-fetch patch) | `@solid/reactive-authentication` protocol layer; first-party login UI + popup lifecycle (`src/lib/popup-login.ts`, no web components) |
| Typed pod data (WebID profile, containers, WAC/ACP docs) | `@solid/object` + `@rdfjs/wrapper` + `n3` |
| RDF fetch | `@jeswr/fetch-rdf` (no `fetch` arg → uses the auth-patched global) |
| **Data discovery** (categories → where data lives) | **Type Index** (`solid:publicTypeIndex` / `privateTypeIndex`, `solid:forClass`) — the `solid-type-index` skill; bootstrap if absent |
| **Permissions** (who can access what) | **WAC / ACP** ACL docs via `@solid/object` typed accessors (the `solid-wac` house rule — never hand-build triples) |
| **Live updates** | **Solid Notifications** (WebSocketChannel2023) — the `solid-notifications` skill — so the dashboard reflects pod changes without polling |
| Scale (large collections) | `solid-scale-and-sharding` patterns if a category grows large |

**Mapping the demo's "keys & gates" to Solid mechanisms:**
- A **data category** = a set of Type-Index registrations / containers.
- **"Granting an app a gate"** = writing a WAC/ACP rule giving that app's agent **Read** (and/or
  Append/Write) to the category's resources. **Revoke** = removing that rule. The "Connected apps"
  view is a *read model* over the pod's ACLs (which agents have access to which resources).
- **Caveat to resolve in the plan review:** classic **WAC has no native time-boxed/"share once"
  grant** and Solid-OIDC access is per-agent. True one-time/expiring grants need ACP (richer policy)
  or an access-grant/UMA layer. v1 will likely do **ongoing grant + easy revoke** (matches R4's
  baseline) and mark "share once" as a v2 item — flagged as **Open Question Q3**.

**Layering & rules (AGENTS.md):** `src/lib/` = typed, TSDoc'd data layer (auth, RDF I/O, Type-Index
discovery, ACL read/write, notifications). `app/` + `src/components/` = UI, **never touches RDF
directly**. Anything touching the session is `'use client'`; typed error classes (`instanceof`, not
string-match). **No `@inrupt/*`.**

**Decoupling for "its own repo":** the app only speaks **standard Solid protocols** (Solid-OIDC,
LDP, WAC/ACP, Type Index, Notifications) — zero dependency on prod-solid-server internals — so it
runs against **any** spec-compliant server (CSS, ESS, prod-solid-server). It already lives in its own
directory with its own `AGENTS.md`; promoting to a separate Git repo is a `git init` + first push.

**Testing (test-first):** Vitest for `src/lib/` contracts (inject optional `fetch`); Playwright
golden-path e2e against a local **CSS** (the `solid-test-infrastructure` harness — fresh account per
write test). CI: `typecheck · lint · unit · build` (+ axe-core). No Inrupt, no UI snapshot tests.

## 10. Functional scope (mirroring the Tim Theys demo)
- **View/add/organise pod data** by category (Home + My data + item detail + add/connect). ✓ demo "Pod Browser/Manager"
- **Permission manager**: per-app + per-category, grant + **one-click revoke**. ✓ demo "manage permissions"
- **Login** via Solid-OIDC (WebID/issuer entry), works against any server. ✓
- **Live updates** via Notifications. ✓ demo's reactive overview
- Deferred to later phases: the **browser-extension** "keys" mediator, an app **catalog/marketplace**,
  cross-source data import connectors (these are separate products in the demo).

## 11. Phasing (proposed)
- **P1 — shell + login + Home + My data (read)**: auth, Type-Index-driven category browse, item
  detail (content-type viewers), Home dashboard, full design system + a11y. *Read-first, lowest risk.*
- **P2 — Connected apps (permission manager)**: ACL read model → per-app list + detail + **revoke**;
  the consent/grant screen.
- **P3 — Add/connect data + write paths + Activity log**; live Notifications.
- **P4 — polish, onboarding, empty states, broaden server matrix (CSS/ESS/prod-solid-server)**.

## 12. Pitfalls to avoid (from research)
Consent walls; asymmetric Accept/Reject; bundled all-or-nothing consent; jargon; assuming the Solid
architecture earns trust on its own (R1); dense views that fail screen-reader/keyboard users (R8);
hand-built ACL triples (use typed accessors); depending on PodOS's non-existent share component (R2);
Inrupt libraries (AGENTS.md).

## 13. Open questions for the maintainer
1. **Common-tier categories** — confirm the short common tier (proposed: Identity, Contacts, Health,
   Finance, Calendar, Media) vs the long tail (Work/education, Mobility, Documents, …). Research flags
   this should ideally be validated with non-technical users.
2. **App name/logo source** — the "Connected apps" list needs human-readable app identity. Use the
   app's **Client Identifier Document** (`client_name`/`logo_uri`) where present; fallback to the
   agent URL. Confirm we render remote logos (privacy/CSP consideration) or name-only.
3. **"Share once" / time-boxed grants** — v1 = ongoing grant + easy revoke (WAC). True one-time/
   expiring grants need ACP or an access-grant/UMA layer — defer to v2? (Affects the consent screen's
   graduated options.)
4. **Repo home & name** — proposed dir `solid-pod-manager` (working name); confirm the name and when
   to split into its own Git repo.
