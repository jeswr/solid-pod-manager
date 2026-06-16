// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * WebID-index configuration + client factory for the Pod Manager.
 *
 * The whole people-search-against-the-index feature is gated on ONE build-time
 * env var, `NEXT_PUBLIC_WEBID_INDEX` — the origin of a `solid-webid-index`
 * deployment (e.g. `https://webid-index.solid-test.jeswr.org`). `NEXT_PUBLIC_*`
 * vars are inlined by Next at build, so this resolves to a static string in the
 * static export; the env read is a direct `process.env.NEXT_PUBLIC_WEBID_INDEX`
 * property access (not a computed key) so Next's static replacement can see it.
 *
 * When the var is UNSET (the default), {@link webIdIndexClient} is `null` and
 * {@link isWebIdIndexEnabled} is `false`, so the search UI is hidden entirely —
 * no nav, no panel. Configure it ONLY when an index is deployed.
 *
 * The client talks ONLY to the configured index origin, with credentials
 * omitted, so the user's DPoP auth is never leaked to the third-party index
 * (see `webid-index-client.ts`). We pass the bare global `fetch` deliberately —
 * NOT the auth-patched session fetch.
 */
import {
  createIndexClient,
  type IndexClient,
} from "./webid-index-client.js";

/**
 * The configured index origin, or `""` when unset. Spelled as a direct
 * `process.env.NEXT_PUBLIC_WEBID_INDEX` read so Next inlines it at build.
 */
export const WEBID_INDEX_ORIGIN = process.env.NEXT_PUBLIC_WEBID_INDEX ?? "";

/**
 * The shared WebID-index client, or `null` when no origin is configured.
 *
 * `null` is the inert state — the consuming UI must treat it as "feature off".
 * We deliberately pass NO `fetch` (the bare global runs): index reads are public
 * and the suggest POST is unauthenticated cross-origin, so the user's
 * DPoP-patched fetch must NOT be attached to the index origin.
 */
export const webIdIndexClient: IndexClient | null = createIndexClient({
  origin: WEBID_INDEX_ORIGIN,
});

/** True when a WebID index is configured (the search feature is available). */
export const isWebIdIndexEnabled = webIdIndexClient !== null;
