/**
 * Refresh-token behaviour of the local `WebIdDPoPTokenProvider` port —
 * mirrors the upstream reactive-authentication PR #11/#12 test suite, driven
 * through this provider's WebID-first issuer resolution and the static
 * Client Identifier Document path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebIdDPoPTokenProvider } from "./webid-token-provider";
import {
  openPopupUnlessRenewable,
  PopupLoginController,
  type MessageEventLike,
  type OpenerWindowLike,
  type PopupWindowLike,
} from "./popup-login";
import {
  createFakeAuthorizationServer,
  type FakeAuthorizationServer,
} from "./test-utils/fake-authorization-server";
import { StructuredCloneSessionStore } from "./test-utils/structured-clone-session-store";

const WEBID = "https://pod.test/profile/card#me";
const CALLBACK = "https://app.test/callback.html";
const CLIENT_ID = "https://app.test/clientid.jsonld";

const profileTurtle = `<${WEBID}> <http://www.w3.org/ns/solid/terms#oidcIssuer> <https://as.test> .`;
const profileFetch: typeof fetch = async () =>
  new Response(profileTurtle, {
    status: 200,
    headers: { "content-type": "text/turtle" },
  });

let as: FakeAuthorizationServer;

function makeProvider() {
  const getCode = vi.fn((url: URL) => as.authorize(url));
  const provider = new WebIdDPoPTokenProvider(
    CALLBACK,
    getCode,
    async () => WEBID,
    { clientId: CLIENT_ID, profileFetch },
  );
  return { provider, getCode };
}

beforeEach(async () => {
  as = await createFakeAuthorizationServer({
    issueRefreshTokens: true,
    scopesSupported: ["openid", "webid", "offline_access"],
    grantTypesSupported: ["authorization_code", "refresh_token"],
  });
  vi.stubGlobal("fetch", as.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("WebIdDPoPTokenProvider refresh tokens", () => {
  it("requests offline_access and authenticates as the Client Identifier Document", async () => {
    const { provider } = makeProvider();

    const upgraded = await provider.upgrade(new Request("https://pod.test/private"));

    expect(upgraded.headers.get("Authorization")).toMatch(/^DPoP at-\d+$/);
    expect(as.authorizationRequests[0]?.scope).toBe("openid webid offline_access");
    expect(as.authorizationRequests[0]?.clientId).toBe(CLIENT_ID);
    expect(as.registrations).toHaveLength(0); // static client — no dynamic registration
  });

  it("a login already superseded BEFORE authorize never drives the popup and commits nothing (the #123 stale-popup guard)", async () => {
    // SECURITY (the #123 roborev HIGH): a login that is already superseded when it reaches the
    // authorize step must NOT call getCode (drive the shared popup) and must commit nothing. The
    // popup guard re-checks `stillCurrent` before every `#getCode` and aborts.
    const asWithWebId = await createFakeAuthorizationServer({
      issueRefreshTokens: true,
      scopesSupported: ["openid", "webid", "offline_access"],
      grantTypesSupported: ["authorization_code", "refresh_token"],
      webIdClaim: WEBID,
    });
    vi.stubGlobal("fetch", asWithWebId.fetch);
    const ISSUER = new URL("https://as.test").href;
    const store = new StructuredCloneSessionStore();
    const getCode = vi.fn((u: URL) => asWithWebId.authorize(u));
    const provider = new WebIdDPoPTokenProvider(CALLBACK, getCode, async () => WEBID, {
      clientId: CLIENT_ID,
      profileFetch,
      sessionStore: store,
    });
    await expect(
      provider.login(new URL("https://as.test"), { stillCurrent: () => false }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(getCode).not.toHaveBeenCalled(); // the shared popup was NEVER driven
    expect(store.peek(ISSUER)).toBeUndefined(); // nothing committed/persisted

    // Contrast: a NORMAL login commits — it pins (a later upgrade reuses the pin, no getWebId)
    // AND persists the credential.
    const store2 = new StructuredCloneSessionStore();
    const getWebId2 = vi.fn(async () => WEBID);
    const pinned = new WebIdDPoPTokenProvider(
      CALLBACK,
      vi.fn((u: URL) => asWithWebId.authorize(u)),
      getWebId2,
      { clientId: CLIENT_ID, profileFetch, sessionStore: store2 },
    );
    await pinned.login(new URL("https://as.test")); // default ⇒ commit + pin
    expect(store2.peek(ISSUER)).toBeDefined(); // persisted (the committed contrast)
    getWebId2.mockClear();
    await pinned.upgrade(new Request("https://pod.test/private"));
    expect(getWebId2).not.toHaveBeenCalled(); // pinned ⇒ no re-resolve
  });

  it("rolls back the commit when stillCurrent flips to false DURING the awaited persist (the #123 atomic commit)", async () => {
    // SECURITY (the #123 roborev HIGH): a logout / cancel / newer login can advance the
    // generation WHILE `#persist` is pending. The commit re-checks AFTER persist and rolls
    // back — evicting the caches AND compare-and-deleting the just-written refresh token — so a
    // credential persisted by a superseded login can never outlive it. We model "flips during
    // persist" with a predicate that stays true through the pre-commit checks and turns false
    // by the post-persist re-check; the persisted store must end EMPTY (rolled back).
    const asWithWebId = await createFakeAuthorizationServer({
      issueRefreshTokens: true,
      scopesSupported: ["openid", "webid", "offline_access"],
      grantTypesSupported: ["authorization_code", "refresh_token"],
      webIdClaim: WEBID,
    });
    vi.stubGlobal("fetch", asWithWebId.fetch);
    const ISSUER = new URL("https://as.test").href;
    const store = new StructuredCloneSessionStore();
    const provider = new WebIdDPoPTokenProvider(
      CALLBACK,
      vi.fn((u: URL) => asWithWebId.authorize(u)),
      async () => WEBID,
      { clientId: CLIENT_ID, profileFetch, sessionStore: store },
    );
    // Flip exactly at the persist boundary: stays TRUE through the popup-guard + pre-commit
    // checks (the store has not been written yet), and turns FALSE once `#persist` has written
    // the record (store.put ran) — i.e. the post-persist re-check sees the supersession.
    const stillCurrent = () => store.peek(ISSUER) === undefined;
    const { webId } = await provider.login(new URL("https://as.test"), { stillCurrent });
    expect(webId).toBe(WEBID); // authenticated…
    // …but the commit was ROLLED BACK after persist: the store holds NO credential.
    expect(store.peek(ISSUER)).toBeUndefined();
    expect(store.deletes).toContain(ISSUER); // the just-written record was deleted on rollback
  });

  it("a second concurrent same-issuer login does NOT join the first's in-flight work (the #123 no-join)", async () => {
    // SECURITY (the #123 roborev HIGH): an explicit `login()` must run its OWN authentication
    // and never JOIN an EARLIER login's still-pending in-flight session for the same issuer —
    // otherwise the newer login could adopt the older login's authenticated WebID and publish
    // the WRONG identity (the same-issuer / issuer-only account-switch leak). We observe "no
    // join" by each concurrent login invoking its OWN authorize (getCode) call: a JOIN would
    // share one authorize; a no-join runs two.
    const authorize = vi.fn((u: URL) => as.authorize(u));
    const provider = new WebIdDPoPTokenProvider(CALLBACK, authorize, async () => WEBID, {
      clientId: CLIENT_ID,
      profileFetch,
    });
    const [a, b] = await Promise.all([
      provider.login(new URL("https://as.test")),
      provider.login(new URL("https://as.test")),
    ]);
    expect(a.webId).toBeUndefined(); // (this top-level AS states no webid claim — fine)
    expect(b.webId).toBeUndefined();
    // Two independent authentications, not one joined in-flight session.
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("a same-issuer login to a DIFFERENT known WebID does NOT reuse the prior account's settled session (the #123 account-switch)", async () => {
    // SECURITY/UX (the #123 roborev MEDIUM): logged in as WebID A on issuer X, switching to
    // WebID B on the SAME issuer must NOT return A's cached settled session (which would then
    // trip the SessionProvider's mismatch check and log the user out) — `expectedWebId` forces a
    // FRESH authentication for B.
    const asA = await createFakeAuthorizationServer({
      issueRefreshTokens: true,
      scopesSupported: ["openid", "webid", "offline_access"],
      grantTypesSupported: ["authorization_code", "refresh_token"],
      webIdClaim: "https://pod.test/alice#me",
    });
    vi.stubGlobal("fetch", asA.fetch);
    const authorize = vi.fn((u: URL) => asA.authorize(u));
    const provider = new WebIdDPoPTokenProvider(CALLBACK, authorize, async () => WEBID, {
      clientId: CLIENT_ID,
      profileFetch,
    });
    // Settle a session as Alice.
    const a = await provider.login(new URL("https://as.test"));
    expect(a.webId).toBe("https://pod.test/alice#me");
    expect(authorize).toHaveBeenCalledTimes(1);

    // Switch to a DIFFERENT WebID (Bob) on the SAME issuer → must NOT reuse Alice's session; a
    // fresh authorize runs. (The fake AS still states Alice, but the point is the REUSE was
    // bypassed — a second authorize happened rather than returning the cached Alice session.)
    await provider.login(new URL("https://as.test"), {
      expectedWebId: "https://pod.test/bob#me",
    });
    expect(authorize).toHaveBeenCalledTimes(2); // fresh auth, NOT a reuse of Alice's session
  });

  it("a login DOES reuse a settled fresh session (the no-popup 'Continue as' path is preserved)", async () => {
    // The no-join guard must NOT regress the legitimate reuse of an already-SETTLED session: a
    // second login after the first SETTLED reuses it with NO new authorize (no popup).
    const authorize = vi.fn((u: URL) => as.authorize(u));
    const provider = new WebIdDPoPTokenProvider(CALLBACK, authorize, async () => WEBID, {
      clientId: CLIENT_ID,
      profileFetch,
    });
    await provider.login(new URL("https://as.test")); // first login settles a session
    expect(authorize).toHaveBeenCalledTimes(1);
    await provider.login(new URL("https://as.test")); // reuses the settled session
    expect(authorize).toHaveBeenCalledTimes(1); // NO second authorize — reused, not re-run
  });

  it("two concurrent same-issuer logins on an EXPIRED settled session DEDUP the refresh (no double-redeem of a rotating token; the #123)", async () => {
    // REGRESSION (the #123 roborev MEDIUM): the no-join guard must NOT make two concurrent
    // same-issuer logins each redeem the SAME (rotating) refresh token in parallel — that trips
    // invalid_grant / token-family reuse. A refresh renewal from a SETTLED session is the same
    // identity, so concurrent renewals must DEDUP onto one refresh request.
    const authorize = vi.fn((u: URL) => as.authorize(u));
    const provider = new WebIdDPoPTokenProvider(CALLBACK, authorize, async () => WEBID, {
      clientId: CLIENT_ID,
      profileFetch,
    });
    await provider.login(new URL("https://as.test")); // settle a session (one authorize)
    expect(authorize).toHaveBeenCalledTimes(1);
    const refreshesBefore = as.tokenRequests.filter(
      (r) => r.get("grant_type") === "refresh_token",
    ).length;

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3601 * 1000); // expire the settled access token

    // Two concurrent logins for the SAME issuer: they must share ONE refresh redemption.
    await Promise.all([
      provider.login(new URL("https://as.test")),
      provider.login(new URL("https://as.test")),
    ]);
    vi.useRealTimers();

    const refreshesAfter = as.tokenRequests.filter(
      (r) => r.get("grant_type") === "refresh_token",
    ).length;
    expect(refreshesAfter - refreshesBefore).toBe(1); // exactly ONE redemption, not two
    expect(authorize).toHaveBeenCalledTimes(1); // and no popup
  });

  it("refreshes an expired access token without user interaction", async () => {
    const { provider, getCode } = makeProvider();

    const first = await provider.upgrade(new Request("https://pod.test/a"));

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3601 * 1000);

    const second = await provider.upgrade(new Request("https://pod.test/b"));

    expect(getCode).toHaveBeenCalledTimes(1); // no new popup
    expect(second.headers.get("Authorization")).not.toBe(first.headers.get("Authorization"));
    expect(as.tokenRequests.at(-1)?.get("grant_type")).toBe("refresh_token");
  });

  it("adopts the rotated refresh token across consecutive renewals", async () => {
    const { provider, getCode } = makeProvider();

    await provider.upgrade(new Request("https://pod.test/a"));

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3601 * 1000);
    await provider.upgrade(new Request("https://pod.test/b"));

    vi.setSystemTime(Date.now() + 3601 * 1000);
    await provider.upgrade(new Request("https://pod.test/c"));

    expect(getCode).toHaveBeenCalledTimes(1);
    const refreshes = as.tokenRequests.filter((r) => r.get("grant_type") === "refresh_token");
    expect(refreshes).toHaveLength(2);
    expect(refreshes[1]?.get("refresh_token")).not.toBe(refreshes[0]?.get("refresh_token"));
  });

  it("sends prompt=consent on the interactive attempt so strict servers honour offline_access (OIDC Core §11)", async () => {
    as = await createFakeAuthorizationServer({
      issueRefreshTokens: true,
      scopesSupported: ["openid", "webid", "offline_access"],
      enforceOfflineAccessConsent: true,
    });
    vi.stubGlobal("fetch", as.fetch);
    const { provider, getCode } = makeProvider();

    const first = await provider.upgrade(new Request("https://pod.test/a"));

    expect(first.headers.get("Authorization")).toMatch(/^DPoP at-\d+$/);
    expect(getCode).toHaveBeenCalledTimes(2); // silent attempt → login_required → interactive retry
    expect(as.authorizationRequests.at(-1)?.prompt).toBe("consent");

    // The strict server issued a refresh token, so expiry renews silently.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3601 * 1000);
    await provider.upgrade(new Request("https://pod.test/b"));

    expect(getCode).toHaveBeenCalledTimes(2); // no further interaction
    expect(as.tokenRequests.at(-1)?.get("grant_type")).toBe("refresh_token");
  });

  it("renews via the refresh grant when the attached token is invalidated (401 after upgrade)", async () => {
    const { provider, getCode } = makeProvider();

    const first = await provider.upgrade(new Request("https://pod.test/a"));

    // The resource server rejected the (unexpired) token: the manager calls
    // invalidate(rejected request), and the next upgrade must renew silently.
    await provider.invalidate(first);
    const second = await provider.upgrade(new Request("https://pod.test/b"));

    expect(getCode).toHaveBeenCalledTimes(1); // no new popup
    expect(second.headers.get("Authorization")).not.toBe(first.headers.get("Authorization"));
    expect(as.tokenRequests.at(-1)?.get("grant_type")).toBe("refresh_token");

    // A replay of the stale rejection must NOT invalidate the renewed session.
    const tokenRequestsBefore = as.tokenRequests.length;
    await provider.invalidate(first);
    const third = await provider.upgrade(new Request("https://pod.test/c"));
    expect(third.headers.get("Authorization")).toBe(second.headers.get("Authorization"));
    expect(as.tokenRequests.length).toBe(tokenRequestsBefore);
  });

  it("login(issuer) runs the flow against a KNOWN issuer and reports the webid claim", async () => {
    as = await createFakeAuthorizationServer({
      issueRefreshTokens: true,
      scopesSupported: ["openid", "webid", "offline_access"],
      grantTypesSupported: ["authorization_code", "refresh_token"],
      webIdClaim: WEBID,
    });
    vi.stubGlobal("fetch", as.fetch);
    // No WebID callback needed: the app resolved the issuer itself
    // (provider picker / bare-issuer input — a user with no WebID yet).
    const getCode = vi.fn((url: URL) => as.authorize(url));
    const provider = new WebIdDPoPTokenProvider(
      CALLBACK,
      getCode,
      async () => {
        throw new Error("getWebId must not be called for issuer-first login");
      },
      { clientId: CLIENT_ID, profileFetch },
    );

    const { webId } = await provider.login(new URL("https://as.test"));

    expect(webId).toBe(WEBID);
    expect(getCode).toHaveBeenCalledTimes(1);

    // The issuer is pinned: a later 401 upgrade reuses the session without
    // asking for a WebID or opening another popup.
    const upgraded = await provider.upgrade(new Request("https://pod.test/private"));
    expect(upgraded.headers.get("Authorization")).toMatch(/^DPoP at-\d+$/);
    expect(getCode).toHaveBeenCalledTimes(1);
  });

  it("login(issuer) reports no WebID when the ID token states none", async () => {
    const { provider } = makeProvider(); // fake AS without a webid claim; sub is "user"

    const { webId } = await provider.login(new URL("https://as.test"));

    expect(webId).toBeUndefined();
  });

  it("login(issuer) reuses the cached session on repeat logins (no second popup)", async () => {
    const { provider, getCode } = makeProvider();

    await provider.login(new URL("https://as.test"));
    await provider.login(new URL("https://as.test"));

    expect(getCode).toHaveBeenCalledTimes(1);
  });

  it("login(issuer) is interactive-first: no prompt=none request on an explicit login", async () => {
    // A strict server (oidc-provider semantics): prompt=none would bounce with
    // login_required. Interactive-first must never send it.
    as = await createFakeAuthorizationServer({
      issueRefreshTokens: true,
      scopesSupported: ["openid", "webid", "offline_access"],
      enforceOfflineAccessConsent: true,
    });
    vi.stubGlobal("fetch", as.fetch);
    const { provider, getCode } = makeProvider();

    await provider.login(new URL("https://as.test"));

    // ONE navigation, straight to the interactive URL — the visible
    // authorize → callback.html?error=login_required → authorize bounce is gone.
    expect(getCode).toHaveBeenCalledTimes(1);
    expect(as.authorizationRequests).toHaveLength(1);
    expect(as.authorizationRequests[0]?.prompt).toBe("consent"); // OIDC Core §11: offline_access needs consent
    expect(as.authorizationRequests[0]?.scope).toBe("openid webid offline_access");
  });

  it("login(issuer) keeps prompt=consent off when the server has no offline_access", async () => {
    as = await createFakeAuthorizationServer({
      scopesSupported: ["openid", "webid"],
    });
    vi.stubGlobal("fetch", as.fetch);
    const { provider, getCode } = makeProvider();

    await provider.login(new URL("https://as.test"));

    expect(getCode).toHaveBeenCalledTimes(1);
    expect(as.authorizationRequests[0]?.prompt).toBeNull(); // plain interactive request
    expect(as.authorizationRequests[0]?.scope).toBe("openid webid");
  });

  it("login(issuer, { silentFirst: true }) keeps the silent attempt for one-click re-login", async () => {
    as = await createFakeAuthorizationServer({
      issueRefreshTokens: true,
      scopesSupported: ["openid", "webid", "offline_access"],
      enforceOfflineAccessConsent: true,
    });
    vi.stubGlobal("fetch", as.fetch);
    const { provider, getCode } = makeProvider();

    await provider.login(new URL("https://as.test"), { silentFirst: true });

    // prompt=none first, login_required, interactive retry — the PR #13 shape.
    expect(getCode).toHaveBeenCalledTimes(2);
    expect(as.authorizationRequests[0]?.prompt).toBe("none");
    expect(as.authorizationRequests.at(-1)?.prompt).toBe("consent");
  });

  it("the 401-upgrade path stays silent-first (background re-auth must not force a login page)", async () => {
    as = await createFakeAuthorizationServer({
      issueRefreshTokens: true,
      scopesSupported: ["openid", "webid", "offline_access"],
      enforceOfflineAccessConsent: true,
    });
    vi.stubGlobal("fetch", as.fetch);
    const { provider, getCode } = makeProvider();

    await provider.upgrade(new Request("https://pod.test/private"));

    expect(getCode).toHaveBeenCalledTimes(2); // silent attempt → login_required → interactive retry
    expect(as.authorizationRequests[0]?.prompt).toBe("none");
  });

  it("falls back to a fresh authorization when the refresh grant fails", async () => {
    const { provider, getCode } = makeProvider();

    await provider.upgrade(new Request("https://pod.test/a"));

    as.activeRefreshTokens.clear(); // revoked server-side → invalid_grant

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3601 * 1000);

    const second = await provider.upgrade(new Request("https://pod.test/b"));

    expect(getCode).toHaveBeenCalledTimes(2); // re-authorized via the popup flow
    expect(second.headers.get("Authorization")).toMatch(/^DPoP at-\d+$/);
  });
});

describe("canRenewWithoutInteraction (the synchronous popup-avoidance probe)", () => {
  const ISSUER = new URL("https://as.test");

  it("is false before any session exists", () => {
    const { provider } = makeProvider();
    expect(provider.canRenewWithoutInteraction(ISSUER)).toBe(false);
  });

  it("is true while the cached session is fresh", async () => {
    const { provider } = makeProvider();
    await provider.login(ISSUER);
    expect(provider.canRenewWithoutInteraction(ISSUER)).toBe(true);
  });

  it("is true after expiry when a refresh token is held (the grant is a fetch, not a popup)", async () => {
    const { provider } = makeProvider();
    await provider.login(ISSUER);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3601 * 1000);

    expect(provider.canRenewWithoutInteraction(ISSUER)).toBe(true);
  });

  it("is false after expiry when no refresh token was issued", async () => {
    as = await createFakeAuthorizationServer({
      scopesSupported: ["openid", "webid"],
    });
    vi.stubGlobal("fetch", as.fetch);
    const { provider } = makeProvider();
    await provider.login(ISSUER);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3601 * 1000);

    expect(provider.canRenewWithoutInteraction(ISSUER)).toBe(false);
  });

  it("is false while the FIRST login is still in flight (unknown is not yes)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const getCode = vi.fn((url: URL) => gate.then(() => as.authorize(url)));
    const provider = new WebIdDPoPTokenProvider(CALLBACK, getCode, async () => WEBID, {
      clientId: CLIENT_ID,
      profileFetch,
    });

    const pending = provider.login(ISSUER);
    await vi.waitFor(() => expect(getCode).toHaveBeenCalled());
    expect(provider.canRenewWithoutInteraction(ISSUER)).toBe(false);

    release();
    await pending;
    expect(provider.canRenewWithoutInteraction(ISSUER)).toBe(true);
  });

  it("turns false again when a rejected refresh grant proves the cached token dead", async () => {
    let failPopup = false;
    const getCode = vi.fn((url: URL) =>
      failPopup
        ? Promise.reject(new DOMException("Sign-in was cancelled.", "AbortError"))
        : as.authorize(url),
    );
    const provider = new WebIdDPoPTokenProvider(CALLBACK, getCode, async () => WEBID, {
      clientId: CLIENT_ID,
      profileFetch,
    });
    await provider.login(ISSUER);

    as.activeRefreshTokens.clear(); // revoked server-side
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3601 * 1000);
    expect(provider.canRenewWithoutInteraction(ISSUER)).toBe(true); // honestly believed

    // The refresh grant is rejected AND the code-flow fallback fails too
    // (the user dismisses the recovered popup).
    failPopup = true;
    await expect(provider.login(ISSUER)).rejects.toMatchObject({ name: "AbortError" });

    // The dead refresh token was dropped in place: the probe no longer
    // promises a popup-free renewal, so the next click opens one synchronously.
    expect(provider.canRenewWithoutInteraction(ISSUER)).toBe(false);
  });
});

// ── Click path: the app's click-handler wiring, minus React ─────────────────
//
// These four are the maintainer's regression tests for "Continue as opens an
// unnecessary about:blank popup": the click handler must consult the
// synchronous probe BEFORE window.open, and only ever recover a wrong YES via
// the blocked-popup affordance (fresh activation), never a raw open.

const APP_ORIGIN = "https://app.test";

class ClickFakePopup implements PopupWindowLike {
  closed = false;
  urls: string[] = [];
  close(): void {
    this.closed = true;
  }
  focus(): void {}
}

/**
 * A fake opener window whose popup completes the OAuth dance like the real
 * one: navigating it to an authorize URL drives the fake AS and posts the
 * /callback.html URL back with the app origin and OUR popup as the source —
 * so the controller's postMessage origin/source gate stays on the tested
 * path. `blockFreshOpens` models the popup blocker: fresh windows need user
 * activation; navigating an already-open named window does not.
 */
