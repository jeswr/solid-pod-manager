"use client";

/**
 * The Solid session bridge for React. `@solid/reactive-authentication` has no
 * session object: it patches `globalThis.fetch` and upgrades on `401`. This
 * provider owns that single patch and the LOGIN POPUP LIFECYCLE (first-party —
 * the library's `<authorization-code-flow>` web component is gone; see
 * `src/lib/popup-login.ts` for the rules), and exposes a small reactive
 * session for the UI.
 *
 * Login model (first-party UI): the user picks a provider, or enters EITHER a
 * WebID OR a bare issuer URL in one smart input (`src/lib/login-input.ts`).
 * The popup is opened SYNCHRONOUSLY in the click handler (user activation),
 * then the protocol layer (`WebIdDPoPTokenProvider` — the vendored PR #11–#14
 * token+refresh logic) drives `prompt=none` first and the interactive flow in
 * that same window. Issuer-first logins learn the WebID from the ID token's
 * `webid` claim. Tokens live in memory only (AGENTS.md): a reload re-runs
 * silently while the IdP cookie lives.
 *
 * The auth library is dynamically imported so it never evaluates during SSR
 * (AGENTS.md §Mounting in Next.js).
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
import { RecentAccounts, type RecentAccount } from "@/lib/login-ux";
import { resolveLoginInput, type LoginTarget } from "@/lib/login-input";
import { PopupLoginController } from "@/lib/popup-login";
import { AmbiguousIssuerError, type WebIdDPoPTokenProvider } from "@/lib/webid-token-provider";
import { fetchProfile, type PodProfile } from "@/lib/profile";

type Status = "loading" | "logged-out" | "authenticating" | "logged-in";

/** The provider signed the user in but stated no WebID in the ID token. */
export class NoWebIdFromProviderError extends Error {
  constructor(issuer: string) {
    super(
      `Signed in, but the provider did not state a WebID in the ID token (${issuer}).`,
    );
    this.name = "NoWebIdFromProviderError";
  }
}

export interface Session {
  status: Status;
  webId?: string;
  profile?: PodProfile;
  /** The storage the user is browsing (chosen when several exist). */
  activeStorage?: string;
  recentAccounts: RecentAccount[];
  /**
   * Begin login for a WebID OR a bare issuer URL (one smart input). Call
   * DIRECTLY from the click/submit handler — the popup opens synchronously at
   * the top so the user activation is never lost. Resolves once
   * authenticated; throws on failure ({@link AmbiguousIssuerError} when the
   * WebID advertises several issuers and `opts.issuer` was not given).
   */
  login(input: string, opts?: { issuer?: string }): Promise<void>;
  /**
   * Begin login against a KNOWN issuer (provider picker / "Get started" with
   * the home provider — works for a fresh human with no WebID). Call directly
   * from the click handler, like {@link login}.
   */
  loginWithIssuer(issuer: string): Promise<void>;
  /** Cancel an in-flight login: closes the popup, rejects the pending flow. */
  cancelLogin(): void;
  /** Log out: clears session state. Keeps the recent-accounts memory. */
  logout(): void;
  /** Pick which storage to browse when the profile advertises several. */
  setActiveStorage(storage: string): void;
}

const SessionContext = createContext<Session | null>(null);

const ACTIVE_WEBID_KEY = "solid-pod-manager:active-webid";

/** A blocked-popup recovery: `resume` re-opens under a fresh user gesture. */
interface BlockedPopup {
  resume: () => void;
  cancel: () => void;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const registeredRef = useRef(false);
  // The WebID the provider's 401-upgrade path should resolve the issuer from
  // when no issuer is pinned yet (the silent-restore path after a reload).
  const pendingWebIdRef = useRef<string>(undefined);
  // The one popup controller — created lazily on the client, shared between
  // the click handlers (synchronous open) and the token provider (getCode).
  const controllerRef = useRef<PopupLoginController>(null);
  // Resolves to the token provider once the auth module is wired up.
  const providerReadyRef = useRef<Promise<WebIdDPoPTokenProvider>>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [webId, setWebId] = useState<string>();
  const [profile, setProfile] = useState<PodProfile>();
  const [activeStorage, setActive] = useState<string>();
  const [recentAccounts, setRecentAccounts] = useState<RecentAccount[]>([]);
  const [blockedPopup, setBlockedPopup] = useState<BlockedPopup | null>(null);

  /** The popup controller (client-only; created on first use). */
  const getController = useCallback((): PopupLoginController => {
    controllerRef.current ??= new PopupLoginController({
      // callback.html is same-origin with the app — the ONLY origin whose
      // postMessage may end a flow.
      expectedOrigin: location.origin,
      onBlocked: (resume, cancel) =>
        setBlockedPopup({
          resume: () => {
            setBlockedPopup(null);
            resume();
          },
          cancel: () => {
            setBlockedPopup(null);
            cancel();
          },
        }),
    });
    return controllerRef.current;
  }, []);

