// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * React bridge for the per-resource Sharing panel (feature-completeness plan
 * Wave 3). The UI never touches RDF: it renders {@link ResourceAccess} entries
 * and calls the typed {@link ResourceSharingBackend} for mutations. Production
 * paths pass NO `fetch` — the auth-patched global runs (AGENTS.md §Reading data).
 *
 * The backend is rebuilt whenever the signed-in WebID changes (the self-lockout
 * guard is bound to it). Reads re-run when the resource URL changes or on an
 * explicit `reload()` after a successful mutation.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "@/components/session-provider";
import { NotAuthenticatedError } from "@/lib/errors";
import {
  WacResourceSharingBackend,
  type ResourceAccess,
} from "@/lib/resource-acl";

export interface ResourceSharingState {
  access?: ResourceAccess;
  loading: boolean;
  error?: Error;
  /** The signed-in user's WebID (the protected owner). */
  ownerWebId?: string;
  /** The backend the panel mutates through (undefined until logged in). */
  backend?: WacResourceSharingBackend;
  reload: () => void;
}

/**
 * Load the effective-access read model for one resource and expose the backend
 * for mutations. Re-reads after a mutation via `reload()`.
 */
export function useResourceSharing(resourceUrl: string): ResourceSharingState {
  const { webId, status } = useSession();
  const [state, setState] = useState<{
    access?: ResourceAccess;
    loading: boolean;
    error?: Error;
  }>({ loading: true });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // One backend per signed-in WebID — the self-lockout guard binds to it.
  const backend = useMemo(
    () => (webId ? new WacResourceSharingBackend(webId) : undefined),
    [webId],
  );

  useEffect(() => {
    if (status !== "logged-in" || !backend || !resourceUrl) {
      // Never keep rendering STALE access during a session transition: while the
      // session is (re)loading, drop any previously-loaded access and show the
      // loading state; once it settles logged-out, show NotAuthenticated. This
      // prevents the panel displaying an old resource's ACL during logout
      // (roborev).
      setState(
        status === "loading"
          ? { loading: true }
          : { loading: false, error: new NotAuthenticatedError() },
      );
      return;
    }
    let cancelled = false;
    setState({ loading: true });

    backend
      .read(resourceUrl)
      .then((access) => {
        if (!cancelled) setState({ loading: false, access });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState({
            loading: false,
            error: e instanceof Error ? e : new Error(String(e)),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [resourceUrl, status, backend, nonce]);

  return { ...state, ownerWebId: webId, backend, reload };
}
