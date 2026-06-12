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
