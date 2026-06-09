# HANDOVER → Fable

> Written 2026-06-10 by the previous agent (Claude) on session pause. You (Fable) are picking this up
> cold. This doc is self-contained — read it top to bottom, then `docs/DESIGN.md`. Absolute paths used
> throughout; everything is on this machine.

## TL;DR — what you're doing
Build **the Pod Manager** — a consumer-facing Solid web app where a non-technical person views/adds/
organises the personal data in their **Solid Pod** and controls which apps can access which categories
(a permission/consent manager). It mirrors the Tim Theys / Open Data Institute "Solid Pod" demo. It's a
**standalone Solid client** (standard protocols only) that will become its own Git repo.

**The maintainer's goal (ambitious):** take it to launch-ready, "billions of users" production quality,
**signed off by a product-manager agent**, including **working integrations for the 30 most popular
consumer apps** (social + productivity) and a **full productivity suite** (document editing, calendar,
contacts, notes). "Not done until no missing features, no bugs, no security holes, PM happy." The
maintainer wants you **autonomous, avoiding blockers** (mock/stub rather than wait).

**Honest scope (already agreed with the maintainer — keep being honest, don't fake these):**
1. **Live** third-party integrations use **end-user OAuth** where possible, but many need a registered
   dev app + **platform API keys / app-review** only the maintainer can obtain (Meta, Google sensitive
   scopes, TikTok, Uber, Plaid…). Build adapters + framework + **mocks/contract tests now**; each flips
   **live per-app** when credentials arrive. See `docs/integrations-catalog.md` for the per-app tiers.
2. "Billions of users" launch also needs infra/scale/legal/ops beyond code → hit a high engineering bar
   and **document the gaps**, don't claim them closed.
3. "Zero bugs / PM-perfect" is unbounded → run a **PM-agent + security review loop**, iterate to a high
   bar, report **done-vs-open** honestly. Never declare "perfect/complete" untruthfully.

## Where everything is
- **App repo:** `/Users/jesght/Documents/GitHub/jeswr/solid-pod-manager/` (its own `git init`'d repo,
  NOT inside prod-solid-server). Has its own **`AGENTS.md`** = the `solid-ai-coding` guide (READ IT —
  it's the stack + rules contract; `CLAUDE.md` imports it).
- **Plan & research:** `docs/DESIGN.md` (the interface plan — your spec), `docs/research/` (cited UX
  research behind it), `docs/integrations-catalog.md` (the 30 apps, tiered), `docs/productivity-suite.md`
  (calendar/contacts/docs/notes spec).
- **The reference UX** (watch if useful): Tim Theys "Solid Pod Demos" (ODI) — YouTube playlist
  `PLMJ0GuByOsWoc-HHO0qu0ztUcTv-DGpYc`; Figma `bit.ly/solid_data_flows` + `bit.ly/solid_applications`.
- A clone of the skill repo is at `/tmp/solid-ai-coding` (source for `AGENTS.md` if it gets clobbered).

## Stack & rules (from `AGENTS.md` — non-negotiable)
- **Next.js (App Router) + TypeScript + Tailwind + shadcn/ui (Radix)** + Lucide + react-hook-form/zod +
  sonner. Node ≥ 24. Vercel-deploy-shaped.
- **Solid libs:** `@solid/reactive-authentication` (auth, `<authorization-code-flow>`, patches global
  fetch), `@solid/object` + `@rdfjs/wrapper` + `n3` (typed pod data), `@jeswr/fetch-rdf` (RDF fetch).
  **NEVER use `@inrupt/*`** — the guide explicitly rejects it.
- **Layering:** `src/lib/` is the ONLY code that touches RDF (typed, TSDoc'd, typed error classes —
  branch on `instanceof`, never string-match). `app/` + `src/components/` is UI and never touches RDF.
  Anything touching the Solid session is `'use client'`.
- **Discovery = Type Index** (`solid-type-index` skill). **Permissions = WAC/ACP** via typed accessors
  (`solid-wac` house rule — NEVER hand-build triples). **Live updates = Solid Notifications**
  (`solid-notifications` skill).
- **Test-first:** Vitest for `src/lib/` (inject an OPTIONAL `fetch`, omit in prod paths); Playwright
  golden-path e2e against a local Community Solid Server (the `solid-test-infrastructure` skill ships the
  harness). WCAG 2.2 AA, responsive (375/768/1280), loading/empty/error on every async surface.
- **Skills are installed** at `~/.claude/skills/` (all 10 `solid-ai-coding` + the design/test set:
  `solid-reactive-authentication`, `solid-object`, `solid-type-index`, `solid-client-id`,
  `solid-notifications`, `solid-wac`, `solid-test-infrastructure`, `web-design-guidelines`,
  `emil-design-eng`, `web-typography`, `color-mode-and-theme`, `accessible-html-links`, `semantic-html`,
  `responsive-design`, `vitest`, `playwright-best-practices`, `test-driven-development`, `node`,
  `typescript-advanced-types`). USE them.

## Current state of P1 (just paused mid-finish)
**3 commits landed** (`git log`):
1. `a1e4fdf chore: scaffold Next.js + shadcn + Solid stack + test harness`
2. `26e78a1 feat(lib): data layer — taxonomy, type-index discovery, profile, viewers`
3. `4757c07 feat(ui): app shell, login, Home dashboard, My data browse + viewers`

**Built so far:**
- `src/lib/`: `categories`, `type-index`, `profile`, `profile-agent`, `pod-data`, `viewers`,
  `resource-view`, `login-ux`, `webid-token-provider`, `format`, `errors`, `utils` (each with a
  `.test.ts`).
- `src/app/`: `layout`, `page` (Home), `my-data` (+ `[category]` + `item`), `connected-apps` (stub),
  `activity` (stub), `settings`. App shell + nav + login + Home dashboard + My-data browse with
  content-type viewers.
- Scaffold: shadcn, Tailwind, vitest + Playwright harness, `.github/` CI workflow, `scripts/dev.mjs`.
- Scripts: `dev`, `build`, `start` (port 3200), `lint`, `typecheck`, `test`, `test:e2e`.

**⚠️ What's NOT finished (the WIP that was committed as a `wip:` commit on pause):**
- The **Playwright golden-path e2e was flaky** — it timed out on Next.js **cold-compile** (first `/`
  request can take >20s under `next dev`, exceeding the step). The agent was adding a warmup/raising the
  first-navigation timeout and fixing a Playwright strict-mode locator when paused. **First task: get the
  golden-path e2e reliably green** (warm up the dev server / bump the first navigation timeout; the
  `solid-test-infrastructure` skill has the canonical two-webServer config).
- Verify `tsc --noEmit`, `eslint .`, `vitest run`, `next build` are ALL green before calling P1 done.
- `e2e/golden-path.verify.spec.ts` + `playwright.verify.config.ts` were a scratch verify harness — fold
  the useful warmup into the real `e2e/golden-path.spec.ts` + `playwright.config.ts` and delete the scratch.

## The phase plan (do these next, in this shape)
`docs/DESIGN.md §11` is the source of truth. Phases:
- **P1** (almost done) — shell + login + Home + My-data **read**. Finish the e2e + gates.
- **P2** — **Connected apps / permission manager**: read model over the pod's **WAC/ACP** ACLs → per-app
  list + per-app detail (categories, last access, **one-click revoke**) + the **GDPR-valid, dark-pattern-
  free consent/grant screen** (equal-weight Accept/Decline, per-category, plain-language + a benefit
  rationale, NO consent wall). Details in `DESIGN.md §4–6, §9`.
- **P3** — add/connect data + **write paths** (create/edit/delete via `@solid/object`) + Activity log +
  live **Notifications**.
- **P4** — onboarding, empty states, polish, broaden the server matrix (CSS/ESS/prod-solid-server).
- **Integrations** — framework + 30 adapters per `docs/integrations-catalog.md` (common adapter shape;
  end-user OAuth; mocks/contract tests; live per-app when creds exist).
- **Productivity suite** — per `docs/productivity-suite.md` (calendar, contacts, documents editor,
  notes/tasks, files; standard vocabularies; interop-first).
- **PM-agent + security gate (recurring)** — after each increment, spawn (a) an adversarial
  **Product-Manager** reviewer that grades against `DESIGN.md` + the product bar, and (b) a **security**
  review (auth/token handling, XSS/CSRF, ACL correctness, SSRF, deps). Iterate until both pass. The
  maintainer wants **PM sign-off** as the completion signal.

**Suggested parallelism:** P1 is the critical path (everything imports `src/lib/` + the shell). After P1
is green, P2 / integrations-framework / productivity can run in parallel (different surfaces), each
gated by the PM + security reviewers. The previous agent drove phases via background sub-agents (worktree
isolation NOT needed here — this is a single non-prod-solid-server repo; just be careful about parallel
writes to the same files).

## Operating constraints (maintainer's stated preferences)
- **Autonomous; avoid blockers.** Decide reasonably yourself; mock/stub rather than wait.
- **Integrations:** prefer **end-user OAuth** (the user authorizes the app to their own accounts); where
  a platform needs a registered client_id/secret or API key, build + mock and **flag it** (don't fake
  "live"). The maintainer will supply credentials per-app over time.
- **Accepted design decisions:** common data-category tier = Identity/Contacts/Health/Finance/Calendar/
  Media (tail: Work/education, Mobility, Documents…); v1 grants = **ongoing + easy revoke (WAC)**,
  "share-once"/time-boxed = v2 (needs ACP/access-grants); app identity from the **Client Identifier
  Document** (name + homepage; logos TBD); dir/working-name `solid-pod-manager`.
- **Be honest in every report**: done-vs-open, what's mocked, what needs credentials/ops. Never overstate.

## Context: the parent project (prod-solid-server) — separate, mostly paused
This app grew out of work on **prod-solid-server** at `/Users/jesght/Documents/GitHub/jeswr/prod-solid-
server` (a from-scratch production Solid server). That repo is the SERVER; this app is a CLIENT and must
NOT depend on it (standard protocols only). Relevant in-flight server state you may need:
- **PR #106 (DRAFT) — `feat/passkey-unified-registration`**: standard passkey unified self-registration
  (themed Keycloak WebAuthn + auto WebID/storage). **Awaiting the maintainer's review + a hands-on
  passkey test in a browser.** Don't merge without them. This is the server-side "create a Pod" flow that
  pairs with this app's "Pod Manager home" destination.
- **PR #99 (open)** — the registration + data-import design doc. **PRs #95/#96** — docs. Several
  dependabot bumps + older spike drafts (#74/#76/#50/#38/#21) — not your concern.
- **Local dev stack is RUNNING** (broker topology) for manual testing:
  - RS `https://localhost:3000` (host process pid ~42885, self-signed TLS — use `127.0.0.1`, accept the
    cert), broker `http://localhost:3001` (host process pid ~44188), import app `http://localhost:3301`
    (pid ~43574), Keycloak `http://localhost:8080/realms/solid`, MinIO/QLever containers (up ~11h).
  - Test account: **`alice` / `alice`**, WebID `https://localhost:3000/alice/profile/card#me`,
    issuer `http://localhost:3001`. The `interop/TEST-ACCOUNT-GUIDE.md` in that repo documents the stack.
  - This app can log into alice's pod against `http://localhost:3001` for real end-to-end testing
    (besides the local CSS the test harness spins up).
- **Memory files** at `~/.claude/projects/-Users-jesght-Documents-GitHub-jeswr-prod-solid-server/memory/`
  (auto-loaded via `MEMORY.md`) capture deeper history: `pod-manager-app-build.md` (this app),
  `registration-vision-passkey.md` (the server registration redirect), `user-facing-pages-build.md`,
  `dpop-ath-app-compat.md`, deployment notes. Read `pod-manager-app-build.md` first.

## Your immediate next steps (ordered)
1. `cd /Users/jesght/Documents/GitHub/jeswr/solid-pod-manager`; read `AGENTS.md` + `docs/DESIGN.md`.
2. **Finish P1:** make the golden-path e2e reliably green (warm up cold-compile / bump first-nav timeout;
   use the `solid-test-infrastructure` skill's config), then confirm `typecheck` + `lint` + `vitest run`
   + `next build` + `test:e2e` ALL green. Clean up the scratch verify harness. Commit.
3. **PM + security gate on P1** (spawn the two reviewers), fix findings.
4. **Fan out P2 + integrations-framework + productivity** per the plan, each gated.
5. Report milestones to the maintainer honestly (done-vs-open, mocked, credential-blocked).

Good luck. The hard thinking (research, plan, stack, scope honesty) is done — it's in `docs/`. Build well.
