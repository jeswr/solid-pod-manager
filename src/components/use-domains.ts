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
import { useSwrRead } from "@/components/use-swr-read";
import { readCache } from "@/lib/swr-cache";
import type { AsyncState, RevalidatableState } from "@/components/use-pod-data";
import {
  detectPurchaseFeature,
  domainsApiBase,
  getDomain,
  listDomains,
  pollIntervalMs,
  verifyDomain,
  type DomainBinding,
} from "@/lib/domains";

export interface DomainsListState extends RevalidatableState<DomainBinding[]> {
  /** The API origin (the pod server) once the session knows its storage. */
  base?: string;
  /** The pod root domains are claimed for (the active storage). */
  podRoot?: string;
  reload: () => void;
}

/**
 * The account's domain bindings, from the user's own pod server.
 *
 * Stale-while-revalidate: the list goes through the shared {@link useSwrRead}
 * cache (keyed `domains`), so navigating back to the settings page paints the
 * last-known bindings INSTANTLY and revalidates in the background.
 */
export function useDomains(): DomainsListState {
  const { activeStorage } = useSession();
  const base = activeStorage ? domainsApiBase(activeStorage) : undefined;

  const { data, error, loading, revalidating, reload } = useSwrRead<DomainBinding[]>(
    base ? "domains" : "",
    // Only invoked when the key is non-empty (base/storage known).
    () => listDomains(base as string),
  );

  return { data, error, loading, revalidating, base, podRoot: activeStorage, reload };
}

export interface DomainDetailState extends RevalidatableState<DomainBinding> {
  base?: string;
  /** True while a check (manual or polled) is running. */
  checking: boolean;
  /** Run the DNS checks now. Resolves to the updated binding; throws typed errors. */
  checkNow: () => Promise<DomainBinding | undefined>;
  reload: () => void;
}

/**
 * One binding's detail + the verify loop, with stale-while-revalidate caching
 * (keyed per domain, `domain:<domain>`) so re-opening a binding paints instantly.
 * `checkNow` drives POST verify; a background poll re-runs it every 30 s while
 * the state is pollable and the document is visible — DNS propagation takes
 * time, the user shouldn't have to hammer a button. A successful check writes
 * the AUTHORITATIVE binding back through the cache (the verify POST is itself
 * authoritative; the cache only renders its result).
 */
export function useDomain(domain: string | undefined): DomainDetailState {
  const { webId, activeStorage } = useSession();
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);

  const base = activeStorage ? domainsApiBase(activeStorage) : undefined;
  const key = base && domain ? `domain:${domain}` : "";

  const { data, error, loading, revalidating, reload } = useSwrRead<DomainBinding>(
    key,
    // Only invoked when the key is non-empty (base + domain known).
    () => getDomain(base as string, domain as string),
  );

  const checkNow = useCallback(async (): Promise<DomainBinding | undefined> => {
    if (!base || !domain || !webId || checkingRef.current) return undefined;
    checkingRef.current = true;
    setChecking(true);
    try {
      // The verify POST is authoritative; push its result into the cache so the
      // rendered binding reflects it at once (render-only cache, never a write
      // decision).
      const binding = await verifyDomain(base, domain);
      readCache.set(webId, `domain:${domain}`, binding);
      return binding;
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }, [base, domain, webId]);

  // Polite polling: only while pending, only while the tab is visible. The
  // cadence comes from the binding: ~60 s during purchase phases (each verify
  // advances the server's registration pipeline), 30 s for DNS convergence.
  const interval = data !== undefined ? pollIntervalMs(data) : undefined;
  useEffect(() => {
    if (interval === undefined) return;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      // Polling is best-effort: a transient failure just waits for the next tick.
      void checkNow().catch(() => undefined);
    }, interval);
    return () => clearInterval(timer);
  }, [interval, checkNow]);

  return { data, error, loading, revalidating, base, checking, checkNow, reload };
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
    // Reset to "probing" whenever the server/session/enabled-gate changes, so a
    // stale `true` from a previous server can never briefly reveal the buy path
    // for a different origin before the new probe answers (fail closed).
    setAvailable(undefined);
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
