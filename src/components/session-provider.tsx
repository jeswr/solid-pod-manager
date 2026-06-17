"use client";

/**
 * The Solid session bridge for React. There is no upstream session object: the
 * authenticated `fetch` is a patched `globalThis.fetch`. This provider owns that
 * single patch and the LOGIN POPUP LIFECYCLE (first-party — the library's
 * `<authorization-code-flow>` web component is gone; see `src/lib/popup-login.ts`
 * for the rules), and exposes a small reactive session for the UI.
 *
 * The global fetch patch is the PROACTIVE-ATTACH wrapper (`proactive-auth-fetch.ts`),
 * NOT reactive-auth's `ReactiveFetchManager`: it attaches the DPoP token on the FIRST
 * request to an allowed (own-pod) origin instead of sending every request
 * unauthenticated and upgrading on a 401 — eliminating the per-resource "401 dance"
 * (#123). The credential-origin boundary (`allowedOriginsRef`) is derived from the
 * active session's WebID + issuer + storage origins and read fresh per request, so the
 * token never reaches a foreign origin. The existing `WebIdDPoPTokenProvider` (issuer-
 * session cache + proactive refresh + refresh-grant restore) is unchanged; only WHEN it
 * upgrades changed (proactive, not reactive-on-401).
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
import { fetchProfile, type PodProfile } from "@/lib/profile";
import { readCache } from "@/lib/swr-cache";
import { nativeFetch } from "@/lib/native-fetch";
import {
  computeAllowedOrigins,
  installProactiveAuthFetch,
} from "@/lib/proactive-auth-fetch";

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
  // The CURRENT credential-origin boundary — the set of resource origins the
  // proactive-auth fetch may attach the session's DPoP token to. Read FRESH per
  // request by the global fetch wrapper, so a post-login storage/WebID change
  // updates the boundary without re-installing the wrapper. Empty (fail-closed)
  // until a session resolves its WebID + storages.
  const allowedOriginsRef = useRef<ReadonlySet<string>>(new Set<string>());
  // The active issuer's origin(s) — scopes the proactive-auth wrapper's
  // provider-internal-OAuth bypass (a CSS pod shares its IdP's origin, so the wrapper must
  // not re-upgrade the provider's own token/discovery calls). Empty until a session
  // resolves; cleared on logout.
  const issuerOriginRef = useRef<ReadonlySet<string>>(new Set<string>());
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

  /**
   * Recompute the credential-origin boundary from the active session and store it in
   * {@link allowedOriginsRef} (the proactive-auth fetch reads it fresh per request). The
   * allowed set is the WebID's origin + the issuer's origin + every advertised storage
   * origin — the origins a user's own resources are served from.
   *
   * `allowInsecureLoopback` is enabled ONLY when the APP itself runs on a loopback origin
   * (dev/test CSS over HTTP at http://localhost); a deployed HTTPS app leaves it false, so
   * the boundary's cleartext guard DROPS any http: origin — the DPoP token can never ride
   * over plaintext in production. (The boundary is fail-closed regardless: an empty set
   * attaches the token to nothing.)
   */
  const refreshAllowedOrigins = useCallback(
    (id: string | undefined, storages: string[], issuer: string | undefined) => {
      const appOnLoopback =
        typeof location !== "undefined" &&
        (location.hostname === "localhost" ||
          location.hostname === "127.0.0.1" ||
          // `Location.hostname` returns the IPv6 loopback WITHOUT brackets (`::1`), unlike a
          // URL parsed from `http://[::1]/` (`[::1]`); accept both so an app served from the
          // IPv6 loopback in dev/test still enables the loopback exception.
          location.hostname === "::1" ||
          location.hostname === "[::1]");
      allowedOriginsRef.current = computeAllowedOrigins({
        allowedOrigins: storages,
        webId: id,
        issuer,
        allowInsecureLoopback: appOnLoopback,
      });
      // The issuer origin alone (same cleartext rules) — scopes the OAuth-bypass so only
      // calls to the IdP are excluded from proactive upgrade, never a pod resource write.
      issuerOriginRef.current = computeAllowedOrigins({
        allowedOrigins: issuer ? [issuer] : [],
        includeWebIdOrigin: false,
        includeIssuerOrigin: false,
        allowInsecureLoopback: appOnLoopback,
      });
    },
    [],
  );

  /**
   * Close the credential boundary AND clear every session pointer the proactive-auth fetch
   * consults. MUST be called on EVERY failure path that may have opened the boundary before
   * the session fully landed (e.g. `provider.login()` succeeds but the subsequent
   * `fetchProfile()` throws): otherwise the wrapper could keep attaching the DPoP token for
   * the stale issuer/origin while the UI is logged-out (the roborev finding). Idempotent.
   */
  const closeCredentialBoundary = useCallback(() => {
    allowedOriginsRef.current = new Set<string>();
    issuerOriginRef.current = new Set<string>();
    activeIssuerRef.current = undefined;
    pendingWebIdRef.current = undefined;
  }, []);

  // Wire the token provider + install the proactive-auth global fetch wrapper exactly
  // once, as early as possible.
  useEffect(() => {
    if (registeredRef.current) return;
    registeredRef.current = true;

    let cancelled = false;
    providerReadyRef.current = (async () => {
      const { WebIdDPoPTokenProvider } = await import("@/lib/webid-token-provider");

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

      // Patch the global `fetch` with the PROACTIVE-ATTACH wrapper (replacing the old
      // reactive `ReactiveFetchManager`, which sent every request unauthenticated first
      // and only upgraded on a 401 — paying a wasted 401→upgrade→retry per distinct URL,
      // the "401 dance"). The wrapper attaches the DPoP token PROACTIVELY on the first
      // request to an allowed origin and does one bounded 401 re-upgrade; it reads the
      // CURRENT credential-origin boundary fresh per request, and is anchored on the
      // KNOWN-PRISTINE `nativeFetch` snapshot (never the live, possibly-patched global),
      // so it can never chain a foreign request through another patcher's fetch.
      // Install ONCE (the `registeredRef` guard above ensures this effect body runs a
      // single time for the app's lifetime); we deliberately never un-patch (see the
      // cleanup note). `installProactiveAuthFetch` returns an uninstall we don't retain.
      installProactiveAuthFetch({
        provider,
        allowedOrigins: () => allowedOriginsRef.current,
        // The active issuer's origin — used ONLY to scope the provider-internal-OAuth
        // bypass (so a token/refresh/discovery call to the IdP is never re-upgraded, even
        // when the pod shares the IdP's origin). https-only / loopback-in-dev, matching the
        // resource boundary's cleartext rule. Empty when logged out.
        issuerOrigins: () => issuerOriginRef.current,
        baseFetch: nativeFetch,
        // SESSION-LIVENESS gate: attach proactively ONLY when the active issuer's session
        // can renew WITHOUT interaction (a live token or a refresh token — a plain fetch).
        // `WebIdDPoPTokenProvider.matches()` always returns true, so without this a PASSIVE
        // read during silent restore (the profile fetch) for an account whose refresh token
        // is dead would start the interactive popup flow from a background fetch — breaking
        // the fail-closed silent-restore invariant. When not renewable, the request is left
        // unauthenticated; an explicit login (fresh session) passes the gate.
        //
        // RESIDUAL — the single tracked follow-up (a provider API change, deferred out of
        // this fetch-wrapper change per "keep the provider intact"): `upgrade()` can fall
        // back to the interactive authorization-code flow, and `canRenewWithoutInteraction`
        // is the only signal we have to avoid that — but it is COARSE, with two consequences
        // this gate trades off DELIBERATELY toward "never a passive popup":
        //   (a) FALSE-POSITIVE: a refresh token cached NOW can be REVOKED before `upgrade()`
        //       redeems it → `#renew` falls back to the code flow. From a background fetch the
        //       browser BLOCKS `window.open`, so the worst case is the app's blocked-popup
        //       affordance ("Continue signing in"), NOT a silent surprise window; and every
        //       login/restore failure path closes the boundary.
        //   (b) FALSE-NEGATIVE: a still-logged-in session whose access token expired with NO
        //       refresh token issued returns false here, so a private read goes out
        //       unauthenticated and 401s instead of using the silent-first re-auth. We accept
        //       the 401 (the user re-logs-in with one click) rather than risk (a)'s passive
        //       popup — the fail-closed direction.
        // The complete fix is a NON-INTERACTIVE upgrade mode on `WebIdDPoPTokenProvider`
        // (`upgrade(req, { interactive: false })` that returns the request unauthenticated
        // instead of running the code flow); then this gate can attach whenever ANY
        // non-interactive renewal is possible and never risk a background popup.
        canAttachNonInteractively: () => {
          const issuer = activeIssuerRef.current;
          if (!issuer) return false;
          try {
            return provider.canRenewWithoutInteraction(new URL(issuer));
          } catch {
            return false;
          }
        },
      });
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
      if (last) {
        try {
          // Restore the DPoP-bound refresh-token session via a refresh grant FIRST — a
          // plain token-endpoint fetch, NO popup/iframe — rebuilding a RENEWABLE in-memory
          // session before any private read can 401.
          //
          // FAIL-CLOSED, deliberately (the suite's silent-restore INVARIANT, AGENTS.md /
          // CLAUDE.md §Cross-app UX: "restore is fail-closed, so any could-not-rebuild /
          // could-not-verify path resolves to login, never a falsely-asserted session").
          // We proceed to logged-in restore ONLY when restoreIssuer actually rebuilt a
          // renewable session. This resolves a genuine THREE-WAY tension surfaced by review:
          //   (a) a background read must NOT pop a window (no passive popup) — so the wrapper
          //       attaches/refreshes only while non-interactively renewable;
          //   (b) the UI must not claim logged-in while every private read 401s with no
          //       silent recovery — so a public-shell-only "restore" is wrong; and
          //   (c) returning-user reload should be seamless.
          // There is NO no-window path to a fresh session once the refresh token is dead
          // (a prompt=none attempt needs a popup, blocked outside a user gesture), so the
          // invariant-compliant choice for the dead-token case is (b)+(a): fall back to
          // login. PM persists a refresh token on EVERY login (IndexedDB), so this case is
          // rare (cleared storage / IndexedDB unavailable); the user then re-authenticates
          // with ONE click that completes silently (no typing, no visible window) while the
          // IdP cookie lives via `openPopupUnlessRenewable` + the silent-first probe. So:
          // renewable session ⇒ restore + logged-in; otherwise ⇒ logged-out.
          const issuer = remembered.find((a) => a.webId === last)?.issuer;
          let restored = false;
          if (issuer) {
            const provider = await providerReadyRef.current;
            const outcome = await provider
              ?.restoreIssuer(new URL(issuer))
              .catch(() => undefined);
            if (outcome && !cancelled) {
              activeIssuerRef.current = issuer;
              restored = true;
            }
          }
          if (restored) {
            await restore(last);
          } else if (!cancelled) {
            // No renewable session → fall back to login, boundary closed.
            closeCredentialBoundary();
            setStatus("logged-out");
          }
        } catch {
          // A failed silent restore must leave the boundary CLOSED (the wrapper attaches
          // nothing) while we fall back to login — never a stale-issuer open boundary.
          closeCredentialBoundary();
          if (!cancelled) setStatus("logged-out");
        }
      } else if (!cancelled) {
        setStatus("logged-out");
      }
    })().catch(() => {
      closeCredentialBoundary();
      if (!cancelled) setStatus("logged-out");
    });

    return () => {
      cancelled = true;
      // Registration is ONE-TIME (`registeredRef` guards the effect body) and the provider
      // + its global fetch patch are a SINGLETON meant to live for the app's lifetime
      // (matching the old `ReactiveFetchManager.registerGlobally()`, which was never
      // reversed). So this cleanup intentionally does NOT (a) un-patch the global fetch, nor
      // (b) tear down the provider's proactive-refresh timers. Doing either would break
      // React StrictMode's dev setup→cleanup→setup probe: the SECOND setup returns early at
      // the `registeredRef` guard, so it would NOT re-install the wrapper or re-arm the
      // provider — leaving the global as the unauthenticated pristine fetch and the provider
      // torn down (the roborev finding). The proactive-refresh timers are visibility-gated
      // and bound to this singleton; a root-level SessionProvider unmounts only at full app
      // teardown, so not tearing them down here leaks nothing in practice. (A proper split
      // of one-time install from per-mount restore is a tracked follow-up.)
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
    // Open a PRELIMINARY boundary (WebID + issuer origins) BEFORE the profile read: the
    // profile fetch goes through the proactive-auth global fetch, and a PRIVATE profile
    // (or authenticated discovery doc) must be authenticated on its first request rather
    // than left public (the proactive wrapper does not reactively upgrade on a 401, unlike
    // the old manager). The WebID's own origin covers the profile doc in the common case;
    // the storage origins are added below once discovered.
    refreshAllowedOrigins(id, [], activeIssuerRef.current);
    let p: PodProfile;
    try {
      p = await fetchProfile(id);
    } catch (e) {
      // The boundary was opened before the (failed) profile read — close it so the wrapper
      // does not keep attaching the token for a session that never landed (the roborev
      // finding). The caller's catch then sets status logged-out.
      closeCredentialBoundary();
      throw e;
    }
    // Widen the boundary to this account's storage origins too, so the first authenticated
    // pod read (which the page fires immediately) is proactively authenticated.
    refreshAllowedOrigins(id, p.storages, activeIssuerRef.current);
    setWebId(id);
    setProfile(p);
    setActive(p.storages[0]);
    setStatus("logged-in");
  }, [refreshAllowedOrigins, closeCredentialBoundary]);

  /**
   * The shared back half of every login: run the code flow against the
   * resolved issuer, learn/confirm the WebID, load the profile, persist.
   * The popup MUST already be open (synchronously, by the caller).
   */
  const completeLogin = useCallback(
    async (issuer: string, knownWebId: string | undefined, silentFirst = false) => {
      setStatus("authenticating");
      // CLOSE the (possibly PRIOR account's) credential boundary BEFORE running the new
      // login's OIDC discovery/token requests. Otherwise, on an account switch, the old
      // session's allowed-origin set could still be active while `provider.login(newIssuer)`
      // fetches the new issuer — and if the new issuer's origin happens to be in the OLD
      // allow-list, those provider-internal OAuth requests could be upgraded with the OLD
      // account's DPoP token (the roborev finding). The new boundary is opened only AFTER
      // the new session lands. (The provider's own OAuth fetch is also issuer-scoped-bypassed
      // once issuerOriginRef is set, but clearing first removes the stale-account window.)
      closeCredentialBoundary();
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
        // cross-account read; this also frees the old partition.
        setWebId((prev) => {
          if (prev && prev !== id) readCache.clearWebId(prev);
          return id;
        });
        // Open a PRELIMINARY boundary (WebID + issuer origins) BEFORE the profile read so
        // a PRIVATE profile / authenticated discovery doc is authenticated on its first
        // request (the proactive wrapper does not reactively upgrade on a 401).
        refreshAllowedOrigins(id, [], issuer);
        const p = await fetchProfile(id);
        // Widen to this account's storage origins before the first authenticated pod read.
        refreshAllowedOrigins(id, p.storages, issuer);
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
        // Close the credential boundary on ANY failure after `provider.login()` may have
        // landed a live session + opened the boundary (e.g. a failed `fetchProfile`): leave
        // the wrapper attaching nothing while the UI reports logged-out (the roborev
        // finding).
        closeCredentialBoundary();
        setStatus("logged-out");
        throw e;
      }
    },
    [getController, refreshAllowedOrigins, closeCredentialBoundary],
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
      // Close the (possibly PRIOR account's) credential boundary up front: the smart-input
      // discovery below runs BEFORE completeLogin opens the new boundary, and on an account
      // switch the old boundary could otherwise attach the OLD account's token to the NEW
      // login target's WebID/issuer discovery request when they share an origin (the roborev
      // finding). The discovery read is public anyway.
      closeCredentialBoundary();
      try {
        // Resolve the smart input: WebID (deref → solid:oidcIssuer) or bare
        // issuer (OIDC discovery), through the PRISTINE credential-free fetch — a public
        // discovery read must never carry a session token (defense in depth alongside the
        // boundary close above).
        let issuer = opts?.issuer;
        let knownWebId: string | undefined;
        const target: LoginTarget = await resolveLoginInput(input, nativeFetch);
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
        closeCredentialBoundary();
        setStatus("logged-out");
        throw e;
      }
    },
    [completeLogin, getController, closeCredentialBoundary],
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
    // Close the credential boundary: a logged-out session must attach the token to
    // NOTHING. The provider's `matches` also guards, but clearing here is the explicit
    // boundary — the proactive-auth fetch reads this set fresh on its next request.
    allowedOriginsRef.current = new Set<string>();
    issuerOriginRef.current = new Set<string>();
    setWebId(undefined);
    setProfile(undefined);
    setActive(undefined);
    setStatus("logged-out");
    pendingWebIdRef.current = undefined;
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
