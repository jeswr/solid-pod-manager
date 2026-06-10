/**
 * The shared end-user OAuth2 engine: authorization-code + PKCE (S256) in a
 * popup. Generic — adapters supply only endpoints/scopes/params via
 * `OAuthAppConfig`.
 *
 * Security posture (docs/integrations-catalog.md):
 * - tokens live in memory only (`token-store.ts`);
 * - the code is exchanged directly with the platform's token endpoint
 *   (public PKCE client), or with the adapter's declared token proxy when the
 *   platform refuses secretless exchanges — never anywhere else;
 * - `state` is checked on every callback; a mismatch is surfaced as a
 *   possible CSRF, never silently retried.
 *
 * The pure pieces (PKCE pair, URL building, callback parsing, code exchange)
 * are exported for vitest; only `authorize()` touches `window`.
 */
import { IntegrationAuthError } from "./errors.js";
import type { OAuthAppConfig, TokenSet } from "./types.js";

/** Where the popup lands; must exist in `public/` and postMessage back. */
export const OAUTH_CALLBACK_PATH = "/oauth-callback.html";

/** The message the callback page posts to its opener. */
export interface OAuthCallbackMessage {
  type: "pod-manager-oauth";
  url: string;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** RFC 7636 verifier (43–128 chars) + S256 challenge, via WebCrypto. */
export async function generatePkcePair(): Promise<PkcePair> {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  const verifier = base64url(bytes);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** Random `state` for CSRF binding. */
export function generateState(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** Build the platform's authorize URL for a PKCE request. */
export function buildAuthorizationUrl(
  cfg: OAuthAppConfig,
  params: { state: string; challenge: string; redirectUri: string },
): string {
  if (!cfg.clientId) throw new Error("buildAuthorizationUrl requires a clientId");
  const url = new URL(cfg.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", cfg.scopes.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const [k, v] of Object.entries(cfg.extraAuthParams ?? {})) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

/**
 * Parse the callback URL the popup bounced to. Verifies `state`, surfaces the
 * platform's `error` parameter, returns the authorization code.
 */
export function parseCallbackUrl(
  adapterId: string,
  callbackUrl: string,
  expectedState: string,
): { code: string } {
  const url = new URL(callbackUrl);
  const params = url.searchParams;
  const error = params.get("error");
  if (error === "access_denied") {
    throw new IntegrationAuthError(adapterId, "cancelled", "You declined the connection.");
  }
  if (error) {
    throw new IntegrationAuthError(adapterId, "exchange-failed", `The platform said: ${error}.`);
  }
  if (params.get("state") !== expectedState) {
    throw new IntegrationAuthError(
      adapterId,
      "state-mismatch",
      "The sign-in answer didn't match this request (possible cross-site forgery) — try again.",
    );
  }
  const code = params.get("code");
  if (!code) {
    throw new IntegrationAuthError(adapterId, "exchange-failed", "No authorization code returned.");
  }
  return { code };
}

interface TokenEndpointAnswer {
  access_token?: string;
  token_type?: string;
  refresh_token?: string;
  expires_in?: number;
}

/**
 * Exchange the code for tokens. Public clients post straight to the platform;
 * `tokenExchange: "proxy"` posts the same form to the maintainer's proxy
 * (which adds the client secret server-side and forwards the answer).
 *
 * @param fetchImpl - test-only override; **omit in production**.
 */
export async function exchangeCodeForToken(
  adapterId: string,
  cfg: OAuthAppConfig,
  params: { code: string; verifier: string; redirectUri: string },
  fetchImpl?: typeof fetch,
): Promise<TokenSet> {
  const endpoint = cfg.tokenExchange === "proxy" ? cfg.tokenProxyUrl : cfg.tokenEndpoint;
  if (!endpoint || !cfg.clientId) {
    throw new IntegrationAuthError(adapterId, "not-configured");
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: cfg.clientId,
    code_verifier: params.verifier,
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (cfg.basicAuthForToken) {
    // Reddit installed-app convention: Basic auth with an empty secret.
    headers.authorization = `Basic ${btoa(`${cfg.clientId}:`)}`;
  }
  const init: RequestInit = { method: "POST", headers, body: body.toString() };
  const res = fetchImpl ? await fetchImpl(endpoint, init) : await fetch(endpoint, init);
  if (!res.ok) {
    throw new IntegrationAuthError(
      adapterId,
      "exchange-failed",
      `Token exchange failed (${res.status}).`,
    );
  }
  const json = (await res.json()) as TokenEndpointAnswer;
  if (!json.access_token) {
    throw new IntegrationAuthError(adapterId, "exchange-failed", "No access token in the answer.");
  }
  return {
    accessToken: json.access_token,
    tokenType: json.token_type ?? "Bearer",
    refreshToken: json.refresh_token,
    expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined,
  };
}

/**
 * Run the full popup flow in the browser and return the token set.
 * Browser-only (uses `window`); the UI calls this for live-mode connects.
 */
export async function authorize(adapterId: string, cfg: OAuthAppConfig): Promise<TokenSet> {
  if (!cfg.clientId) throw new IntegrationAuthError(adapterId, "not-configured");
  const redirectUri = new URL(OAUTH_CALLBACK_PATH, window.location.href).toString();
  const { verifier, challenge } = await generatePkcePair();
  const state = generateState();
  const authUrl = buildAuthorizationUrl(cfg, { state, challenge, redirectUri });

  const popup = window.open(authUrl, "pod-manager-oauth", "popup,width=520,height=720");
  if (!popup) throw new IntegrationAuthError(adapterId, "popup-blocked");

  const callbackUrl = await waitForCallback(adapterId, popup);
  const { code } = parseCallbackUrl(adapterId, callbackUrl, state);
  return exchangeCodeForToken(adapterId, cfg, { code, verifier, redirectUri });
}

/** Resolve with the callback URL posted by the popup; reject if it closes first. */
function waitForCallback(adapterId: string, popup: Window): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as Partial<OAuthCallbackMessage> | undefined;
      if (data?.type !== "pod-manager-oauth" || typeof data.url !== "string") return;
      cleanup();
      popup.close();
      resolve(data.url);
    };
    const closedPoll = window.setInterval(() => {
      if (popup.closed) {
        cleanup();
        reject(
          new IntegrationAuthError(adapterId, "cancelled", "The sign-in window was closed."),
        );
      }
    }, 500);
    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(closedPoll);
    };
    window.addEventListener("message", onMessage);
  });
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