  // Register the reactive fetch manager exactly once, as early as possible.
  useEffect(() => {
    if (registeredRef.current) return;
    registeredRef.current = true;

    let cancelled = false;
    providerReadyRef.current = (async () => {
      const [{ ReactiveFetchManager }, { WebIdDPoPTokenProvider }] =
        await Promise.all([
          import("@solid/reactive-authentication"),
          import("@/lib/webid-token-provider"),
        ]);

      const controller = getController();
      const callbackUri = new URL("/callback.html", location.href).toString();

      // The published Client Identifier Document — served from /clientid.jsonld.
      // Locally the IdP is CSS, which dereferences localhost client-ids; in
      // production both app and IdP are HTTPS so it resolves there too
      // (solid-client-id skill).
      const clientId = new URL("/clientid.jsonld", location.href).toString();

      const provider = new WebIdDPoPTokenProvider(
        callbackUri,
        // The app-owned popup drives the user through the authorization
        // endpoint (silent first, interactive retry in the same window).
        (uri, signal) => controller.getCode(uri, signal),
        // 401-upgrade fallback (post-reload silent restore): the WebID whose
        // issuer to authenticate against comes from the restored session.
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
      return provider;
    })();

    (async () => {
      await providerReadyRef.current;
      if (cancelled) return;

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
    // it on a 401 to know whose issuer to authenticate against. login() pins
    // the issuer directly, but after a hard navigation / reload (tokens are
    // in-memory only) only this restore path runs — without this, the first
    // private read throws "No WebID provided for login" and the page hangs on
    // its loading skeleton (e.g. an external app deep-linking into
    // /connected-apps/grant). See connected-apps e2e.
    pendingWebIdRef.current = id;
    const p = await fetchProfile(id);
    setWebId(id);
    setProfile(p);
    setActive(p.storages[0]);
    setStatus("logged-in");
  }, []);

  /**
   * The shared back half of every login: run the code flow against the
   * resolved issuer, learn/confirm the WebID, load the profile, persist.
   * The popup MUST already be open (synchronously, by the caller).
   */
  const completeLogin = useCallback(
    async (issuer: string, knownWebId: string | undefined) => {
      setStatus("authenticating");
      try {
        const provider = await providerReadyRef.current;
        if (!provider) throw new Error("Auth is not initialised yet");

        const { webId: statedWebId } = await provider.login(new URL(issuer));
        const id = knownWebId ?? statedWebId;
        if (!id) throw new NoWebIdFromProviderError(issuer);

        // From here the 401-upgrade path knows whose session this is.
        pendingWebIdRef.current = id;

        const p = await fetchProfile(id);
        setWebId(id);
        setProfile(p);
        setActive(p.storages[0]);
        setStatus("logged-in");

        const accounts = new RecentAccounts();
        accounts.remember({
          webId: id,
          displayName: p.displayName,
          avatarUrl: p.avatarUrl,
          issuer,
          storage: p.storages[0],
        });
        setRecentAccounts(accounts.list());
        if (typeof localStorage !== "undefined") {
          localStorage.setItem(ACTIVE_WEBID_KEY, id);
        }
      } catch (e) {
        getController().closeIfOpen();
        setBlockedPopup(null);
        setStatus("logged-out");
        throw e;
      }
    },
    [getController],
  );

  const login = useCallback(
    async (input: string, opts?: { issuer?: string }) => {
      // SYNCHRONOUS popup open — first statement, inside the user activation.
      getController().open();
      setStatus("authenticating");
      try {
        // Resolve the smart input: WebID (deref → solid:oidcIssuer) or bare
        // issuer (OIDC discovery). A remembered issuer (recent account) skips
        // ambiguity; several advertised issuers without a choice throw so the
        // UI can let the USER pick — never silently the first.
        let issuer = opts?.issuer;
        let knownWebId: string | undefined;
        const target: LoginTarget = await resolveLoginInput(input);
        if (target.kind === "webid") {
          knownWebId = target.webId;
          if (!issuer) {
            if (target.issuers.length > 1) {
              throw new AmbiguousIssuerError(target.webId, target.issuers);
            }
            issuer = target.issuers[0];
          }
        } else {
          issuer ??= target.issuer;
        }
        await completeLogin(issuer, knownWebId);
      } catch (e) {
        getController().closeIfOpen();
        setStatus("logged-out");
        throw e;
      }
    },
    [completeLogin, getController],
  );

  const loginWithIssuer = useCallback(
    async (issuer: string) => {
      // SYNCHRONOUS popup open — first statement, inside the user activation.
      getController().open();
      await completeLogin(issuer, undefined);
    },
    [completeLogin, getController],
  );

  const cancelLogin = useCallback(() => {
    setBlockedPopup(null);
    getController().cancel();
  }, [getController]);

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
      loginWithIssuer,
      cancelLogin,
      logout,
      setActiveStorage,
    }),
    [
      status,
      webId,
      profile,
      activeStorage,
      recentAccounts,
      login,
      loginWithIssuer,
      cancelLogin,
      logout,
      setActiveStorage,
    ],
  );

  return (
    <SessionContext.Provider value={session}>
      {children}
      {/* Blocked-popup recovery: a background re-auth needed a popup but the
          browser blocked window.open (no user activation). The button click
          IS the fresh activation `resume()` re-opens under. */}
      {blockedPopup && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="popup-blocked-title"
          className="fixed inset-0 z-50 grid place-items-center bg-foreground/40 p-4"
        >
          <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-lg">
            <h2 id="popup-blocked-title" className="text-base font-semibold">
              Continue signing in
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Your provider needs a sign-in window, but the browser blocked it.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={blockedPopup.cancel}
                className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={blockedPopup.resume}
                className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                Open sign-in window
              </button>
            </div>
          </div>
        </div>
      )}
    </SessionContext.Provider>
  );
}

/** Access the Solid session. Must be used under {@link SessionProvider}. */
export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within <SessionProvider>");
  return ctx;
}