class FakeAuthWindow implements OpenerWindowLike {
  listeners = new Set<(event: MessageEventLike) => void>();
  popup: ClickFakePopup | null = null;
  opens: string[] = [];
  blockFreshOpens = false;
  readonly #onOpen?: (url: string) => void;

  constructor(onOpen?: (url: string) => void) {
    this.#onOpen = onOpen;
  }

  open(url?: string): PopupWindowLike | null {
    const href = url ?? "";
    this.opens.push(href);
    this.#onOpen?.(href);
    if (this.popup === null || this.popup.closed) {
      if (this.blockFreshOpens) return null;
      this.popup = new ClickFakePopup();
    }
    this.popup.urls.push(href);
    if (href !== "" && href !== "about:blank") this.#completeAuthorization(href, this.popup);
    return this.popup;
  }

  /** The "user agent" inside the popup: authorize, then postMessage back. */
  #completeAuthorization(url: string, popup: ClickFakePopup): void {
    // Macrotask: getCode registers its message listener within the current
    // microtask chain, before this fires.
    setTimeout(async () => {
      const callbackUrl = await as.authorize(new URL(url));
      this.emit({ origin: APP_ORIGIN, source: popup, data: callbackUrl });
    }, 0);
  }

  addEventListener(_: "message", listener: (event: MessageEventLike) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_: "message", listener: (event: MessageEventLike) => void): void {
    this.listeners.delete(listener);
  }
  emit(event: MessageEventLike): void {
    for (const l of [...this.listeners]) l(event);
  }
}

