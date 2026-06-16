"use client";

/**
 * React bridge for the permissions read model (DESIGN.md §3 "Connected apps").
 * The UI never touches RDF: it renders {@link ConnectedApp} shapes and calls
 * the typed backend for mutations. Production paths pass NO `fetch` — the
 * auth-patched global runs (AGENTS.md §Reading data).
 */
import { useCallback } from "react";
import { freshRdf } from "@/lib/rdf-read";
import { useSession } from "@/components/session-provider";
import { useSwrRead } from "@/components/use-swr-read";
import type { AsyncState } from "@/components/use-pod-data";
import { discoverRegistrations } from "@/lib/type-index";
import { summariseCategories } from "@/lib/pod-data";
import {
  WacPermissionsBackend,
  fetchAppIdentity,
  grantsForAgent,
  grantsForCategory,
  type AccessGrant,
  type AppAccess,
  type PermissionsContext,
} from "@/lib/permissions";

/**
 * The single backend instance the UI mutates through (WAC today; the
 * {@link PermissionsBackend} seam admits an ACP implementation later).
 */
export const permissionsBackend = new WacPermissionsBackend();

/** An app with access, enriched with its human-readable identity. */
export interface ConnectedApp extends AppAccess {
  /** `client_name` → profile name → URL host. Never a raw IRI when avoidable. */
  name: string;
  homepage?: string;
}

/** The full Connected-apps read model: the displayed apps plus the context. */
export interface ConnectedAppsModel {
  apps: ConnectedApp[];
  ctx: PermissionsContext;
}

export interface ConnectedAppsState extends AsyncState<ConnectedApp[]> {
  /** The context mutations need (set once the read model has loaded). */
  ctx?: PermissionsContext;
  /** True while a background revalidation is refreshing a shown (cached) value. */
  revalidating: boolean;
  reload: () => void;
  /**
   * Read the Connected-apps model FRESH (uncached), bypassing the SWR cache.
   * Mutations (grant/revoke) MUST source their `ctx`/`grants` from here, never
   * from the cached `data`/`ctx` above, so a revoke never acts on a stale ACL
   * snapshot. The ACL *write* is independently authoritative (the backend
   * re-reads each `.acl` with `freshRdf` under `If-Match`); this guarantees the
   * SET of grants we ask it to act on is current too.
   */
  getFreshModel: () => Promise<ConnectedAppsModel>;
}

/**
 * The uncached discovery chain (profile → type index → ACLs → identities).
 *
 * Exported so the PROACTIVE PREFETCH orchestrator ({@link file://../lib/prefetch.ts})
 * can warm the `connected-apps` cache from the EXACT SAME fetcher this hook uses
 * — single source of truth, no duplicated fetch logic.
 */
export async function loadConnectedApps(
  webId: string,
  activeStorage: string,
): Promise<ConnectedAppsModel> {
  const { dataset } = await freshRdf(webId);
  const { locations } = await discoverRegistrations(webId, dataset);
  const ctx: PermissionsContext = {
    ownerWebId: webId,
    podRoot: activeStorage,
    summaries: summariseCategories(locations),
  };
  const access = await permissionsBackend.listApps(ctx);
  const identities = await Promise.all(
    access.map((app) => fetchAppIdentity(app.agentId)),
  );
  const apps: ConnectedApp[] = access
    .map((app, i) => ({
      ...app,
      name: identities[i].name,
      homepage: identities[i].homepage,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { apps, ctx };
}

/**
 * Discover the full Connected-apps read model: profile → type index →
 * category scopes → ACL documents → per-app access + identity.
 *
 * Stale-while-revalidate: on re-mount the last-known apps render INSTANTLY (no
 * blank spinner returning to Home) while a background revalidation refreshes
 * them; the pod-root notification subscription invalidates the cache when a
 * grant/revoke happens anywhere. The cache is for RENDER only — see
 * {@link ConnectedAppsState.getFreshModel} for the mutation path.
 */
export function useConnectedApps(): ConnectedAppsState {
  const { webId, activeStorage } = useSession();

  const { data, error, loading, revalidating, reload } = useSwrRead<ConnectedAppsModel>(
    "connected-apps",
    // The SWR layer only calls this when logged-in with a webId; activeStorage
    // is required to build ctx — guard so a missing storage can't crash.
    async (id) => {
      if (!activeStorage) throw new Error("No active storage selected yet.");
      return loadConnectedApps(id, activeStorage);
    },
    // Watch the pod root so a grant/revoke made elsewhere invalidates + refreshes.
    { topicUrl: activeStorage },
  );

  const getFreshModel = useCallback(async () => {
    if (!webId || !activeStorage) {
      throw new Error("Not signed in, or no active storage selected.");
    }
    return loadConnectedApps(webId, activeStorage);
  }, [webId, activeStorage]);

  return {
    data: data?.apps,
    ctx: data?.ctx,
    error,
    loading,
    revalidating,
    reload,
    getFreshModel,
  };
}

/** One connected app, looked up by its agent IRI (route param, decoded). */
export function useConnectedApp(agentId: string): ConnectedAppsState & {
  app?: ConnectedApp;
} {
  const all = useConnectedApps();
  return { ...all, app: all.data?.find((a) => a.agentId === agentId) };
}

/**
 * The FRESH grants for one agent across the whole pod — re-discovered live,
 * not read from the SWR cache. Use this to source a "revoke all" mutation so it
 * acts on the agent's current grant set, never a stale cached snapshot. Returns
 * `[]` when the agent has no current access (already revoked elsewhere).
 */
export function freshGrantsForAgent(
  model: ConnectedAppsModel,
  agentId: string,
): AccessGrant[] {
  return grantsForAgent(model.apps, agentId);
}

/**
 * The FRESH grants for one agent within a single category — re-discovered live.
 * Use this to source a per-category revoke. Returns `[]` when that category is
 * no longer granted (already revoked elsewhere) — `revokeGrants([])` is a no-op.
 */
export function freshGrantsForCategory(
  model: ConnectedAppsModel,
  agentId: string,
  categoryId: string,
): AccessGrant[] {
  return grantsForCategory(model.apps, agentId, categoryId);
}
