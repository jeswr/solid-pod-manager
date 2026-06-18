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
import { establishStillCurrent, runFencedPublish } from "@/lib/establish-fence";

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

/**
 * The in-flight login was SUPERSEDED before it could complete — a concurrent logout, a newer
 * login (account switch), or a `cancelLogin()` advanced the establish generation while this
 * login awaited (token grant / profile read). The login promise rejects with this rather than
 * resolving, so a caller awaiting `login()` never treats a superseded/cancelled login as
 * authenticated (the #123 roborev finding). It is a benign control-flow signal — the
 * superseding actor owns the session/UI — so callers may swallow it (the login simply did not
 * win); it carries no security failure.
 */
export class LoginSupersededError extends Error {
  constructor() {
    super("Login was superseded by a newer login, a logout, or a cancellation.");
    this.name = "LoginSupersededError";
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
  // The issuer of the CURRENTLY in-flight login establish, with its generation (the #123
  // roborev finding). DISTINCT from `activeIssuerRef`, which on an account switch still points
  // at the PREVIOUS logged-in issuer until the new login lands — so `cancelLogin` must forget
  // THIS in-flight issuer, not the previous account's. Set when a login passes its
  // post-`provider.login` fence (a credential MAY now be committed for it); cleared when that
  // login publishes, fails, or is superseded. Generation-tagged so a stale clear can't wipe it.
  const inFlightLoginRef = useRef<{ issuer: string; generation: number } | undefined>(undefined);
  // A SYNCHRONOUS "an interactive login is in its EARLY phase" marker (the #123 roborev MEDIUM):
  // set at `login`/`loginWithIssuer` START — before the smart-input discovery await and before
  // `completeLogin` sets `inFlightLoginRef` / the "authenticating" render commits — so a
  // `cancelLogin` during the discovery window is NOT no-op'd and genuinely supersedes the login.
  // Holds the login's generation; cleared when the login exits (publish / fail / supersede).
  const pendingLoginGenRef = useRef<number | undefined>(undefined);
  // The issuer the BOOT SILENT RESTORE is currently rebuilding, while its refresh grant is in
  // flight (the #123 roborev HIGH). A logout racing that restore has NEITHER `activeIssuerRef`
  // NOR `inFlightLoginRef` set for it, so logout must consult THIS ref to fully discard the
  // restoring issuer's durable credential — otherwise an explicit logout could leave a
  // restorable credential behind. Set before `restoreIssuer`; cleared when restore settles.
  const restoringIssuerRef = useRef<string | undefined>(undefined);
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
  // The MONOTONIC establish-session GENERATION — the credential-boundary fence (the
  // #123 roborev HIGH the vite siblings fixed). `completeLogin` / `restore` are async:
  // they arm the boundary, `await fetchProfile`, then RE-arm + publish. A concurrent
  // logout / new login (account switch) racing that await must SUPERSEDE the in-flight
  // establish so its resumed re-arm + publish cannot (a) re-arm against a logged-out
  // provider, (b) republish a stale session, (c) clobber the newer login's boundary, or
  // (d) resurrect a logged-out credential. Bumped at EVERY supersession point (each
  // login / loginWithIssuer / restore start, and logout); each establish snapshots it up
  // front and re-checks `establishStillCurrent` after the await, bailing WITHOUT clearing
  // on a mismatch (the superseding actor owns the boundary). See `establish-fence.ts`.
  const establishGenerationRef = useRef(0);
  const [status, setStatus] = useState<Status>("loading");
  // A synchronous mirror of `status` for the event handlers that must read it without a
  // setState updater (e.g. `cancelLogin` deciding whether a cancel is aborting an in-flight
  // login vs. racing a live session). Kept in sync on every render below.
  const statusRef = useRef<Status>("loading");
  statusRef.current = status;
  const [webId, setWebId] = useState<string>();
  const [profile, setProfile] = useState<PodProfile>();
  const [activeStorage, setActive] = useState<string>();
  const [recentAccounts, setRecentAccounts] = useState<RecentAccount[]>([]);
  const [blockedPopup, setBlockedPopup] = useState<BlockedPopup | null>(null);
  // A synchronous mirror of `blockedPopup` for `cancelLogin` (a stable callback) to read
  // whether a blocked-popup affordance is showing, without taking `blockedPopup` as a dep.
  const blockedPopupRef = useRef<BlockedPopup | null>(null);
  blockedPopupRef.current = blockedPopup;

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

  /**
   * Whether the establish identified by `establishGeneration` is STILL the current one —
   * the single fence consulted everywhere a login/restore touches shared state after an
   * await (the #123 roborev HIGH). The logic is the pure {@link establishStillCurrent};
   * this closure just supplies the live counter. A superseded establish (a logout / a newer
   * login advanced the counter) gets `false` and must touch NEITHER the boundary, the popup,
   * NOR the UI — the superseding actor owns them.
   */
  const stillCurrent = useCallback(
    (establishGeneration: number): boolean =>
      establishStillCurrent({
        establishGeneration,
        currentGeneration: establishGenerationRef.current,
      }),
    [],
  );

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

    // Snapshot the generation at the silent-restore IIFE's start, for the OUTER catch's
    // fence (the inner restore path bump-captures its own). A login/logout that advances the
    // counter while this IIFE runs means the IIFE is superseded — its outer-catch cleanup
    // must then NOT clobber the newer actor's boundary/UI (the #123 roborev HIGH).
    const restoreStartGeneration = establishGenerationRef.current;
    (async () => {
      await providerReadyRef.current;
      if (cancelled) return;

      // Load remembered accounts (these are public WebID→issuer pointers, safe to surface
      // regardless of an in-flight login).
      const accounts = new RecentAccounts();
      const remembered = accounts.list();
      if (!cancelled) setRecentAccounts(remembered);

      // SUPERSESSION GUARD (the #123 roborev HIGH): a user can start an explicit login WHILE
      // the auth runtime is still initialising (during the `await providerReadyRef` above) —
      // that login bumped the generation past `restoreStartGeneration`. The boot silent
      // restore must then YIELD ENTIRELY: it must NOT bump the generation again (which would
      // supersede the user's live login and make it stale), restore the remembered account
      // over it, or flip the UI to logged-out. Bail before either branch's establish work.
      if (!stillCurrent(restoreStartGeneration)) return;

      const last =
        typeof localStorage !== "undefined"
          ? localStorage.getItem(ACTIVE_WEBID_KEY)
          : null;
      if (last) {
        // FENCE: bump-capture this silent restore's generation at its TRUE start (before the
        // try / the `restoreIssuer` refresh-grant await) — hoisted ABOVE the try so BOTH the
        // success path AND the catch's failure cleanup can re-check it. A logout / a login
        // the user fires during silent restore advances the live counter past this snapshot,
        // so our resumed writes + publish bail, and our failure cleanup does not clobber the
        // newer actor's boundary (the #123 roborev HIGH). See `establish-fence.ts`.
        const establishGeneration = ++establishGenerationRef.current;
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
            // Mark the restoring issuer so a logout racing this restore fully discards its
            // durable credential (the #123 roborev HIGH); cleared in `finally` below.
            restoringIssuerRef.current = issuer;
            const provider = await providerReadyRef.current;
            const outcome = await provider
              // SUPERSESSION-SAFE COMMIT (the #123 roborev HIGH): pass the generation re-check
              // so the provider commits the restored session to its WIDE state (issuer-keyed
              // session/settled caches + the `#issuer` pin + persistence + the refresh
              // scheduler) ONLY if the boot restore is still current. A newer interactive login
              // that won the race — even on the SAME issuer — keeps ITS committed session, so a
              // late-resolving restore can never replace it and make B's next `upgrade()`
              // attach A's session.
              ?.restoreIssuer(new URL(issuer), () => stillCurrent(establishGeneration))
              .catch(() => undefined);
            // FENCE: a logout / login won the race during `restoreIssuer` — do NOT re-point
            // `activeIssuerRef` against this superseded restore (it would resurrect a
            // logged-out issuer / clobber a newer login). The superseding actor owns it.
            if (outcome && !cancelled && stillCurrent(establishGeneration)) {
              activeIssuerRef.current = issuer;
              restored = true;
            }
          }
          if (restored) {
            await restore(last, establishGeneration);
          } else if (!cancelled && stillCurrent(establishGeneration)) {
            // No renewable session → fall back to login, boundary closed — but ONLY if this
            // restore is STILL current. A login the user fired during `restoreIssuer` owns
            // the boundary + UI now; clearing here would wipe it (the #123 roborev HIGH,
            // failure-path half).
            closeCredentialBoundary();
            setStatus("logged-out");
          }
        } catch {
          // A failed silent restore must leave the boundary CLOSED (the wrapper attaches
          // nothing) while we fall back to login — never a stale-issuer open boundary. FENCE:
          // only when STILL current, so a login that superseded this restore (and owns the
          // boundary) is not clobbered by our failure cleanup (the #123 roborev HIGH).
          if (stillCurrent(establishGeneration)) {
            closeCredentialBoundary();
            if (!cancelled) setStatus("logged-out");
          }
        } finally {
          // The boot restore settled (success / fail / supersede) → it is no longer restoring,
          // so a later logout need not target it via `restoringIssuerRef`. The boot restore runs
          // once per page (this IIFE), so there is no re-entrancy to guard; a logout that ALREADY
          // ran while this was set discarded the credential — this just stops a future logout
          // double-targeting it.
          restoringIssuerRef.current = undefined;
        }
      } else if (!cancelled) {
        setStatus("logged-out");
      }
    })().catch(() => {
      // FENCE: only clean up if the silent-restore IIFE is STILL current. A login/logout
      // that superseded it owns the boundary + UI now (the #123 roborev HIGH, failure-path
      // half). On a runtime-init failure no login can have armed a boundary yet (login awaits
      // the runtime), so this is fail-safe; the guard makes the invariant explicit.
      if (stillCurrent(restoreStartGeneration)) {
        closeCredentialBoundary();
        if (!cancelled) setStatus("logged-out");
      }
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

  const restore = useCallback(async (id: string, establishGeneration: number) => {
    // Silent restore: read the (public) profile; if a private read later 401s
    // it re-auths silently while the IdP cookie lives.
    //
    // FENCE (the #123 roborev HIGH): `establishGeneration` was bump-captured by the caller
    // at the restore's start. A logout / new login racing the `await fetchProfile` below
    // advances the live counter; we re-check `establishStillCurrent` after the await and
    // bail WITHOUT re-arming the boundary or publishing a stale logged-in UI (the
    // superseding actor owns the boundary).
    //
    // Seed pendingWebIdRef FIRST: the reactive provider's WebID resolver reads
    // it on a 401 to know whose issuer to authenticate against. login() pins
    // the issuer directly, but after a hard navigation / reload (tokens are
    // in-memory only) only this restore path runs — without this, the first
    // private read throws "No WebID provided for login" and the page hangs on
    // its loading skeleton (e.g. an external app deep-linking into
    // /connected-apps/grant). See connected-apps e2e.
    pendingWebIdRef.current = id;
    // Delegate the security-critical fence-gated PUBLISH tail to the extracted, unit-tested
    // `runFencedPublish` (provisional-arm → read profile → FENCE → authoritative-arm →
    // publish): a logout / new login that advances the generation during the profile read
    // makes it BAIL without arming the authoritative boundary or publishing a stale logged-in
    // UI — and WITHOUT clearing (the superseding actor owns the boundary).
    try {
      await runFencedPublish<PodProfile>(establishGeneration, {
        liveGeneration: () => establishGenerationRef.current,
        // Open a PRELIMINARY boundary (WebID + issuer origins) BEFORE the profile read: the
        // profile fetch goes through the proactive-auth global fetch, and a PRIVATE profile
        // must be authenticated on its first request rather than left public (the proactive
        // wrapper does not reactively upgrade on a 401). Storage origins are added on arm.
        armProvisional: () => refreshAllowedOrigins(id, [], activeIssuerRef.current),
        readProfile: () => fetchProfile(id),
        armAuthoritative: (p) =>
          refreshAllowedOrigins(id, p.storages, activeIssuerRef.current),
        publish: (p) => {
          setWebId(id);
          setProfile(p);
          setActive(p.storages[0]);
          setStatus("logged-in");
        },
      });
    } catch (e) {
      // FENCE (the #123 roborev HIGH — failure-path half): only close the boundary if THIS
      // restore is STILL current. A logout / new login that superseded us during the
      // (failing) profile read already owns the boundary — closing it here would wipe the
      // newer login's freshly-armed boundary. When still current, close it so the wrapper
      // does not keep attaching the token for a session that never landed; the caller's
      // (likewise-fenced) catch then sets status logged-out.
      if (stillCurrent(establishGeneration)) closeCredentialBoundary();
      throw e;
    }
  }, [refreshAllowedOrigins, closeCredentialBoundary, stillCurrent]);

  /**
   * The shared back half of every login: run the code flow against the
   * resolved issuer, learn/confirm the WebID, load the profile, persist.
   * The popup MUST already be open (synchronously, by the caller).
   */
  const completeLogin = useCallback(
    async (
      issuer: string,
      knownWebId: string | undefined,
      establishGeneration: number,
      silentFirst = false,
    ) => {
      // ENTRY FENCE (the #123 roborev HIGH): `establishGeneration` was bump-captured by the
      // caller (`login` / `loginWithIssuer`) at this login's TRUE start — BEFORE its
      // smart-input discovery await. A SECOND login that superseded us during that await has
      // already advanced the live counter past our snapshot. Bail IMMEDIATELY, before ANY
      // side effect (no `setStatus`, no `closeCredentialBoundary`), so a stale resumed login
      // cannot clear the newer login's freshly-armed boundary or flip its UI back to
      // "authenticating". The superseding actor owns all of it. Throw so an awaiting caller's
      // `login()` REJECTS rather than resolving as a successful login (the roborev finding).
      if (!stillCurrent(establishGeneration)) throw new LoginSupersededError();
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
      // The awaits below each advance the counter if a logout / new login races them; we
      // re-check `stillCurrent` after each and bail WITHOUT re-arming/publishing/closing the
      // popup, so a superseded login never resurrects a logged-out credential, republishes a
      // stale identity, clobbers the newer login's boundary, or closes its popup.
      try {
        const provider = await providerReadyRef.current;
        if (!provider) throw new Error("Auth is not initialised yet");

        // FENCE (the #123 roborev HIGH): the auth runtime can still be INITIALISING when this
        // login starts, so we await it here. A logout / cancel / newer login that supersedes
        // us during THAT await must stop us BEFORE we start the OIDC/popup operation — running
        // `provider.login()` for a superseded flow would drive the shared popup + provider
        // state on behalf of a login the user already abandoned/replaced. Throw so the caller
        // rejects (a superseded login must not resolve as authenticated).
        if (!stillCurrent(establishGeneration)) throw new LoginSupersededError();

        let statedWebId: string | undefined;
        try {
          ({ webId: statedWebId } = await provider.login(new URL(issuer), {
            silentFirst,
            // SUPERSESSION-SAFE PIN (the #123 roborev HIGH): gate the provider-wide issuer pin
            // on this login still being current, so a logout / newer login that won the race
            // keeps ITS pin rather than this superseded login re-pinning to its (abandoned)
            // issuer.
            stillCurrent: () => stillCurrent(establishGeneration),
            // SAME-ISSUER ACCOUNT SWITCH (the #123 roborev MEDIUM): when the target WebID is
            // known, tell the provider so it reuses a settled session ONLY if it matches —
            // switching to a different WebID on the same issuer forces fresh auth instead of
            // returning the prior account's session (which would then trip the mismatch check).
            ...(knownWebId !== undefined ? { expectedWebId: knownWebId } : {}),
          }));
        } catch (e) {
          // The provider's STALE-POPUP guard aborts (`AbortError`) when this login was
          // superseded before it could drive the shared popup (the #123 roborev HIGH). Surface
          // that as the benign `LoginSupersededError` (swallowed by the UI) rather than a generic
          // login failure — the user's newer login / logout owns the flow.
          if (!stillCurrent(establishGeneration)) throw new LoginSupersededError();
          throw e;
        }
        // FENCE FIRST (the #123 roborev LOW): a logout / new login won the race during
        // `provider.login()` above. Check supersession BEFORE the WebID-mismatch check so a
        // superseded stale login that happens to return a mismatched `statedWebId` rejects with
        // the benign `LoginSupersededError` (swallowed by the UI) rather than a generic
        // "different WebID" failure that would surface a false error from a stale flow. Do NOT
        // touch shared state (the superseding actor owns the boundary/popup/UI).
        if (!stillCurrent(establishGeneration)) throw new LoginSupersededError();
        // FAIL-CLOSED IDENTITY CHECK (the vite Finding-1 invariant, the #123 roborev HIGH):
        // when the user asked to log in as a specific WebID (`knownWebId`) AND the OP stated a
        // WebID in the ID token (`statedWebId`), they MUST match. A mismatch means the OP
        // authenticated a DIFFERENT identity than requested. Never publish "logged in as B" off
        // a session the OP vouched as A. Throw before any publish (this is a REAL failure for a
        // still-current login, not a benign supersession).
        if (
          knownWebId !== undefined &&
          statedWebId !== undefined &&
          knownWebId !== statedWebId
        ) {
          throw new Error(
            "Login did not complete — the identity provider authenticated a different " +
              `WebID (${statedWebId}) than the one requested (${knownWebId}). For your ` +
              "security you were not logged in.",
          );
        }
        const id = knownWebId ?? statedWebId;
        if (!id) throw new NoWebIdFromProviderError(issuer);

        // A cached fresh session resolves login() without running the code flow — nothing
        // ever navigates the popup, so close the blank window the click handler opened. Done
        // ONLY when still current (above) so we never close a newer login's popup.
        getController().closeIfOpen();

        // From here the 401-upgrade path knows whose session this is, and
        // logout knows which issuer's persisted session to clear.
        pendingWebIdRef.current = id;
        activeIssuerRef.current = issuer;
        // Record THIS in-flight login's issuer + generation (the #123 roborev finding): a
        // credential MAY now be committed for `issuer`, so a `cancelLogin` racing the profile
        // read below must forget THIS issuer — not the previous account's (`activeIssuerRef`
        // was just overwritten, but on an account switch a cancel before this point would
        // otherwise target the prior account). Generation-tagged so it identifies this attempt.
        inFlightLoginRef.current = { issuer, generation: establishGeneration };

        // Delegate the fence-gated PUBLISH tail to the extracted, unit-tested
        // `runFencedPublish` (provisional-arm → read profile → FENCE → authoritative-arm →
        // persist → publish). A logout / new login (account switch) that advances the
        // generation during the profile read makes it BAIL — no authoritative arm, no
        // pointer write, no UI publish (so a superseded login never re-enables reads against
        // a logged-out/superseded provider, republishes a stale identity, or clobbers the
        // newer login). The WebID publish (with the account-switch cache-clear) runs INSIDE
        // `publish`, AFTER the post-profile fence, never before the profile read.
        const published = await runFencedPublish<PodProfile>(establishGeneration, {
          liveGeneration: () => establishGenerationRef.current,
          // Open a PRELIMINARY boundary (WebID + issuer origins) BEFORE the profile read so a
          // PRIVATE profile / authenticated discovery doc is authenticated on its first
          // request (the proactive wrapper does not reactively upgrade on a 401).
          armProvisional: () => refreshAllowedOrigins(id, [], issuer),
          readProfile: () => fetchProfile(id),
          armAuthoritative: (p) => refreshAllowedOrigins(id, p.storages, issuer),
          persist: (p) => {
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
          },
          publish: (p) => {
            // Account switch (logging into a different WebID without an explicit logout):
            // clear the read cache so the new account never renders the previous one's cached
            // models, then publish the WebID. Per-WebID keying already prevents a cross-account
            // read; the cache clear also frees the old partition.
            setWebId((prev) => {
              if (prev && prev !== id) readCache.clearWebId(prev);
              return id;
            });
            setProfile(p);
            setActive(p.storages[0]);
            setStatus("logged-in");
          },
        });
        // `runFencedPublish` returns false when a logout / new login superseded this login
        // during the profile read (it published nothing). Throw so the caller's `login()`
        // REJECTS rather than resolving as authenticated (the roborev finding). The catch
        // below is fenced, so for a superseded throw it performs NO cleanup (the superseder
        // owns the boundary) and just rethrows.
        if (!published) throw new LoginSupersededError();
        // Published successfully → this login is no longer in-flight (compare-and-swap so a
        // newer login that overwrote the ref is not cleared).
        if (inFlightLoginRef.current?.generation === establishGeneration) {
          inFlightLoginRef.current = undefined;
        }
      } catch (e) {
        // FENCE (the #123 roborev HIGH — failure-path half): a SUPERSEDED login that FAILS
        // must touch NOTHING shared — closing the popup, clearing the blocked-popup affordance,
        // clearing the boundary, or forcing the UI to logged-out would all wipe a NEWER login's
        // popup / freshly-armed boundary / session that won the race while we were in flight.
        // The superseding actor (the newer login / the logout) owns it all; we clean up ONLY
        // when STILL the current establish. The error still propagates to the caller either way
        // (the caller's own catch is likewise fenced).
        // This login attempt is EXITING (failure or supersession) → it is no longer in-flight.
        // Clear `inFlightLoginRef` by GENERATION compare-and-swap UNCONDITIONALLY (even on a
        // superseded exit, the roborev MEDIUM), so a stale `{issuer, generation}` can't linger
        // and cause a later `cancelLogin` to delete an already-superseded issuer's credential.
        // The compare-and-swap never clears a NEWER login's ref.
        if (inFlightLoginRef.current?.generation === establishGeneration) {
          inFlightLoginRef.current = undefined;
        }
        // Boundary/UI cleanup stays gated by `stillCurrent` (the superseding actor owns those).
        if (stillCurrent(establishGeneration)) {
          getController().closeIfOpen();
          setBlockedPopup(null);
          // Close the credential boundary on ANY failure after `provider.login()` may have
          // landed a live session + opened the boundary (e.g. a failed `fetchProfile`):
          // leave the wrapper attaching nothing while the UI reports logged-out.
          closeCredentialBoundary();
          setStatus("logged-out");
          // FULLY discard the issuer's session (the #123 roborev HIGH): `provider.login()` may
          // have already COMMITTED + persisted a session before this still-current failure
          // (e.g. the fail-closed WebID-mismatch check, or a failed `fetchProfile`). Clearing
          // only the boundary would leave that session in the provider's memory caches + the
          // persisted store for silent reuse by the next same-issuer login / upgrade. Discard it
          // in full (memory + pin + scheduler + persistence). Idempotent + fire-and-forget.
          void providerReadyRef.current
            ?.then((p) => p?.forgetIssuer(new URL(issuer)))
            .catch(() => {});
          void sessionStoreRef.current?.delete(issuer).catch(() => {});
        }
        throw e;
      }
    },
    [getController, refreshAllowedOrigins, closeCredentialBoundary, stillCurrent],
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
      //
      // WEBID-AWARE (the #123 roborev MEDIUM): pass the known target WebID (`input` IS the WebID
      // on the recent-account chip / known-issuer path) so the probe skips the popup ONLY when
      // the cached session is for THAT WebID. A same-issuer switch to a DIFFERENT WebID then
      // correctly OPENS the popup here (inside the user activation), since it will need fresh
      // interactive auth rather than reusing the prior account's session. If `input` is actually
      // a bare issuer URL it simply won't match any session.webId → popup opens (conservative).
      openPopupUnlessRenewable(getController(), providerSyncRef.current, opts?.issuer, input);
      setStatus("authenticating");
      // Close the (possibly PRIOR account's) credential boundary up front: the smart-input
      // discovery below runs BEFORE completeLogin opens the new boundary, and on an account
      // switch the old boundary could otherwise attach the OLD account's token to the NEW
      // login target's WebID/issuer discovery request when they share an origin (the roborev
      // finding). The discovery read is public anyway.
      closeCredentialBoundary();
      // FENCE: bump-capture THIS login's generation at its TRUE start (before the
      // smart-input discovery await), so a logout / a SECOND login racing the discovery or
      // the establish supersedes us (advances the live counter past this snapshot) and our
      // resumed establish bails. See `establish-fence.ts`.
      const establishGeneration = ++establishGenerationRef.current;
      // Mark this login cancellable from its TRUE start (the #123 roborev MEDIUM) so a cancel
      // during the discovery window below is not no-op'd.
      pendingLoginGenRef.current = establishGeneration;
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
        await completeLogin(issuer, knownWebId, establishGeneration, opts?.silentFirst ?? false);
      } catch (e) {
        // FENCE (the #123 roborev HIGH — failure-path half): only close the popup + clear the
        // boundary + force logged-out if THIS login is STILL current. A newer login / a logout
        // that superseded us owns the popup + boundary + UI; our failure cleanup must not
        // clobber any of it. The error still propagates to the caller regardless.
        if (stillCurrent(establishGeneration)) {
          getController().closeIfOpen();
          closeCredentialBoundary();
          setStatus("logged-out");
        }
        throw e;
      } finally {
        // This login left its early phase → clear the cancellable marker (compare-and-swap so a
        // newer login that set it is not cleared).
        if (pendingLoginGenRef.current === establishGeneration) {
          pendingLoginGenRef.current = undefined;
        }
      }
    },
    [completeLogin, getController, closeCredentialBoundary, stillCurrent],
  );

  const loginWithIssuer = useCallback(
    async (issuer: string) => {
      // SYNCHRONOUS popup decision — first statement, inside the user
      // activation (see login() above; a repeat provider-picker click with a
      // live session re-logs-in without a window).
      openPopupUnlessRenewable(getController(), providerSyncRef.current, issuer);
      // FENCE: bump-capture this login's generation at its start (see `login`).
      const establishGeneration = ++establishGenerationRef.current;
      pendingLoginGenRef.current = establishGeneration; // cancellable from the start
      try {
        await completeLogin(issuer, undefined, establishGeneration);
      } finally {
        if (pendingLoginGenRef.current === establishGeneration) {
          pendingLoginGenRef.current = undefined;
        }
      }
    },
    [completeLogin, getController],
  );

  const cancelLogin = useCallback(() => {
    // NO-OP WHEN NOTHING TO CANCEL (the #123 roborev MEDIUM): only act when there is an actual
    // cancellable login — a blocked-popup affordance, an in-flight establish (`inFlightLoginRef`),
    // or the authenticating status. A stray cancel (e.g. while a SILENT RESTORE is running, or
    // after a session is already live) must NOT bump the generation — doing so would supersede an
    // unrelated restore/login flow and strand the app in an inconsistent state. (Silent restore
    // is NOT an interactive login the user can cancel; its own generation must be left intact.)
    // "An interactive login is cancellable" = its EARLY-phase marker is set (from `login`'s true
    // start, covering the discovery window — the #123 roborev MEDIUM), OR `inFlightLoginRef` is
    // set (post-`provider.login`), OR the rendered status is authenticating. (Silent restore sets
    // none of these, so it is never cancelled.)
    const cancellingInFlight =
      pendingLoginGenRef.current !== undefined ||
      inFlightLoginRef.current !== undefined ||
      statusRef.current === "authenticating";
    if (!cancellingInFlight && blockedPopupRef.current === null) return;
    // FENCE: advance the establish generation FIRST, so the in-flight login the user is
    // CANCELLING is SUPERSEDED — a cancel landing AFTER `provider.login()` resolved but BEFORE
    // `fetchProfile()` returns would otherwise leave the establish "current" and go on to arm the
    // boundary + publish "logged-in", completing the very login just cancelled. Bumping makes the
    // resumed establish (and its failure cleanup) bail at the next fence. See `establish-fence.ts`.
    establishGenerationRef.current += 1;
    pendingLoginGenRef.current = undefined;
    setBlockedPopup(null);
    getController().cancel();
    if (cancellingInFlight) {
      // Forget any credential the in-flight login already PERSISTED before the cancel landed
      // (the #123 roborev finding): `provider.login()` commits + persists the refresh token
      // once it authenticates — if the user cancels DURING the later profile read, that durable
      // credential would otherwise outlive the cancelled login and silently restore the
      // backed-out account on the next load. Use the GENERATION-SCOPED `inFlightLoginRef`, NOT
      // `activeIssuerRef`: on an ACCOUNT SWITCH `activeIssuerRef` still points at the PREVIOUS
      // logged-in account until the new login lands, so forgetting it would wrongly delete the
      // previous account's credential. `inFlightLoginRef` is set only once THIS login passed its
      // post-`provider.login` fence (a credential may now exist for ITS issuer). Best-effort,
      // fire-and-forget, symmetric with logout.
      const inFlightIssuer = inFlightLoginRef.current?.issuer;
      inFlightLoginRef.current = undefined;
      if (inFlightIssuer) {
        // FULLY discard (the #123 roborev HIGH): `forgetIssuer` clears the in-memory caches
        // (`#sessions`/`#settledSessions`) + the `#issuer` pin + the scheduler + the persisted
        // credential — not just persistence — so a login the user CANCELLED after it committed
        // can never be reused from memory by the next same-issuer login / upgrade.
        void providerReadyRef.current
          ?.then((p) => p?.forgetIssuer(new URL(inFlightIssuer)))
          .catch(() => {});
        void sessionStoreRef.current?.delete(inFlightIssuer).catch(() => {});
      }
      closeCredentialBoundary();
      setStatus("logged-out");
    }
  }, [getController, closeCredentialBoundary]);

  const logout = useCallback(() => {
    // FENCE: advance the establish generation FIRST, so any in-flight login / silent
    // restore racing this logout is SUPERSEDED — its resumed re-arm + publish will see the
    // bumped counter and bail (it must not re-open the boundary or re-publish a logged-in
    // UI after the user signed out — the #123 roborev HIGH). See `establish-fence.ts`.
    establishGenerationRef.current += 1;
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
    // Also drop any IN-FLIGHT login's record AND any in-flight BOOT-RESTORE issuer — a logout
    // supersedes both (the generation bump above makes them bail), and their issuers must be
    // fully discarded too. The boot restore (the #123 roborev HIGH) has neither `activeIssuerRef`
    // nor `inFlightLoginRef` set while its refresh grant is in flight, so without
    // `restoringIssuerRef` an explicit logout could leave its durable credential behind.
    const inFlight = inFlightLoginRef.current;
    inFlightLoginRef.current = undefined;
    const restoring = restoringIssuerRef.current;
    restoringIssuerRef.current = undefined;
    // FULLY discard each issuer's session on sign-out (the #123 roborev HIGH): `forgetIssuer`
    // clears the provider's IN-MEMORY caches (`#sessions`/`#settledSessions`) + the `#issuer`
    // pin + the scheduler + the persisted credential — not just persistence (`forgetPersisted`),
    // which would leave the session in memory for a same-issuer login to silently reuse after an
    // explicit logout. The credential must not outlive an explicit sign-out in ANY form.
    // Fire-and-forget; also clears the store directly as defence in depth.
    const issuer = activeIssuerRef.current;
    activeIssuerRef.current = undefined;
    const targets = new Set(
      [issuer, inFlight?.issuer, restoring].filter(Boolean) as string[],
    );
    for (const target of targets) {
      void providerReadyRef.current
        ?.then((p) => p?.forgetIssuer(new URL(target)))
        .catch(() => {});
      void sessionStoreRef.current?.delete(target).catch(() => {});
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
