# Vendored `@solid/reactive-authentication` — TEMPORARY, remove on upstream release

The app does **not** wait on upstream: all refresh-token / login-flow functionality is
fully working here today via this vendored tarball plus local mirror code. This file is
the removal manifest for when upstream catches up.

## What is vendored and why

`solid-reactive-authentication-0.1.3-pr11-14.tgz` is an `npm pack` of the library's
`integration/podmanager-override` branch (local clone:
`~/Documents/GitHub/solid-contrib-reactive-authentication`), which merges these open
upstream PRs on top of the published 0.1.3:

| PR | What it adds |
|----|--------------|
| [#11](https://github.com/solid-contrib/reactive-authentication/pull/11) | per-issuer session cache (no re-prompt per request) |
| [#12](https://github.com/solid-contrib/reactive-authentication/pull/12) | refresh tokens (incl. `prompt=consent` for OIDC Core §11 strict servers) |
| [#13](https://github.com/solid-contrib/reactive-authentication/pull/13) | popup reuse for the interactive retry (kills the second popup / "Open new window" dialog) |
| [#14](https://github.com/solid-contrib/reactive-authentication/pull/14) | `TokenProvider.invalidate` + 401-once session renewal (incl. the discarded-401 body-cancel fix) |

The app additionally mirrors the provider logic (with app-specific extensions:
`login(issuer)`, WebID-claim surfacing, `AmbiguousIssuerError`) in
`src/lib/webid-token-provider.ts` — see the `MIRRORS upstream reactive-authentication
PR #…` comment blocks there.

## Removal checklist (when upstream merges #11–#14 and cuts a release)

1. `package.json`: replace
   `"@solid/reactive-authentication": "file:vendor/solid-reactive-authentication-0.1.3-pr11-14.tgz"`
   with the released version from the registry; `npm install`.
2. Delete this `vendor/` directory.
3. In `src/lib/webid-token-provider.ts`, revisit the two `MIRRORS upstream …` blocks:
   delete what the released `DPoPTokenProvider` now provides and keep only the
   app-specific extensions (issuer-direct `login()`, WebID-claim reading, ambiguous-issuer
   surfacing) — ideally by extending/composing the released class and passing a
   `GetIssuerCallback` if the release exposes one.
4. `npm run test && npm run lint && npm run typecheck && npm run build:prod && npm run test:e2e`
   must all stay green; the live specs under `e2e-live/` re-verify refresh tokens against
   the deployed broker.

Until then: any upstream-worthy fix made here must ALSO be pushed to the matching
upstream PR branch and this tarball re-packed from the integration branch (that is how
this tarball was produced; its provenance is reproducible with `npm pack` on that branch).
