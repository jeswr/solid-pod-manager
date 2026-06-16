// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Federation **registry** configuration + thin consumer for the Pod Manager's
 * read-only `/federations` discovery view (pss task #90).
 *
 * The whole feature is gated on ONE build-time env var,
 * `NEXT_PUBLIC_FEDERATION_REGISTRY` — the URL of a `fedreg:Registry` document
 * (a federation Catalogue/Registry served by a `@jeswr/federation-registry`
 * deployment). The flag + URL live in `federation-registry-config.ts` (a
 * lightweight, SDK-free module so the NAV can read the flag without pulling
 * `@jeswr/federation-client` into the primary bundle — this module, which DOES
 * import the SDK, is only loaded by the page/hook data path). When the var is
 * UNSET (the default) the view + its nav entry are hidden entirely; the feature
 * ships dark.
 *
 * FETCH SEAM — IMPORTANT (the same foreign-origin boundary as `webid-index.ts`
 * and `community-feeds.ts`): the registry is a THIRD-PARTY origin, NOT the
 * user's pod. PM's session provider PATCHES `globalThis.fetch` with the
 * reactive-auth wrapper (which, on a 401, re-issues with the user's Solid
 * DPoP/bearer credentials when a token provider matches the host). We must
 * NEVER risk attaching the user's pod credential to the registry origin, so we
 * pass the PRISTINE native `fetch` ({@link getNativeFetch} — snapshotted at boot
 * BEFORE the patch, see `native-fetch.ts`), guaranteeing these requests bypass
 * the Solid auth layer entirely. `credentials:"omit"` ALONE does NOT prevent the
 * patched wrapper's 401-upgrade/retry — only a pre-patch reference does. The
 * `@jeswr/federation-client` SDK additionally wraps every request in its OWN
 * SSRF guard (https-only, private/loopback/metadata blocked, redirects
 * re-validated, body/time capped) composed UNDER the fetch we hand it.
 *
 * SSR fallback: `getNativeFetch()` is `undefined` in a non-browser environment
 * (e.g. the static-export prerender), where there is no global patch; we then
 * omit `fetch` so the SDK uses its package default — harmless on the server.
 *
 * TRUST BOUNDARY (load-bearing): registry membership is DISPLAY-ONLY. NOTHING
 * here feeds the federation TASK trust model (`federation-tasks.ts`
 * `AuthorizedSources`): a registry-asserted member is not a friend/contact, and
 * the SDK verifies a membership is WELL-FORMED, not that its `assertedBy`
 * signature binds it to that authority. Surfacing a member must never change
 * `/assigned` behaviour. Signature-verified trust is a later
 * `@jeswr/federation-trust` phase.
 */
import {
  discoverFromRegistry,
  resolveStorageSpecVersion,
  type RegistryDiscovery,
  type ResolvedStorageSpec,
} from "@jeswr/federation-client";
import { getNativeFetch } from "./native-fetch.js";
import {
  FEDERATION_REGISTRY_URL,
  isFederationRegistryEnabled,
} from "./federation-registry-config.js";

// Re-export the flag + URL so existing consumers (the hook) keep their single
// import site; the canonical (SDK-free) definitions live in
// `federation-registry-config.ts`.
export { FEDERATION_REGISTRY_URL, isFederationRegistryEnabled };

/**
 * Build the `@jeswr/federation-client` options that pin the foreign-origin fetch
 * boundary: the pristine native fetch (never the auth-patched global) + the
 * SDK's SSRF guard timeout. When the native snapshot is absent (SSR/prerender)
 * we OMIT `fetch` so the SDK falls back to its package default (no global patch
 * exists there to leak the credential).
 *
 * `allowUnresolvedHosts: true` — REQUIRED in a browser. The SDK's SSRF guard does
 * DNS-pinning to refuse a host that resolves to a private/loopback address; that
 * resolution uses `node:dns`, which only exists on Node. In a browser the guard
 * has no DNS and would otherwise FAIL CLOSED on every hostname registry URL,
 * making the feature non-functional. The browser is NOT defenceless without the
 * guard's pinning: a public-origin page cannot reach private addresses (the
 * browser sandbox + Private Network Access + the registry origin's CORS mediate
 * the request), and the guard still enforces https-only + the redirect/body/time
 * caps. The deploy-time `NEXT_PUBLIC_FEDERATION_REGISTRY` is operator-configured,
 * not user-supplied, so it is trusted to be a real public registry. (Tracked
 * upstream follow-up: a first-class browser-safe DNS-less mode in the SDK.)
 */
function registryOptions() {
  const fetchImpl = getNativeFetch();
  return {
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    guard: { timeoutMs: 8000, allowUnresolvedHosts: true },
  };
}

/**
 * Discover the registry-asserted memberships from the configured registry.
 *
 * Returns the SDK's {@link RegistryDiscovery} verbatim — `members` plus the
 * DOCUMENT-level `valid`/`issues` (so a fetch-refused / 404'd / not-a-registry
 * document is observable, NOT a silently-empty list). Each member carries the
 * registry's lifecycle `status`, the `assertedBy` authority (on
 * `membership.assertedBy`), and a per-member `valid`/`issues`.
 *
 * Uses the pristine native fetch (foreign origin — see file header). The caller
 * must NOT feed any member into the task trust model (display-only).
 */
export function discoverFederationMembers(): Promise<RegistryDiscovery> {
  return discoverFromRegistry(FEDERATION_REGISTRY_URL, registryOptions());
}

/**
 * Resolve a storage's advertised client-client spec-version acceptance
 * (`fedreg:acceptsSpec`) — the schema-migration-coordination query. P0.5 /
 * optional in the view: a member's `id` is an app `client_id`, NOT a storage
 * URL, so this is only meaningful where a real storage URL is in hand. Fails
 * CLOSED unless the storage description verified clean (the SDK's contract).
 *
 * @param storageUrl - URL of a `fedreg:StorageDescription` document (a storage
 *   root). Fetched through the SDK's SSRF guard with the native fetch.
 */
export function resolveMemberStorageSpec(
  storageUrl: string,
): Promise<ResolvedStorageSpec> {
  return resolveStorageSpecVersion(storageUrl, registryOptions());
}

// Re-export the SDK result types the hook + page type their state with, so the
// rest of PM imports them from this single config site.
export type {
  DiscoveredMember,
  RegistryDiscovery,
  ResolvedStorageSpec,
} from "@jeswr/federation-client";
