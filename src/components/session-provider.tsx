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
 * The popup is opened SYNCHRONOUSLY in the click handler (user activation) —
 * UNLESS the provider's synchronous probe says a cached session or refresh
 * token completes the login with fetches alone (`openPopupUnlessRenewable`),
 * in which case no window opens at all. When one does open, the protocol
 * layer (`WebIdDPoPTokenProvider` — the vendored PR #11–#14
 * token+refresh logic) navigates it straight to the INTERACTIVE authorize URL
 * (explicit logins skip the doomed `prompt=none` hop; recent-account clicks
 * and background 401 re-auth keep silent-first, retrying interactively in the
 * same window). Issuer-first logins learn the WebID from the ID token's
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
import { openPopupUnlessRenewable, PopupLoginController } from "@/lib/popup-login";
import { AmbiguousIssuerError, type WebIdDPoPTokenProvider } from "@/lib/webid-token-provider";
import {
  IndexedDbSessionStore,
  indexedDbAvailable,
  type SessionStore,
} from "@/lib/session-persistence";
import { decideSilentRestore } from "@/lib/session-restore";
import {
  loadProfileState,
  shouldClearOnSwitch,
  type ProfileLoadResult,
  type ProfileStatus,
} from "@/lib/session-profile";
import { fetchProfile, type PodProfile } from "@/lib/profile";
import { readCache } from "@/lib/swr-cache";

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
  /**
   * The state of the (cosmetic) profile/storage load that sits BEHIND a
   * `logged-in` session. A profile failure never drops `status` below
   * `logged-in` — the session is real regardless — but it is NOT swallowed: the
   * shell renders a degraded, retryable banner on `"error"` instead of leaving
   * storage/profile-dependent surfaces rendering against `undefined` with no
   * recourse.
   *
   *   • "loading" — the profile/storage load is in flight (after restore/login).
   *   • "ready"   — `profile` is set; `activeStorage` is the chosen storage.
   *   • "error"   — the load failed; `profile`/`activeStorage` stay undefined,
   *      {@link profileError} is set, and {@link retryProfile} re-attempts it.
   *
   * Outside a `logged-in` session this is `"loading"` (nothing to load yet).
   */
  profileStatus: ProfileStatus;
  /** Why the profile load failed (only when `profileStatus === "error"`). */
  profileError?: Error;
  /**
   * Re-attempt the profile/storage load for the current WebID after a
   * `profileStatus === "error"`. No-op when there is no logged-in WebID. The
   * session stays `logged-in` throughout (retry never bounces to login).
   */
  retryProfile(): void;
  recentAccounts: RecentAccount[];
  /**
   * Begin login for a WebID OR a bare issuer URL (one smart input). Call
   * DIRECTLY from the click/submit handler — when a popup is needed it opens
   * synchronously at the top so the user activation is never lost; when the
   * issuer is known up front (`opts.issuer`) and a cached session or refresh
   * token suffices, no popup opens at all. Resolves once
   * authenticated; throws on failure ({@link AmbiguousIssuerError} when the
   * WebID advertises several issuers and `opts.issuer` was not given).
   *
   * Interactive-first by default: an explicit sign-in has (almost always) no
   * IdP session, so the popup navigates straight to the login page instead of
   * bouncing through a doomed `prompt=none` attempt. `opts.silentFirst` keeps
   * the silent attempt for one-click surfaces where a live IdP session is
   * likely (the recent-account chips) — silent success there means zero typing.
   */
  login(input: string, opts?: { issuer?: string; silentFirst?: boolean }): Promise<void>;
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
  // The issuer of the active (restored or freshly-logged-in) session, kept so
  // logout can clear that issuer's persisted refresh token + DPoP key.
  const activeIssuerRef = useRef<string>(undefined);
  // The durable refresh-token-session store (IndexedDB, origin-scoped). Created
  // once on the client; shared by the provider (persist/restore) and logout.
  const sessionStoreRef = useRef<SessionStore | null>(null);
  // The one popup controller — created lazily on the client, shared between
  // the click handlers (synchronous open) and the token provider (getCode).
  const controllerRef = useRef<PopupLoginController>(null);
  // Resolves to the token provider once the auth module is wired up.
  const providerReadyRef = useRef<Promise<WebIdDPoPTokenProvider>>(null);
  // The SAME provider, synchronously reachable once ready — the click handlers
  // consult its canRenewWithoutInteraction probe BEFORE deciding to open a
  // popup, and a click handler cannot await (the user activation would be
  // spent). Null until the auth module loads; the probe then says "open".
  const providerSyncRef = useRef<WebIdDPoPTokenProvider>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [webId, setWebId] = useState<string>();
  const [profile, setProfile] = useState<PodProfile>();
  const [activeStorage, setActive] = useState<string>();
  // The explicit profile-load lifecycle behind a logged-in session. A profile
  // failure surfaces here as "error" (with profileError) rather than being
  // swallowed into a silent undefined-profile state; the session stays
  // logged-in regardless (see Session.profileStatus).
  const [profileStatus, setProfileStatus] = useState<ProfileStatus>("loading");
  const [profileError, setProfileError] = useState<Error | undefined>(undefined);
  // The WebID whose profile retryProfile() should re-load — mirrors `webId` in a
  // ref so the stable retry callback never goes stale.
  const profileWebIdRef = useRef<string>(undefined);
  // The WebID the currently-EXPOSED `profile`/`activeStorage` belong to (set only
  // when a "ready" load commits; cleared on an account-switch blank + on logout).
  // `loadProfileFor` compares the incoming WebID against this to decide whether a
  // load is an account SWITCH (clear stale storage/profile before exposing the new
  // logged-in identity) versus a same-WebID retry (keep the good profile — no
  // flash). See shouldClearOnSwitch in session-profile.ts.
  const exposedProfileWebIdRef = useRef<string>(undefined);
  // Monotonic generation guard: a profile load only commits its result if it is
  // still the latest (guards an account switch / retry racing a slow load, and
  // is bumped on logout to drop any in-flight load).
  const profileLoadGenRef = useRef(0);
  // Bumped to re-trigger the profile-load effect (restore-path load + retry).
  const [profileReloadKey, setProfileReloadKey] = useState(0);
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

      // Durable DPoP-bound refresh-token session (IndexedDB, origin-scoped) —
      // lets a returning user restore via a refresh grant (a fetch) instead of
      // the prompt=none authorization probe that flashes a window. Absent in
      // SSR / locked-down environments; the provider then stays in-memory only.
      const sessionStore: SessionStore | undefined = indexedDbAvailable()
        ? new IndexedDbSessionStore()
        : undefined;
      sessionStoreRef.current = sessionStore ?? null;

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
          sessionStore,
          // Keep the cached session continuously fresh in the BACKGROUND so a
          // long import or an idle→active session never hits an expired token
          // mid-flow. Visibility-gated (no churn in a hidden tab); torn down on
          // unmount; stops (no popup) on a dead refresh token. The lazy
          // renew-on-401 path remains the fallback. (Dom visibility lifecycle is
          // the default in a browser.)
          proactiveRefresh: true,
        },
      );

      const manager = new ReactiveFetchManager([provider]);
      manager.registerGlobally();
      providerSyncRef.current = provider;
      return provider;
    })();

    (async () => {
      await providerReadyRef.current;
      if (cancelled) return;

      // Load remembered accounts and attempt a silent restore of the last one.
      const accounts = new RecentAccounts();
      const remembered = accounts.list();
      if (!cancelled) setRecentAccounts(remembered);

      const last =
        typeof localStorage !== "undefined"
          ? localStorage.getItem(ACTIVE_WEBID_KEY)
          : null;

      // The decision: can we restore the last session SILENTLY (refresh-token
      // grant — a token-endpoint fetch, NO popup/iframe) or must we show login?
      // Driven off the REFRESH-GRANT outcome, NOT a public-profile fetch — a
      // returning user who only closed the tab keeps a valid persisted refresh
      // token + DPoP key, so they land back on the app, never the login screen.
      // (Gating "logged in" on the profile read was the bug: a transient
      // profile-read blip used to bounce a fully-restored user to login.)
      const decision = await decideSilentRestore({
        lastActiveWebId: last,
        remembered,
        restoreIssuer: async (issuer) => {
          const provider = await providerReadyRef.current;
          // restoreIssuer never throws for the expired/revoked case (it returns
          // undefined and clears the dead entry); a thrown error here is
          // unexpected and decideSilentRestore treats it as "login" (fail-closed).
          return provider?.restoreIssuer(new URL(issuer));
        },
      });
      if (cancelled) return;

      if (decision.outcome === "restored") {
        // Live session rebuilt with no popup. Pin the issuer for logout + the
        // 401-upgrade WebID resolver, mark logged-in immediately — the session
        // is real regardless of the profile read. The (cosmetic) profile/storage
        // load then runs in the shared profile effect below: it resolves to
        // "ready" or, on a transient blip, "error" (with a retry) — NEVER
        // bouncing to login (that was the reopen-routes-through-login bug) and
        // NEVER swallowed into a silent undefined-profile state.
        activeIssuerRef.current = decision.issuer;
        pendingWebIdRef.current = decision.webId;
        profileWebIdRef.current = decision.webId;
        setProfileStatus("loading");
        setProfileError(undefined);
        setWebId(decision.webId);
        setStatus("logged-in");
        // Trigger the shared profile-load effect (restore path). The effect
        // reads profileWebIdRef and runs loadProfileFor once logged-in.
        setProfileReloadKey((k) => k + 1);
      } else {
        setStatus("logged-out");
      }
    })().catch(() => {
      if (!cancelled) setStatus("logged-out");
    });

    return () => {
      cancelled = true;
      // Tear down proactive-refresh timers + the visibility listeners on
      // unmount so nothing leaks (no orphaned intervals, no token churn) after
      // this provider is discarded. Fire-and-forget; teardown is idempotent.
      void providerReadyRef.current?.then((p) => p?.teardown()).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The SHARED profile/storage load behind a logged-in session. Every path that
  // lands logged-in (restore + interactive login) and every retry funnels
  // through here, so the explicit profileStatus lifecycle is identical
  // everywhere. Reports an EXPLICIT terminal state via loadProfileState (which
  // never throws): "ready" (profile + activeStorage set) or "error"
  // (profile/activeStorage stay undefined, profileError set, retry offered). The
  // session stays logged-in throughout — a profile blip never drops to login,
  // and is never swallowed into a silent undefined-profile state.
  //
  // `profileLoadGenRef` guards against a stale load clobbering a newer one (an
  // account switch, or a retry that races a slow in-flight load): each call
  // claims the next generation and only commits if it is still the latest.
  // Returns the terminal result so a caller (the login path) can act on it (e.g.
  // record the recent account) without re-loading.
  // Enter the "loading" profile state for `id`, CLEARING the prior account's
  // exposed profile/activeStorage first when this is a real account SWITCH (a
  // DIFFERENT WebID than the one currently exposed). Co-located with the
  // `setStatus("logged-in")` transition so the clear and the new logged-in
  // status commit together — children NEVER observe the new WebID's
  // `logged-in` status paired with the PRIOR account's storage/profile (a page
  // guarding only on activeStorage would otherwise briefly read/act on the
  // wrong pod). A same-WebID retry (shouldClearOnSwitch === false) keeps the
  // existing profile so a degraded → retry never flashes the UI empty. Safe and
  // idempotent: both the login/restore status transition and loadProfileFor's
  // prologue call it; the second call is a no-op once cleared. See
  // shouldClearOnSwitch.
  const enterSwitchLoading = useCallback((id: string) => {
    profileWebIdRef.current = id;
    if (shouldClearOnSwitch(id, exposedProfileWebIdRef.current)) {
      exposedProfileWebIdRef.current = undefined;
      setProfile(undefined);
      setActive(undefined);
    }
    setProfileStatus("loading");
    setProfileError(undefined);
  }, []);

  const loadProfileFor = useCallback(async (id: string): Promise<ProfileLoadResult> => {
    const gen = ++profileLoadGenRef.current;
    enterSwitchLoading(id);
    const result = await loadProfileState(id, fetchProfile);
    // A newer load (or a logout) superseded this one: drop the stale result.
    if (gen !== profileLoadGenRef.current) return result;
    if (result.status === "ready") {
      setProfile(result.profile);
      setActive(result.activeStorage);
      exposedProfileWebIdRef.current = id;
      setProfileError(undefined);
      setProfileStatus("ready");
    } else {
      // The session stands; expose the error + a retry. Do NOT drop to
      // logged-out (the reopen-routes-through-login bug) and do NOT leave
      // profile/activeStorage silently undefined with no recourse.
      exposedProfileWebIdRef.current = undefined;
      setProfile(undefined);
      setActive(undefined);
      setProfileError(result.error);
      setProfileStatus("error");
    }
    return result;
  }, [enterSwitchLoading]);

  // Drive the restore path's profile load: when a silent restore lands
  // logged-in it sets the WebID + profileStatus:"loading" and bumps
  // profileReloadKey; this effect then runs the shared loader. (The interactive
  // login path calls loadProfileFor inline — it needs the result to record the
  // recent account — so this effect is for restore + retry.)
  useEffect(() => {
    if (status !== "logged-in" || profileReloadKey === 0) return;
    const id = profileWebIdRef.current;
    if (!id) return;
    void loadProfileFor(id);
  }, [status, profileReloadKey, loadProfileFor]);

  /**
   * Re-attempt the profile/storage load after a `profileStatus === "error"`
   * (or trigger the restore-path load). Bumps profileReloadKey so the effect
   * above re-runs the shared loader. No-op without a logged-in WebID.
   */
  const retryProfile = useCallback(() => {
    if (!profileWebIdRef.current) return;
    setProfileReloadKey((k) => k + 1);
  }, []);

  /**
   * The shared back half of every login: run the code flow against the
   * resolved issuer, learn/confirm the WebID, load the profile, persist.
   * The popup MUST already be open (synchronously, by the caller).
   */
  const completeLogin = useCallback(
    async (issuer: string, knownWebId: string | undefined, silentFirst = false) => {
      setStatus("authenticating");
      try {
        const provider = await providerReadyRef.current;
        if (!provider) throw new Error("Auth is not initialised yet");

        const { webId: statedWebId } = await provider.login(new URL(issuer), {
          silentFirst,
        });
        // A cached fresh session resolves login() without running the code
        // flow — nothing ever navigates the popup, so close the blank window
        // the click handler opened.
        getController().closeIfOpen();
        const id = knownWebId ?? statedWebId;
        if (!id) throw new NoWebIdFromProviderError(issuer);

        // From here the 401-upgrade path knows whose session this is, and
        // logout knows which issuer's persisted session to clear.
        pendingWebIdRef.current = id;
        activeIssuerRef.current = issuer;

        // Account switch (logging into a different WebID without an explicit
        // logout): clear the read cache so the new account never renders the
        // previous one's cached models. Per-WebID keying already prevents a
        // cross-account read; this also frees the old partition. AND clear the
        // prior account's exposed profile/activeStorage HERE — before we mark
        // the new WebID logged-in — so children never observe B's `logged-in`
        // status paired with A's storage/profile (the account-switch wrong-pod
        // window). `enterSwitchLoading` clears both refs + state on a real
        // WebID change; the shared loader then resolves to B's own profile.
        setWebId((prev) => {
          if (prev && prev !== id) readCache.clearWebId(prev);
          return id;
        });
        enterSwitchLoading(id);
        // The token grant succeeded → the session is real; mark logged-in. The
        // (cosmetic) profile/storage load runs through the SHARED loader, so the
        // explicit profileStatus lifecycle is identical to the restore path: a
        // profile blip after a successful login does NOT bounce back to
        // logged-out — it surfaces as profileStatus:"error" with a retry, never
        // a silent undefined-profile state.
        setStatus("logged-in");
        const result = await loadProfileFor(id);

        // Record the recent account from the load result. On "ready" we have the
        // display name/avatar/storage; on "error" we still remember the account
        // (WebID + issuer) so its chip works — the display name falls back to the
        // WebID (the same fallback the profile uses) and fills in on a retry.
        const accounts = new RecentAccounts();
        if (result.status === "ready") {
          accounts.remember({
            webId: id,
            displayName: result.profile.displayName,
            avatarUrl: result.profile.avatarUrl,
            issuer,
            storage: result.activeStorage,
          });
        } else {
          accounts.remember({ webId: id, displayName: id, issuer });
        }
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
    [getController, loadProfileFor, enterSwitchLoading],
  );

  const login = useCallback(
    async (input: string, opts?: { issuer?: string; silentFirst?: boolean }) => {
      // SYNCHRONOUS popup decision — first statement, inside the user
      // activation. When the issuer is known NOW (recent-account chip, issuer
      // choice) and the provider's probe says a cached session or refresh
      // token completes this login with fetches alone, no popup opens at all
      // — "Continue as" with a live session must not flash a blank window.
      // Everywhere else (typed WebID: the issuer is a profile fetch away)
      // the popup opens here, synchronously, exactly as before.
      openPopupUnlessRenewable(getController(), providerSyncRef.current, opts?.issuer);
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
        await completeLogin(issuer, knownWebId, opts?.silentFirst ?? false);
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
      // SYNCHRONOUS popup decision — first statement, inside the user
      // activation (see login() above; a repeat provider-picker click with a
      // live session re-logs-in without a window).
      openPopupUnlessRenewable(getController(), providerSyncRef.current, issuer);
      await completeLogin(issuer, undefined);
    },
    [completeLogin, getController],
  );

  const cancelLogin = useCallback(() => {
    setBlockedPopup(null);
    getController().cancel();
  }, [getController]);

  const logout = useCallback(() => {
    // Drop every cached read model so a logged-out (or next) user is never
    // shown the previous account's data from the SWR read cache. The cache is
    // a render-speed optimization only; clearing it here is the security
    // boundary for the read snapshots (writes already re-read fresh).
    readCache.clearAll();
    setWebId(undefined);
    setProfile(undefined);
    setActive(undefined);
    setStatus("logged-out");
    pendingWebIdRef.current = undefined;
    // Invalidate any in-flight profile load (its result must not land after
    // logout) and reset the explicit profile lifecycle for the next session.
    profileLoadGenRef.current++;
    profileWebIdRef.current = undefined;
    exposedProfileWebIdRef.current = undefined;
    setProfileStatus("loading");
    setProfileError(undefined);
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(ACTIVE_WEBID_KEY);
    }
    // Wipe the persisted DPoP-bound refresh token + key for this issuer so a
    // logged-out user is NOT silently restored on the next load (the credential
    // must not outlive an explicit sign-out). Fire-and-forget; clears both via
    // the provider (which owns the store) and, defensively, the store directly.
    const issuer = activeIssuerRef.current;
    activeIssuerRef.current = undefined;
    if (issuer) {
      void providerReadyRef.current
        ?.then((p) => p?.forgetPersisted(new URL(issuer)))
        .catch(() => {});
      void sessionStoreRef.current?.delete(issuer).catch(() => {});
    }
  }, []);

  const setActiveStorage = useCallback((storage: string) => setActive(storage), []);

  const session = useMemo<Session>(
    () => ({
      status,
      webId,
      profile,
      activeStorage,
      profileStatus,
      profileError,
      retryProfile,
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
      profileStatus,
      profileError,
      retryProfile,
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