/** The exact wiring session-provider.tsx uses: controller as getCode, probe in the click. */
function makeClickHarness(onOpen?: (url: string) => void) {
  const win = new FakeAuthWindow(onOpen);
  const blocked: { resume: () => void; cancel: () => void }[] = [];
  const controller = new PopupLoginController({
    expectedOrigin: APP_ORIGIN,
    windowRef: win,
    onBlocked: (resume, cancel) => blocked.push({ resume, cancel }),
  });
  const provider = new WebIdDPoPTokenProvider(
    CALLBACK,
    (uri, signal) => controller.getCode(uri, signal),
    async () => WEBID,
    { clientId: CLIENT_ID, profileFetch },
  );
  /** The click handler shape: SYNCHRONOUS probe + open decision, then login. */
  const clickLogin = (issuer: string, opts?: { silentFirst?: boolean }) => {
    openPopupUnlessRenewable(controller, provider, issuer);
    return provider.login(new URL(issuer), opts);
  };
  return { win, controller, provider, clickLogin, blocked };
}

describe("click path: no popup when the session suffices", () => {
  beforeEach(async () => {
    as = await createFakeAuthorizationServer({
      issueRefreshTokens: true,
      scopesSupported: ["openid", "webid", "offline_access"],
      grantTypesSupported: ["authorization_code", "refresh_token"],
      webIdClaim: WEBID,
    });
    vi.stubGlobal("fetch", as.fetch);
  });

  it("a login click with a live cached session NEVER calls window.open", async () => {
    const { win, clickLogin } = makeClickHarness();
    await clickLogin("https://as.test"); // first sign-in: the popup path
    expect(win.opens).toEqual(["about:blank", expect.stringContaining("/authorize")]);

    const opensBefore = win.opens.length;
    // “Continue as” shape: silentFirst chip, but the session is live.
    const { webId } = await clickLogin("https://as.test", { silentFirst: true });

    expect(webId).toBe(WEBID); // the session resolved
    expect(win.opens).toHaveLength(opensBefore); // window.open never called again
    expect(as.authorizationRequests).toHaveLength(1); // and no authorize round-trip
  });

  it("a login click with only a refresh token uses the refresh grant — still no window.open", async () => {
    const { win, clickLogin } = makeClickHarness();
    await clickLogin("https://as.test");

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3601 * 1000); // access token expired; refresh token held

    const opensBefore = win.opens.length;
    const { webId } = await clickLogin("https://as.test", { silentFirst: true });

    expect(webId).toBe(WEBID);
    expect(win.opens).toHaveLength(opensBefore); // no popup: the grant is a fetch
    expect(as.tokenRequests.at(-1)?.get("grant_type")).toBe("refresh_token");
    expect(as.authorizationRequests).toHaveLength(1); // no second authorize navigation
  });

  it("a login click with neither opens the popup synchronously, before any await", async () => {
    const events: string[] = [];
    const { win, clickLogin } = makeClickHarness((url) => events.push(`window.open:${url}`));
    vi.stubGlobal("fetch", ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      events.push("network");
      return as.fetch(input, init);
    }) as typeof fetch);

    const pending = clickLogin("https://as.test");
    // User-activation ordering: window.open fired synchronously inside the
    // click, before anything else the login flow does (discovery, etc.).
    expect(events[0]).toBe("window.open:about:blank");

    const { webId } = await pending;
    expect(webId).toBe(WEBID);
    expect(events[0]).toBe("window.open:about:blank"); // still first after the dust settles
    expect(win.popup?.closed).toBe(true); // terminal response closed the popup
  });

  it("recovers a wrong yes-probe (refresh grant rejected) via the blocked-popup affordance", async () => {
    as = await createFakeAuthorizationServer({
      expiresIn: 0, // expired on arrival: the refresh token is all the probe has
      issueRefreshTokens: true,
      scopesSupported: ["openid", "webid", "offline_access"],
      grantTypesSupported: ["authorization_code", "refresh_token"],
      webIdClaim: WEBID,
    });
    vi.stubGlobal("fetch", as.fetch);
    const { win, clickLogin, blocked } = makeClickHarness();
    await clickLogin("https://as.test");

    as.activeRefreshTokens.clear(); // revoked server-side: the yes-probe is wrong
    win.blockFreshOpens = true; // by the time the grant fails, activation is spent
    const opensBefore = win.opens.length;

    const pending = clickLogin("https://as.test", { silentFirst: true });
    expect(win.opens).toHaveLength(opensBefore); // probe said yes → no popup on click

    // The refresh grant is rejected; the code-flow fallback's window.open is
    // blocked, so the flow lands in the onBlocked affordance (the alertdialog).
    await vi.waitFor(() => expect(blocked).toHaveLength(1));
    // The only window.open since the click is that blocked navigation attempt
    // — never a raw unactivated about:blank open.
    expect(win.opens.slice(opensBefore)).toEqual([expect.stringContaining("/authorize")]);

    // The affordance's button click IS the fresh activation resume() runs under.
    win.blockFreshOpens = false;
    blocked[0]!.resume();
    const { webId } = await pending;
    expect(webId).toBe(WEBID);
  });
});

