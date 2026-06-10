"use client";

/**
 * React bridge for the permissions read model (DESIGN.md §3 "Connected apps").
 * The UI never touches RDF: it renders {@link ConnectedApp} shapes and calls
 * the typed backend for mutations. Production paths pass NO `fetch` — the
 * auth-patched global runs (AGENTS.md §Reading data).
 */
import { useCallback, useEffect, useState } from "react";
import { fetchRdf } from "@jeswr/fetch-rdf";
import { useSession } from "@/components/session-provider";
import type { AsyncState } from "@/components/use-pod-data";
import { discoverRegistrations } from "@/lib/type-index";
import { summariseCategories } from "@/lib/pod-data";
import {
  WacPermissionsBackend,
  fetchAppIdentity,
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

export interface ConnectedAppsState extends AsyncState<ConnectedApp[]> {
  /** The context mutations need (set once the read model has loaded). */
  ctx?: PermissionsContext;
  reload: () => void;
}

/**
 * Discover the full Connected-apps read model: profile → type index →
 * category scopes → ACL documents → per-app access + identity.
 */
export function useConnectedApps(): ConnectedAppsState {
  const { webId, activeStorage, status } = useSession();
  const [state, setState] = useState<AsyncState<ConnectedApp[]> & { ctx?: PermissionsContext }>(
    { loading: true },
  );
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (status !== "logged-in" || !webId || !activeStorage) return;
    let cancelled = false;
    setState({ loading: true });

    (async () => {
      const { dataset } = await fetchRdf(webId);
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
      if (cancelled) return;
      const apps: ConnectedApp[] = access
        .map((app, i) => ({
          ...app,
          name: identities[i].name,
          homepage: identities[i].homepage,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      setState({ loading: false, data: apps, ctx });
    })().catch((e: unknown) => {
      if (!cancelled) {
        setState({ loading: false, error: e instanceof Error ? e : new Error(String(e)) });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [webId, activeStorage, status, nonce]);

  return { ...state, reload };
}

/** One connected app, looked up by its agent IRI (route param, decoded). */
export function useConnectedApp(agentId: string): ConnectedAppsState & {
  app?: ConnectedApp;
} {
  const all = useConnectedApps();
  return { ...all, app: all.data?.find((a) => a.agentId === agentId) };
}
