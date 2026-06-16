// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * React hook over the federation-registry consumer (`@/lib/federation-registry`):
 *
 *   - {@link useFederationMembers} — discover the registry-asserted memberships
 *     from the configured registry, with stale-while-revalidate caching via the
 *     shared {@link useSwrRead} cache (keyed
 *     `federation-members:<encoded registry URL>`), so returning to the
 *     `/federations` page paints the last result INSTANTLY and revalidates in
 *     the background (the instant-nav SWR pattern).
 *
 * GATED on `NEXT_PUBLIC_FEDERATION_REGISTRY`: when no registry URL is configured
 * the hook short-circuits to an inert, settled empty state (`enabled:false`, no
 * fetch, `loading:false`) — the page + nav entry hide the feature entirely
 * (mirrors `use-webid-search.ts`).
 *
 * NO `topicUrl`: the registry is a THIRD-PARTY document, NOT a Solid resource we
 * can watch via WebSocketChannel2023 — so there is nothing to subscribe to for
 * live invalidation; the page's Refresh action drives revalidation.
 *
 * SECURITY/PRIVACY: the fetcher talks ONLY to the configured registry origin via
 * the pristine native fetch + the SDK's SSRF guard (see
 * `@/lib/federation-registry`). The user's DPoP auth is never attached to it.
 * Registry membership is DISPLAY-ONLY — nothing here is fed into the task trust
 * model (`federation-tasks.ts`).
 */
import { useCallback } from "react";
import { useSwrRead, type SwrReadState } from "@/components/use-swr-read";
import {
  discoverFederationMembers,
  FEDERATION_REGISTRY_URL,
  isFederationRegistryEnabled,
  type RegistryDiscovery,
} from "@/lib/federation-registry";

/** The state returned by {@link useFederationMembers}. */
export interface FederationMembersState extends SwrReadState<RegistryDiscovery> {
  /** False when no registry is configured (`NEXT_PUBLIC_FEDERATION_REGISTRY` unset). */
  enabled: boolean;
}

/**
 * The SWR cache key for the federation-members read. Pure + exported so the
 * "feature off ⇒ empty key ⇒ NO fetch" gating is unit-testable without a React
 * render (mirrors `use-webid-search.ts`'s `searchKey`). An empty string means
 * "do nothing" per the `useSwrRead` contract.
 *
 * The registry URL is part of the key (URL-encoded) so a deploy that re-points
 * the registry never serves the previous registry's cached members; encoding
 * keeps any URL with reserved characters from colliding with another slot.
 */
export function federationMembersKey(registryUrl: string, enabled: boolean): string {
  const url = registryUrl.trim();
  if (!enabled || !url) return "";
  return `federation-members:${encodeURIComponent(url)}`;
}

/**
 * Discover the registry-asserted memberships from the configured registry.
 *
 * Returns the SDK's {@link RegistryDiscovery} (members + DOCUMENT-level
 * `valid`/`issues`) under SWR. When the feature is disabled (no registry URL)
 * this does NO work and returns `data: undefined`, `loading:false`,
 * `enabled:false`.
 */
export function useFederationMembers(): FederationMembersState {
  const key = federationMembersKey(FEDERATION_REGISTRY_URL, isFederationRegistryEnabled);

  const fetcher = useCallback(async (): Promise<RegistryDiscovery> => {
    // Defensive: with an empty key useSwrRead never calls the fetcher, but a
    // guard here keeps the disabled state inert even if mis-wired.
    if (!isFederationRegistryEnabled) {
      return { members: [], valid: true, issues: [] };
    }
    return discoverFederationMembers();
  }, []);

  // NO topicUrl — the registry is not a Solid resource to watch.
  const state = useSwrRead<RegistryDiscovery>(key, fetcher);

  // An empty key (feature off) is the INERT state: useSwrRead reports
  // `loading:true` for an empty key (its "session/key not ready yet" default —
  // see deriveSwrInitialState), but a disabled feature is a RESOLVED "nothing to
  // load" state, not a pending one. Normalise to `loading:false` so the page
  // never flashes skeletons when the feature is off (mirrors use-webid-search).
  if (key === "") {
    return {
      data: undefined,
      error: undefined,
      loading: false,
      revalidating: false,
      reload: state.reload,
      enabled: isFederationRegistryEnabled,
    };
  }
  return { ...state, enabled: isFederationRegistryEnabled };
}