// ── Persisted DPoP-bound refresh-token session: restore WITHOUT a window ─────
//
// The maintainer's goal: a returning user (in-memory state gone) restores via a
// refresh_token grant — a token-endpoint FETCH, never a popup/iframe. These
// model the page-reload boundary by building a SECOND provider over the SAME
// SessionStore + AS, with a getCode that THROWS if a popup is ever needed.

describe("persisted refresh-token session: restore without a window", () => {
  // The store is keyed by the canonical issuer URL (URL.href adds the slash).
  const ISSUER_HREF = new URL("https://as.test").href;
  /** A getCode that fails the test if any authorize navigation is attempted. */
  const noPopup = vi.fn(async (): Promise<string> => {
    throw new Error("no popup may open during a refresh-grant restore");
  });

  function makeProviderWith(
    store: StructuredCloneSessionStore,
    getCode: typeof noPopup = noPopup,
  ) {
    return new WebIdDPoPTokenProvider(CALLBACK, getCode, async () => WEBID, {
      clientId: CLIENT_ID,
      profileFetch,
      sessionStore: store,
    });
  }

  beforeEach(async () => {
    as = await createFakeAuthorizationServer({
      issueRefreshTokens: true,
      scopesSupported: ["openid", "webid", "offline_access"],
      grantTypesSupported: ["authorization_code", "refresh_token"],
      webIdClaim: WEBID,
    });
    vi.stubGlobal("fetch", as.fetch);
    noPopup.mockClear();
  });

  it("persists the DPoP-bound refresh token + key on login, but NEVER the access token", async () => {
    const store = new StructuredCloneSessionStore();
    const getCode = vi.fn((url: URL) => as.authorize(url));
    const provider = new WebIdDPoPTokenProvider(CALLBACK, getCode, async () => WEBID, {
      clientId: CLIENT_ID,
      profileFetch,
      sessionStore: store,
    });

    await provider.login(new URL("https://as.test"));

    const persisted = store.peek(ISSUER_HREF);
    expect(persisted?.refreshToken).toMatch(/^rt-/);
    expect(persisted?.webId).toBe(WEBID);
    expect(persisted?.dpopKey.privateKey.extractable).toBe(false);
    // The access token is short-lived and must never be written to storage.
    expect(persisted && "accessToken" in persisted).toBe(false);
    expect(JSON.stringify({ ...persisted, dpopKey: undefined })).not.toContain("at-");
  });

  it("restores a returning user via the refresh grant — no popup, no authorize round-trip", async () => {
    const store = new StructuredCloneSessionStore();
    const getCode = vi.fn((url: URL) => as.authorize(url));
    const first = makeProviderWith(store, getCode as unknown as typeof noPopup);
    await first.login(new URL("https://as.test")); // original login (one authorize)
    expect(as.authorizationRequests).toHaveLength(1);

    // A fresh provider models the reload: in-memory maps + DPoP key are gone.
    const reloaded = makeProviderWith(store);
    const restored = await reloaded.restoreIssuer(new URL("https://as.test"));

    expect(restored).toEqual({ webId: WEBID });
    expect(noPopup).not.toHaveBeenCalled(); // NO window opened
    expect(as.authorizationRequests).toHaveLength(1); // still just the original
    expect(as.tokenRequests.at(-1)?.get("grant_type")).toBe("refresh_token");

    // The restored session is live: a 401 upgrade now works with no interaction.
    const upgraded = await reloaded.upgrade(new Request("https://pod.test/private"));
    expect(upgraded.headers.get("Authorization")).toMatch(/^DPoP at-\d+$/);
    expect(noPopup).not.toHaveBeenCalled();
  });

  it("the restored DPoP key signs the refresh-grant proof (key continuity across the reload)", async () => {
    const store = new StructuredCloneSessionStore();
    const getCode = vi.fn((url: URL) => as.authorize(url));
    await makeProviderWith(store, getCode as unknown as typeof noPopup).login(
      new URL("https://as.test"),
    );

    const reloaded = makeProviderWith(store);
    await reloaded.restoreIssuer(new URL("https://as.test"));

    // The refresh request carried a DPoP proof (the AS only rotates a token for
    // a proof-bearing request); the grant succeeding proves the persisted key
    // signed it — the same key that minted the original token. A throwing
    // getCode never fired, so this was a pure fetch.
    expect(as.tokenRequests.at(-1)?.get("grant_type")).toBe("refresh_token");
    expect(noPopup).not.toHaveBeenCalled();
  });

  it("persists the ROTATED refresh token after restore (so a second reload still works)", async () => {
    const store = new StructuredCloneSessionStore();
    const getCode = vi.fn((url: URL) => as.authorize(url));
    await makeProviderWith(store, getCode as unknown as typeof noPopup).login(
      new URL("https://as.test"),
    );
    const original = store.peek(ISSUER_HREF)?.refreshToken;

    const reloaded = makeProviderWith(store);
    await reloaded.restoreIssuer(new URL("https://as.test"));

    const rotated = store.peek(ISSUER_HREF)?.refreshToken;
    expect(rotated).toBeDefined();
    expect(rotated).not.toBe(original); // rotation (RFC 9700) persisted

    // A SECOND reload restores from the rotated token, still no popup.
    const reloadedAgain = makeProviderWith(store);
    const restored = await reloadedAgain.restoreIssuer(new URL("https://as.test"));
    expect(restored).toEqual({ webId: WEBID });
    expect(noPopup).not.toHaveBeenCalled();
  });

  it("a dead refresh token (invalid_grant) clears the persisted session and opens NO window on restore", async () => {
    const store = new StructuredCloneSessionStore();
    const getCode = vi.fn((url: URL) => as.authorize(url));
    await makeProviderWith(store, getCode as unknown as typeof noPopup).login(
      new URL("https://as.test"),
    );
    expect(store.peek(ISSUER_HREF)).toBeDefined();

    as.activeRefreshTokens.clear(); // revoked server-side → invalid_grant

    const reloaded = makeProviderWith(store);
    const restored = await reloaded.restoreIssuer(new URL("https://as.test"));

    expect(restored).toBeUndefined(); // nothing restored
    expect(noPopup).not.toHaveBeenCalled(); // and crucially NO popup on restore
    expect(store.peek(ISSUER_HREF)).toBeUndefined(); // dead entry cleared
    expect(store.deletes).toContain(ISSUER_HREF);
  });

  it("a SUPERSEDED restore that FAILS does NOT delete the newer login's persisted credential (the #123 supersession-safe delete)", async () => {
    // SECURITY (the #123 roborev finding): a stale boot restore for account A that fails
    // (invalid_grant) must NOT clear the durable refresh token a NEWER same-issuer login (B)
    // just persisted. With `stillCurrent: () => false` the failure path skips the delete
    // entirely, so B's credential survives. A weakened guard (always delete) would wipe it.
    const store = new StructuredCloneSessionStore();
    const getCode = vi.fn((url: URL) => as.authorize(url));
    await makeProviderWith(store, getCode as unknown as typeof noPopup).login(
      new URL("https://as.test"),
    );
    const newerCredential = store.peek(ISSUER_HREF);
    expect(newerCredential).toBeDefined();

    as.activeRefreshTokens.clear(); // the STALE restore's grant will fail (invalid_grant)

    const reloaded = makeProviderWith(store);
    const restored = await reloaded.restoreIssuer(
      new URL("https://as.test"),
      () => false, // superseded by a newer login on the same issuer
    );

    expect(restored).toBeUndefined(); // nothing restored
    // The newer login's persisted credential SURVIVES — the superseded restore did not clear it.
    expect(store.peek(ISSUER_HREF)).toEqual(newerCredential);
    expect(store.deletes).not.toContain(ISSUER_HREF);
  });

  it("restoreIssuer is a no-op (undefined) when nothing was persisted", async () => {
    const store = new StructuredCloneSessionStore();
    const reloaded = makeProviderWith(store);
    expect(await reloaded.restoreIssuer(new URL("https://as.test"))).toBeUndefined();
    expect(noPopup).not.toHaveBeenCalled();
  });

  it("restoreIssuer with stillCurrent=false commits NOTHING in-memory AND drops the consumed token (the #123 supersession-safe commit)", async () => {
    // SECURITY (the #123 roborev HIGH + MEDIUM): a boot silent restore that RACES a newer login
    // must NOT commit the OLD account's session into the provider-wide caches / pin / scheduler.
    // AND — because the refresh grant inside `#restore` already CONSUMED + ROTATED the stored
    // refresh token — the now-DEAD old token must not be LEFT in the store (a later restore with
    // it would invalid_grant). So a superseded restore success: reports the WebID, commits
    // nothing in-memory, and ATOMICALLY compare-and-deletes the consumed token.
    const store = new StructuredCloneSessionStore();
    const getCode = vi.fn((url: URL) => as.authorize(url));
    await makeProviderWith(store, getCode as unknown as typeof noPopup).login(
      new URL("https://as.test"),
    );
    expect(store.peek(ISSUER_HREF)).toBeDefined();

    const reloaded = makeProviderWith(store);
    const restored = await reloaded.restoreIssuer(
      new URL("https://as.test"),
      () => false, // superseded ⇒ commit NOTHING in-memory
    );
    // The session WAS rebuilt (the refresh grant ran, the webId is reported) — only the in-memory
    // commit was skipped.
    expect(restored).toEqual({ webId: WEBID });
    expect(as.tokenRequests.at(-1)?.get("grant_type")).toBe("refresh_token");
    // The CONSUMED old token was dropped (compare-and-delete), so no dead credential is retained.
    expect(store.peek(ISSUER_HREF)).toBeUndefined();
    expect(store.deletes).toContain(ISSUER_HREF);
  });

  it("restoreIssuer DEFAULTS to committing (stillCurrent omitted) — normal restore reuses the issuer", async () => {
    // The default (always commit) preserves the normal restore behaviour: a later upgrade
    // reuses the pinned issuer + cached session with no WebID re-resolution and no popup.
    const store = new StructuredCloneSessionStore();
    const getCode = vi.fn((url: URL) => as.authorize(url));
    await makeProviderWith(store, getCode as unknown as typeof noPopup).login(
      new URL("https://as.test"),
    );
    const reloaded = makeProviderWith(store);
    expect(await reloaded.restoreIssuer(new URL("https://as.test"))).toEqual({ webId: WEBID });
    const upgraded = await reloaded.upgrade(new Request("https://pod.test/private"));
    expect(upgraded.headers.get("Authorization")).toMatch(/^DPoP at-\d+$/);
    expect(noPopup).not.toHaveBeenCalled();
  });

  it("forgetPersisted clears the stored session (logout)", async () => {
    const store = new StructuredCloneSessionStore();
    const getCode = vi.fn((url: URL) => as.authorize(url));
    const provider = makeProviderWith(store, getCode as unknown as typeof noPopup);
    await provider.login(new URL("https://as.test"));
    expect(store.peek(ISSUER_HREF)).toBeDefined();

    await provider.forgetPersisted(new URL("https://as.test"));
    expect(store.peek(ISSUER_HREF)).toBeUndefined();

    // After logout, a reload restores nothing (no silent revival of a logged-out
    // session) and opens no window.
    const reloaded = makeProviderWith(store);
    expect(await reloaded.restoreIssuer(new URL("https://as.test"))).toBeUndefined();
    expect(noPopup).not.toHaveBeenCalled();
  });

  it("forgetIssuer clears the IN-MEMORY session AND the pin AND persistence (the #123 full discard)", async () => {
    // SECURITY (the #123 roborev HIGH): a cancelled / mismatched login that already committed
    // must be FULLY discarded — not just persistence (`forgetPersisted`), which would leave the
    // session in `#sessions`/`#settledSessions` + the `#issuer` pin for silent reuse by the next
    // same-issuer login / upgrade. After `forgetIssuer`, an upgrade must RE-AUTHENTICATE (a new
    // getCode), proving the in-memory session + pin were cleared, and the store is empty.
    const store = new StructuredCloneSessionStore();
    const getCode = vi.fn((url: URL) => as.authorize(url));
    const provider = makeProviderWith(store, getCode as unknown as typeof noPopup);
    await provider.login(new URL("https://as.test"));
    expect(store.peek(ISSUER_HREF)).toBeDefined();
    expect(getCode).toHaveBeenCalledTimes(1);

    await provider.forgetIssuer(new URL("https://as.test"));
    expect(store.peek(ISSUER_HREF)).toBeUndefined(); // persistence cleared…

    // …and the in-memory session + pin are gone: an upgrade re-runs the full auth (a 2nd
    // getCode), which it would NOT do if a settled session / pin had survived.
    await provider.upgrade(new Request("https://pod.test/private"));
    expect(getCode).toHaveBeenCalledTimes(2);
  });

  it("an issuer-first login with no webid claim is not persisted (nothing to restore by WebID)", async () => {
    as = await createFakeAuthorizationServer({
      issueRefreshTokens: true,
      scopesSupported: ["openid", "webid", "offline_access"],
      grantTypesSupported: ["authorization_code", "refresh_token"],
      // no webIdClaim
    });
    vi.stubGlobal("fetch", as.fetch);
    const store = new StructuredCloneSessionStore();
    const getCode = vi.fn((url: URL) => as.authorize(url));
    const provider = new WebIdDPoPTokenProvider(
      CALLBACK,
      getCode,
      async () => {
        throw new Error("issuer-first: getWebId must not be called");
      },
      { clientId: CLIENT_ID, profileFetch, sessionStore: store },
    );

    const { webId } = await provider.login(new URL("https://as.test"));
    expect(webId).toBeUndefined();
    expect(store.peek(ISSUER_HREF)).toBeUndefined(); // not persisted
  });
});

