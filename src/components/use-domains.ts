"use client";

/**
 * React bridge for the custom-domains data layer (`src/lib/domains.ts`).
 * Production paths pass NO `fetch` — the auth-patched global runs
 * (AGENTS.md §Reading data). The detail hook also drives the polite
 * verify-polling loop: every 30 s while the binding is in a pollable state
 * (claimed/verified), the tab is visible, and no manual check is in flight.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/components/session-provider";
import type { AsyncState } from "@/components/use-pod-data";
import {
  domainsApiBase,
  getDomain,
  isPollableState,
  listDomains,
  verifyDomain,
  type DomainBinding,
} from "@/lib/domains";

/** Verify cadence while a binding is pending and the page is on-screen. */
const POLL_INTERVAL_MS = 30_000;

export interface DomainsListState extends AsyncState<DomainBinding[]> {
  /** The API origin (the pod server) once the session knows its storage. */
  base?: string;
  /** The pod root domains are claimed for (the active storage). */
  podRoot?: string;
  reload: () => void;
}

/** The account's domain bindings, from the user's own pod server. */
export function useDomains(): DomainsListState {
  const { status, activeStorage } = useSession();
  const [state, setState] = useState<AsyncState<DomainBinding[]>>({ loading: true });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const base = activeStorage ? domainsApiBase(activeStorage) : undefined;

  useEffect(() => {
    if (status !== "logged-in" || !base) return;
    let cancelled = false;
    setState({ loading: true });
    listDomains(base)
      .then((domains) => {
        if (!cancelled) setState({ loading: false, data: domains });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ loading: false, error: error as Error });
      });
    return () => {
      cancelled = true;
    };
  }, [status, base, nonce]);

  return { ...state, base, podRoot: activeStorage, reload };
}

export interface DomainDetailState extends AsyncState<DomainBinding> {
  base?: string;
  /** True while a check (manual or polled) is running. */
  checking: boolean;
  /** Run the DNS checks now. Resolves to the updated binding; throws typed errors. */
  checkNow: () => Promise<DomainBinding | undefined>;
  reload: () => void;
}

/**
 * One binding's detail + the verify loop. `checkNow` drives POST verify; a
 * background poll re-runs it every 30 s while the state is pollable and the
 * document is visible — DNS propagation takes time, the user shouldn't have
 * to hammer a button.
 */
export function useDomain(domain: string | undefined): DomainDetailState {
  const { status, activeStorage } = useSession();
  const [state, setState] = useState<AsyncState<DomainBinding>>({ loading: true });
  const [checking, setChecking] = useState(false);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const checkingRef = useRef(false);

  const base = activeStorage ? domainsApiBase(activeStorage) : undefined;

  useEffect(() => {
    if (status !== "logged-in" || !base || !domain) return;
    let cancelled = false;
    setState({ loading: true });
    getDomain(base, domain)
      .then((binding) => {
        if (!cancelled) setState({ loading: false, data: binding });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ loading: false, error: error as Error });
      });
    return () => {
      cancelled = true;
    };
  }, [status, base, domain, nonce]);

  const checkNow = useCallback(async (): Promise<DomainBinding | undefined> => {
    if (!base || !domain || checkingRef.current) return undefined;
    checkingRef.current = true;
    setChecking(true);
    try {
      const binding = await verifyDomain(base, domain);
      setState({ loading: false, data: binding });
      return binding;
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }, [base, domain]);

  // Polite polling: only while pending, only while the tab is visible.
  const pollable = state.data !== undefined && isPollableState(state.data.state);
  useEffect(() => {
    if (!pollable) return;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      // Polling is best-effort: a transient failure just waits for the next tick.
      void checkNow().catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pollable, checkNow]);

  return { ...state, base, checking, checkNow, reload };
}
