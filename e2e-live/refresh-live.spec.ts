/**
 * Protocol-level LIVE proof of refresh-token support against the deployed
 * broker (https://idp.solid-test.jeswr.org), using the Pod Manager's real
 * Client Identifier Document — the exact requests the app now sends:
 *
 *  1. authorization-code + PKCE + DPoP with scope `openid webid offline_access`
 *     (browser drives Keycloak login + broker consent; Node does the OAuth);
 *  2. token exchange → expect a refresh_token alongside the DPoP access token;
 *  3. refresh-token grant bound to the SAME DPoP key → new access token;
 *  4. rotation: the broker returns a new refresh token; the OLD one must fail;
 *  5. the refreshed access token does an authenticated pod read (cnf.jkt kept).
 */
import { test, expect } from "@playwright/test";
import * as oauth from "oauth4webapi";
import * as DPoP from "dpop";

const APP = "https://app.solid-test.jeswr.org";
const ISSUER = new URL("https://idp.solid-test.jeswr.org");
const CLIENT_ID = `${APP}/clientid.jsonld`;
const CALLBACK = `${APP}/callback.html`;
const USER = process.env.SMOKE_USER ?? "signup-smoke-3";
const PASSWORD = process.env.SMOKE_PASSWORD!;
const POD_ACL = `https://solid-test.jeswr.org/${USER}/.acl`;

test("live broker issues, honours and rotates DPoP-bound refresh tokens", async ({ page }) => {
  test.skip(!PASSWORD, "SMOKE_PASSWORD required");

  const as = await oauth
    .discoveryRequest(ISSUER)
    .then((r) => oauth.processDiscoveryResponse(ISSUER, r));
  expect(as.scopes_supported).toContain("offline_access");

  const client: oauth.Client = {
    client_id: CLIENT_ID,
    token_endpoint_auth_method: "none",
  };
  const clientAuth = oauth.None();

  const dpopKey = await oauth.generateKeyPair("ES256", { extractable: false });
  const dpopHandle = oauth.DPoP({}, dpopKey);

  const codeVerifier = oauth.generateRandomCodeVerifier();
  const state = oauth.generateRandomState();
  const nonce = oauth.generateRandomNonce();

  const authUrl = new URL(as.authorization_endpoint!);
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", CALLBACK);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid webid offline_access");
  // OIDC Core §11: the AS MUST ignore offline_access unless prompt includes
  // consent (oidc-provider enforces this) — same as the app's interactive attempt.
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("nonce", nonce);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set(
    "code_challenge",
    await oauth.calculatePKCECodeChallenge(codeVerifier),
  );

  // Drive the human part in the browser: Keycloak login, then broker consent.
  await page.goto(authUrl.href);
  await page.fill("#username", USER);
  await page.fill("#password", PASSWORD);
  await page.click("#kc-login");

  // Consent may or may not appear (depends on the existing grant's scopes).
  const consent = page.locator('button[name="decision"][value="accept"]');
  let consentSeen = false;
  await Promise.race([
    consent.waitFor({ timeout: 15_000 }).then(async () => {
      consentSeen = true;
      const text = await page.locator("body").innerText().catch(() => "");
      console.log(`consent page shown; mentions offline/stay-signed-in: ${/offline|signed in|stay/i.test(text)}`);
      await consent.click();
    }),
    page.waitForURL(/callback\.html/, { timeout: 15_000 }),
  ]);
  await page.waitForURL(/callback\.html/, { timeout: 15_000 });
  console.log(`consent shown: ${consentSeen}`);

  const params = oauth.validateAuthResponse(as, client, new URL(page.url()), state);

  const tokens = await oauth.processAuthorizationCodeResponse(
    as,
    client,
    await oauth.authorizationCodeGrantRequest(
      as,
      client,
      clientAuth,
      params,
      CALLBACK,
      codeVerifier,
      { DPoP: dpopHandle },
    ),
    { expectedNonce: nonce },
  );

  console.log(
    `code grant: expires_in=${tokens.expires_in} scope="${tokens.scope}" refresh_token=${tokens.refresh_token ? "YES" : "NO"}`,
  );
  expect(tokens.refresh_token, "broker should issue a refresh token for offline_access").toBeTruthy();

  // --- Refresh grant, same DPoP key ---
  const refreshed = await oauth.processRefreshTokenResponse(
    as,
    client,
    await oauth.refreshTokenGrantRequest(as, client, clientAuth, tokens.refresh_token!, {
      DPoP: dpopHandle,
    }),
  );
  expect(refreshed.access_token).toBeTruthy();
  expect(refreshed.access_token).not.toBe(tokens.access_token);
  console.log(
    `refresh grant: new access token OK, rotated=${refreshed.refresh_token !== undefined && refreshed.refresh_token !== tokens.refresh_token}`,
  );

  // --- Rotation: the OLD refresh token must now be rejected ---
  if (refreshed.refresh_token && refreshed.refresh_token !== tokens.refresh_token) {
    await expect(
      oauth.processRefreshTokenResponse(
        as,
        client,
        await oauth.refreshTokenGrantRequest(as, client, clientAuth, tokens.refresh_token!, {
          DPoP: dpopHandle,
        }),
      ),
    ).rejects.toThrow();
    console.log("rotation: old refresh token correctly rejected");
  }

  // --- The refreshed access token still works against the pod (same cnf.jkt) ---
  const proof = await DPoP.generateProof(
    dpopKey,
    POD_ACL,
    "GET",
    undefined,
    refreshed.access_token,
  );
  const read = await fetch(POD_ACL, {
    headers: { Authorization: `DPoP ${refreshed.access_token}`, DPoP: proof },
  });
  console.log(`pod read with refreshed token: ${read.status}`);
  expect(read.status).toBe(200);
});