// ── prompt=none ignored: NSS / Trinpod (non-compliant silent auth) ───────────
//
// Spec-compliant IdPs answer a prompt=none probe with an OIDC error
// (login_required / interaction_required / consent_required) when no session
// exists, and the classifier falls through to interactive login. NSS
// (solidweb.org, datapod.igrant.io) and Trinpod (trinpod.us/.eu) IGNORE
// prompt=none and serve their HTML login page at HTTP 200 with no OIDC error —
// so the popup lands on a NON-callback page (no `code`, no `error`). The silent
// path must reclassify that landing as an implicit interaction_required and
// fall through to the interactive retry, instead of hanging. Detected by
// RESPONSE SHAPE, never by hostname.

describe("silent prompt=none ignored by the server (NSS / Trinpod)", () => {
  beforeEach(async () => {
    as = await createFakeAuthorizationServer({
      ignoresPromptNone: true, // serves /login (200) instead of an OIDC error
      issueRefreshTokens: true,
      scopesSupported: ["openid", "webid", "offline_access"],
      grantTypesSupported: ["authorization_code", "refresh_token"],
      webIdClaim: WEBID,
    });
    vi.stubGlobal("fetch", as.fetch);
  });

  it("(a) reclassifies an HTML-login 200 on the silent path → interactive retry, no hang", async () => {
    const { provider, getCode } = makeProvider();

    // The 401-upgrade path is silent-first; the server ignores prompt=none.
    const upgraded = await provider.upgrade(new Request("https://pod.test/private"));

    // The login completed via the interactive retry rather than hanging.
    expect(upgraded.headers.get("Authorization")).toMatch(/^DPoP at-\d+$/);
    // Two getCode calls: the silent prompt=none probe, then the interactive
    // retry in the same window (NOT a thrown error, NOT a hang).
    expect(getCode).toHaveBeenCalledTimes(2);
    expect(as.authorizationRequests[0]?.prompt).toBe("none");
    expect(as.authorizationRequests.at(-1)?.prompt).not.toBe("none");
  });

  it("(d) gives up the silent attempt without opening a SECOND window (reuses the one popup)", async () => {
    // The click harness models the real popup: a non-callback landing keeps the
    // single named window open and the interactive retry re-navigates IT — the
    // provider never asks for an extra window on the silent give-up.
    const { win, clickLogin } = makeClickHarness();

    const { webId } = await clickLogin("https://as.test", { silentFirst: true });

    expect(webId).toBe(WEBID);
    // One about:blank open + the two authorize navigations (silent, then
    // interactive) — both into the SAME named window. No extra window churn,
    // and crucially no hang: the flow resolved.
    expect(win.opens[0]).toBe("about:blank");
    const authorizeOpens = win.opens.filter((u) => u.includes("/authorize"));
    expect(authorizeOpens).toHaveLength(2);
    expect(as.authorizationRequests[0]?.prompt).toBe("none");
    expect(as.authorizationRequests.at(-1)?.prompt).not.toBe("none");
  });
});

