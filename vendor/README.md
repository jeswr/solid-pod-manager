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

---

# Vendored `@jeswr/solid-webauthn-client` (+ `-protocol`) — passkey re-auth (A5)

The redirect-free WebAuthn (passkey) re-auth client for Solid-OIDC, wired into the
login UX (`src/lib/webauthn-reauth.ts`, `src/lib/webauthn-register.ts`). Vendored as
tarballs for the same reason as the reactive-auth fork above: the maintainer's policy
is to vendor unpublished `@jeswr/*`/`@solid/*` packages rather than depend on a
registry release that does not yet exist.

## What is vendored and why

| Tarball | Source | Notes |
|----|----|----|
| `jeswr-solid-webauthn-protocol-0.0.0-a5-848ab65.tgz` | `npm pack` of `@jeswr/solid-webauthn-protocol` from `~/Documents/GitHub/jeswr/solid-webauthn` @ `848ab65` (branch `feat/webauthn-client-a5`) | shared wire contract (bundle codec, the `urn:solid:token-type:webauthn-assertion` URN, registration/assertion types) — the single source of truth shared with the broker. |
| `jeswr-solid-webauthn-client-0.0.0-a5-848ab65.tgz` | `npm pack` of `@jeswr/solid-webauthn-client` from the same workspace/commit | `WebAuthnTokenProvider` (a `TokenProvider` for the reactive-auth pipeline), `WebAuthnTokenExchange`, `dpopBoundRequest`. Its `@jeswr/solid-webauthn-protocol` dependency was repointed from `"*"` to `file:jeswr-solid-webauthn-protocol-0.0.0-a5-848ab65.tgz` so npm resolves it from this `vendor/` dir with no registry. Its other deps (`@simplewebauthn/browser`, `oauth4webapi`) resolve from the registry. |

Wiring (post-#123): the client is NO LONGER registered in a `ReactiveFetchManager([...])`
array — the #123 proactive-auth-fetch rewrite installs a SINGLE token provider into
`installProactiveAuthFetch`. The `WebAuthnTokenProvider` is instead COMPOSED with the
interactive `WebIdDPoPTokenProvider` (`src/lib/passkey-provider.ts`): the composed
provider routes `upgrade()` through the WebID-bound passkey provider when its
`matches(request)` is true, falling back to the interactive provider on a wrong-account
or failed ceremony. See `docs/passkey-webauthn-port-design.md` §5 in prod-solid-server
for the locked design and the no-auto-provision contract.

## Removal checklist (when the `@jeswr/*` packages are published)

1. `package.json`: replace the three `file:vendor/jeswr-solid-webauthn-*` deps with the
   published versions from the registry; `npm install`.
2. Delete the two `jeswr-solid-webauthn-*-a5-848ab65.tgz` tarballs.
3. Re-pack reproducibly: `npm pack --workspace=@jeswr/solid-webauthn-protocol` and
   `--workspace=@jeswr/solid-webauthn-client` from the solid-webauthn workspace, then
   repoint the client tarball's protocol dep to the vendored protocol path (the client's
   published `package.json` keeps `"*"`).
4. `npm run lint && npm run typecheck && npm run test && npm run build` must stay green.

E2E against a DEPLOYED broker with `/​.oidc/webauthn/*` endpoints is out of scope until
the broker is deployed (the broker server-side landed on prod-solid-server but is not yet
deployed); the assertion→token-exchange round-trip can only be exercised live there.
