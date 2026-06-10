"use client";

/**
 * The Solid session bridge for React. `@solid/reactive-authentication` has no
 * session object: it patches `globalThis.fetch` and upgrades on `401`. This
 * provider owns that single patch, mounts the `<authorization-code-flow>`
 * popup element, and exposes a small reactive session for the UI.
 *
 * Login model: the user enters their WebID; we resolve its issuer (so a bad
 * WebID fails fast with a clear message) and remember it; the bundled
 * `WebIdDPoPTokenProvider` drives the popup on the first authenticated request.
 * We then probe the pod root authenticated — the probe's success *is* "logged
 * in". Tokens live in memory only (AGENTS.md): a reload re-runs silently while
 * the IdP cookie lives.
 *
 * Everything here is browser-only — the auth module is dynamically imported so
 * it never evaluates during SSR (its top-level `customElements.define` would
 * break `next build`; AGENTS.md §Mounting in Next.js).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  fetchLoginCandidate,
  RecentAccounts,
  type RecentAccount,
} from "@/lib/login-ux";
import { fetchProfile, type PodProfile } from "@/lib/profile";

type Status = "loading" | "logged-out" | "authenticating" | "logged-in";

export interface Session {
  status: Status;
  webId?: string;
  profile?: PodProfile;
  /** The storage the user is browsing (chosen when several exist). */
  activeStorage?: string;
  recentAccounts: RecentAccount[];
  /** Begin login for a WebID. Resolves once authenticated, throws on failure. */
  login(webId: string): Promise<void>;
  /** Log out: clears session state. Keeps the recent-accounts memory. */
  logout(): void;
  /** Pick which storage to browse when the profile advertises several. */
  setActiveStorage(storage: string): void;
}

const SessionContext = createContext<Session | null>(null);