describe("silent prompt=none on a COMPLIANT server still classifies the OIDC error", () => {
  it("(b) a real login_required error still falls through to interactive (unchanged)", async () => {
    as = await createFakeAuthorizationServer({
      enforceOfflineAccessConsent: true, // prompt=none → error=login_required
      issueRefreshTokens: true,
      scopesSupported: ["openid", "webid", "offline_access"],
      webIdClaim: WEBID,
    });
    vi.stubGlobal("fetch", as.fetch);
    const { provider, getCode } = makeProvider();

    const upgraded = await provider.upgrade(new Request("https://pod.test/private"));

    expect(upgraded.headers.get("Authorization")).toMatch(/^DPoP at-\d+$/);
    expect(getCode).toHaveBeenCalledTimes(2); // silent → login_required → interactive
    expect(as.authorizationRequests[0]?.prompt).toBe("none");
    expect(as.authorizationRequests.at(-1)?.prompt).toBe("consent");
  });
});

describe("genuine interactive login landing on the IdP HTML is NOT reclassified", () => {
  it("(c) an interactive-first login does not treat its own authorize landing as a retry trigger", async () => {
    // A server that ignores prompt=none — but the explicit login never SENDS
    // prompt=none, so its single interactive authorize must complete normally:
    // exactly ONE getCode call, no spurious retry.
    as = await createFakeAuthorizationServer({
      ignoresPromptNone: true,
      issueRefreshTokens: true,
      scopesSupported: ["openid", "webid", "offline_access"],
      grantTypesSupported: ["authorization_code", "refresh_token"],
      webIdClaim: WEBID,
    });
    vi.stubGlobal("fetch", as.fetch);
    const { provider, getCode } = makeProvider();

    // login() is interactive-first by default (no prompt=none).
    const { webId } = await provider.login(new URL("https://as.test"));

    expect(webId).toBe(WEBID);
    expect(getCode).toHaveBeenCalledTimes(1); // ONE navigation, no reclassification
    expect(as.authorizationRequests).toHaveLength(1);
    expect(as.authorizationRequests[0]?.prompt).not.toBe("none");
  });
});
