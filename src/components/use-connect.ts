"use client";

/**
 * The connect/import state machine for one integration.
 *
 *   idle → (authorizing, live only) → importing → done | error
 *
 * Live mode runs the PKCE popup first (token kept in memory only); demo mode
 * goes straight to a fixture-backed import. Either way the import writes
 * through the same pod path, so the demo exercises the real UX end-to-end.
 * The incremental cursor lives for the page's lifetime — a second click on
 * "Import again" syncs incrementally where the platform supports it.
 */
import { useCallback, useRef, useState } from "react";
import { NoStorageError } from "@/lib/errors";
import { authorize } from "@/lib/integrations/core/oauth";
import {
  type ImportReport,
  runImport,
} from "@/lib/integrations/core/import-runner";
import { getToken, setToken } from "@/lib/integrations/core/token-store";
import type { ImportProgress, IntegrationAdapter } from "@/lib/integrations/core/types";
import { isLive } from "@/lib/integrations/registry";
import { useSession } from "./session-provider";

export type ConnectPhase = "idle" | "authorizing" | "importing" | "done" | "error";

export interface ConnectState {
  phase: ConnectPhase;
  progress?: ImportProgress;
  report?: ImportReport;
  error?: Error;
}

export function useConnect(adapter: IntegrationAdapter | undefined) {
  const { webId, profile, activeStorage } = useSession();
  const [state, setState] = useState<ConnectState>({ phase: "idle" });
  const cursorRef = useRef<string | undefined>(undefined);
  // Tier-B is approval-gated by contract (registry.statusOf never returns "live"
  // for it): the platform, not a configured client id, gates going live. So even
  // if a NEXT_PUBLIC_<TIERB>_CLIENT_ID is set at build, never run a live OAuth
  // import — otherwise the "Import demo data" button would silently pull the
  // user's REAL account under a "Demo" label (PM review, dark-pattern hazard).
  const live = adapter ? adapter.metadata.tier !== "B" && isLive(adapter) : false;

  const start = useCallback(async () => {
    if (!adapter || !webId) return;
    const podRoot = activeStorage ?? profile?.storages[0];
    if (!podRoot) {
      setState({ phase: "error", error: new NoStorageError(webId) });
      return;
    }
    try {
      let token = getToken(adapter.metadata.id);
      if (live && !token && adapter.oauth) {
        setState({ phase: "authorizing" });
        token = await authorize(adapter.metadata.id, adapter.oauth);
        setToken(adapter.metadata.id, token);
      }

      setState({ phase: "importing" });
      const report = await runImport({
        adapter,
        webId,
        podRoot,
        mode: live ? "live" : "demo",
        token: live ? token : undefined,
        cursor: cursorRef.current,
        onProgress: (progress) =>
          setState((s) => ({ ...s, phase: "importing", progress })),
      });
      cursorRef.current = report.cursor;
      setState({ phase: "done", report });
    } catch (e) {
      setState({
        phase: "error",
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }
  }, [adapter, webId, profile, activeStorage, live]);

  const reset = useCallback(() => setState({ phase: "idle" }), []);

  return { state, start, reset, live };
}