const ACTIVE_WEBID_KEY = "solid-pod-manager:active-webid";

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const flowRef = useRef<HTMLElement>(null);
  const registeredRef = useRef(false);
  // The WebID the provider should use for the next login flow.
  const pendingWebIdRef = useRef<string>(undefined);
  const [status, setStatus] = useState<Status>("loading");
  const [webId, setWebId] = useState<string>();
  const [profile, setProfile] = useState<PodProfile>();
  const [activeStorage, setActive] = useState<string>();
  const [recentAccounts, setRecentAccounts] = useState<RecentAccount[]>([]);

  // Register the reactive fetch manager exactly once, as early as possible.
  useEffect(() => {
    if (registeredRef.current) return;
    registeredRef.current = true;

    let cancelled = false;
    (async () => {
      const [{ ReactiveFetchManager }, { WebIdDPoPTokenProvider }] = await Promise.all([
        import("@solid/reactive-authentication"),
        import("@/lib/webid-token-provider"),
      ]);
      if (cancelled) return;

      const callbackUri = new URL("/callback.html", location.href).toString();
      const ui = flowRef.current as unknown as {
        getCode: (uri: URL, signal: AbortSignal) => Promise<string>;
      };

      // The published Client Identifier Document — served from /clientid.jsonld.
      // Locally the IdP is CSS, which dereferences localhost client-ids; in
      // production both app and IdP are HTTPS so it resolves there too
      // (solid-client-id skill).
      const clientId = new URL("/clientid.jsonld", location.href).toString();

      const provider = new WebIdDPoPTokenProvider(
        callbackUri,
        ui.getCode.bind(ui),
        // The WebID comes from the in-app login form, not a popup dialog.
        async () => {
          const id = pendingWebIdRef.current;
          if (!id) throw new Error("No WebID provided for login");
          return id;
        },
        {
          clientId,
          allowInsecureLoopback: true, // local CSS over HTTP; remote stays HTTPS-strict
        },
      );

      const manager = new ReactiveFetchManager([provider]);
      manager.registerGlobally();

      // Load remembered accounts and attempt a silent restore of the last one.
      const accounts = new RecentAccounts();
      if (!cancelled) setRecentAccounts(accounts.list());

      const last =
        typeof localStorage !== "undefined"
          ? localStorage.getItem(ACTIVE_WEBID_KEY)
          : null;
      if (last) {
        try {
          await restore(last);
        } catch {
          if (!cancelled) setStatus("logged-out");
        }
      } else if (!cancelled) {
        setStatus("logged-out");
      }
    })().catch(() => {
      if (!cancelled) setStatus("logged-out");
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const restore = useCallback(async (id: string) => {
    // Silent restore: read the (public) profile; if a private read later 401s
    // it re-auths silently while the IdP cookie lives.
    //
    // Seed pendingWebIdRef FIRST: the reactive provider's WebID resolver reads
    // it on a 401 to know whose issuer to authenticate against. login() sets it,
    // but after a hard navigation / reload (tokens are in-memory only) only this
    // restore path runs — without this, the first private read throws "No WebID
    // provided for login" and the page hangs on its loading skeleton (e.g. an
    // external app deep-linking into /connected-apps/grant). See connected-apps
    // e2e.
    pendingWebIdRef.current = id;
    const p = await fetchProfile(id);
    setWebId(id);
    setProfile(p);
    setActive(p.storages[0]);
    setStatus("logged-in");
  }, []);

  const login = useCallback(
    async (rawWebId: string) => {
      setStatus("authenticating");
      try {
        // Validate + resolve issuer first so a bad WebID fails fast with copy.
        const candidate = await fetchLoginCandidate(rawWebId);
        pendingWebIdRef.current = candidate.webId;

        // Drive the popup: a GET against a reliably PRIVATE resource so the
        // server returns 401, which the reactive provider upgrades to a login.
        // The pod root container is world-readable on a fresh CSS pod, so we
        // probe its `.acl` (owner-only Control) instead — its 200 after auth is
        // what "logged in" means here.
        const p = await fetchProfile(candidate.webId);
        const podRoot = p.storages[0];
        const probeTarget = podRoot ? `${podRoot}.acl` : candidate.webId;
        // The patched fetch handles 401→login→retry; we only need it to settle.
        await fetch(probeTarget, { method: "GET" }).catch(() => undefined);

        setWebId(candidate.webId);
        setProfile(p);
        setActive(p.storages[0]);
        setStatus("logged-in");

        const accounts = new RecentAccounts();
        accounts.remember({
          webId: candidate.webId,
          displayName: p.displayName,
          avatarUrl: p.avatarUrl,
          issuer: candidate.issuers[0],
          storage: p.storages[0],
        });
        setRecentAccounts(accounts.list());
        if (typeof localStorage !== "undefined") {
          localStorage.setItem(ACTIVE_WEBID_KEY, candidate.webId);
        }
      } catch (e) {
        setStatus("logged-out");
        throw e;
      }
    },
    [],
  );

  const logout = useCallback(() => {
    setWebId(undefined);
    setProfile(undefined);
    setActive(undefined);
    setStatus("logged-out");
    pendingWebIdRef.current = undefined;
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(ACTIVE_WEBID_KEY);
    }
  }, []);

  const setActiveStorage = useCallback((storage: string) => setActive(storage), []);

  const session = useMemo<Session>(
    () => ({
      status,
      webId,
      profile,
      activeStorage,
      recentAccounts,
      login,
      logout,
      setActiveStorage,
    }),
    [status, webId, profile, activeStorage, recentAccounts, login, logout, setActiveStorage],
  );

  return (
    <SessionContext.Provider value={session}>
      {/* The popup-driving custom element. Visually hidden until it opens. */}
      <authorization-code-flow ref={flowRef} aria-hidden="true" />
      {children}
    </SessionContext.Provider>
  );
}

/** Access the Solid session. Must be used under {@link SessionProvider}. */
export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within <SessionProvider>");
  return ctx;
}
