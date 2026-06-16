// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Federation-registry FEATURE FLAG — the env-only gate, with NO heavy imports.
 *
 * Deliberately split from `federation-registry.ts` (the SDK consumer) so the
 * nav can read the flag WITHOUT pulling `@jeswr/federation-client` (and its
 * Node-builtin shims) into the primary app/nav bundle. The SDK must only be in
 * the page/hook DATA path, so the integration truly ships dark — zero footprint
 * for every user when `NEXT_PUBLIC_FEDERATION_REGISTRY` is unset (roborev
 * finding, Medium).
 *
 * The env read is a DIRECT `process.env.NEXT_PUBLIC_FEDERATION_REGISTRY` property
 * access (NOT a computed key) so Next inlines it at build into the static export.
 * The value is TRIMMED once here, so whitespace-only is treated as unset
 * everywhere — the flag, the cache key, and the fetch all agree, and the nav can
 * never show an entry that never fetches (roborev finding, Low).
 */

/**
 * The configured registry URL, TRIMMED, or `""` when unset/blank. Spelled as a
 * direct env property read so Next inlines it at build.
 */
export const FEDERATION_REGISTRY_URL = (
  process.env.NEXT_PUBLIC_FEDERATION_REGISTRY ?? ""
).trim();

/** True when a federation registry is configured (the view + nav are available). */
export const isFederationRegistryEnabled = FEDERATION_REGISTRY_URL !== "";
