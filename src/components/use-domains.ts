"use client";

/**
 * React bridge for the custom-domains data layer (`src/lib/domains.ts`).
 * Production paths pass NO `fetch` — the auth-patched global runs
 * (AGENTS.md §Reading data). The detail hook also drives the polite
 * verify-polling loop while the binding is in a pollable state, the tab is
 * visible, and no manual check is in flight — 30 s for DNS convergence,
 * ~60 s for purchase phases (`pollIntervalMs` in the lib decides).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/components/session-provider";
import type { AsyncState } from "@/components/use-pod-data";
import {
  detectPurchaseFeature,
  domainsApiBase,
  getDomain,
  listDomains,
  pollIntervalMs,
  verifyDomain,
  type DomainBinding,
} from "@/lib/domains";

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

  // Polite polling: only while pending, only while the tab is visible. The
  // cadence comes from the binding: ~60 s during purchase phases (each verify
  // advances the server's registration pipeline), 30 s for DNS convergence.
  const interval = state.data !== undefined ? pollIntervalMs(state.data) : undefined;
  useEffect(() => {
    if (interval === undefined) return;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      // Polling is best-effort: a transient failure just waits for the next tick.
      void checkNow().catch(() => undefined);
    }, interval);
    return () => clearInterval(timer);
  }, [interval, checkNow]);

  return { ...state, base, checking, checkNow, reload };
}

/**
 * Whether the pod server offers the in-service domain PURCHASE flow
 * (`PSS_DOMAIN_PURCHASE_ENABLE`, optional even when connect-your-own is on).
 * `available` is `undefined` while probing; any failure — including an
 * expired session — counts as unavailable (fail closed: the buy path hides,
 * connect-your-own still works). Pass `enabled: false` until the domains
 * list has loaded so the probe never races feature/session detection.
 */
export function usePurchaseFeature(
  base: string | undefined,
  enabled: boolean,
): { available: boolean | undefined } {
  const { status } = useSession();
  const [available, setAvailable] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (status !== "logged-in" || !base || !enabled) return;
    let cancelled = false;
    detectPurchaseFeature(base)
      .then((result) => {
        if (!cancelled) setAvailable(result);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [status, base, enabled]);

  return { available };
}
