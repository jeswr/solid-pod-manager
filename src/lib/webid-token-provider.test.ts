/**
 * Refresh-token behaviour of the local `WebIdDPoPTokenProvider` port —
 * mirrors the upstream reactive-authentication PR #11/#12 test suite, driven
 * through this provider's WebID-first issuer resolution and the static
 * Client Identifier Document path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebIdDPoPTokenProvider } from "./webid-token-provider";
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
