import { describe, it, expect } from "vitest";
import { IntegrationAuthError } from "./errors.js";
import {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  generatePkcePair,
  generateState,
  parseCallbackUrl,
} from "./oauth.js";
import type { OAuthAppConfig } from "./types.js";

const CFG: OAuthAppConfig = {
  clientId: "client-123",
  authorizationEndpoint: "https://platform.test/authorize",
  tokenEndpoint: "https://platform.test/token",
  scopes: ["read", "history"],
  tokenExchange: "public",
  extraAuthParams: { duration: "permanent" },
};

describe("generatePkcePair", () => {
  it("produces an RFC 7636 verifier and its S256 challenge", async () => {
    const { verifier, challenge } = await generatePkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Recompute the challenge independently.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const expected = Buffer.from(digest)
      .toString("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    expect(challenge).toBe(expected);
  });

  it("never repeats verifiers or state", async () => {
    const a = await generatePkcePair();
    const b = await generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(generateState()).not.toBe(generateState());
  });
});

describe("buildAuthorizationUrl", () => {
  it("carries client id, PKCE S256, scopes, state and per-app extras", () => {
    const url = new URL(
      buildAuthorizationUrl(CFG, {
        state: "st-1",
        challenge: "ch-1",
        redirectUri: "https://app.test/oauth-callback.html",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://platform.test/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("scope")).toBe("read history");
    expect(url.searchParams.get("state")).toBe("st-1");
    expect(url.searchParams.get("code_challenge")).toBe("ch-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("duration")).toBe("permanent"); // per-app extra
  });
});

describe("parseCallbackUrl", () => {
  const cb = (qs: string) => `https://app.test/oauth-callback.html?${qs}`;

  it("returns the code when state matches", () => {
    expect(parseCallbackUrl("spotify", cb("code=abc&state=st-1"), "st-1")).toEqual({
      code: "abc",
    });
  });

  it("rejects a state mismatch as possible CSRF", () => {
    expect(() => parseCallbackUrl("spotify", cb("code=abc&state=EVIL"), "st-1")).toThrowError(
      expect.objectContaining({ name: "IntegrationAuthError", reason: "state-mismatch" }),
    );
  });

  it("maps access_denied to a 'cancelled' auth error", () => {
    expect(() =>
      parseCallbackUrl("spotify", cb("error=access_denied&state=st-1"), "st-1"),
    ).toThrowError(expect.objectContaining({ reason: "cancelled" }));
  });
});

describe("exchangeCodeForToken", () => {
  const params = {
    code: "abc",
    verifier: "ver-1",
    redirectUri: "https://app.test/oauth-callback.html",
  };

  it("posts a form-encoded PKCE exchange and parses the token set", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      captured = { url: String(input), init: init ?? {} };
      return Response.json({ access_token: "tok", token_type: "Bearer", expires_in: 3600 });
    };

    const token = await exchangeCodeForToken("spotify", CFG, params, fetchImpl);

    expect(captured?.url).toBe("https://platform.test/token");
    const body = new URLSearchParams(String(captured?.init.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("ver-1");
    expect(body.get("client_id")).toBe("client-123");
    expect(token.accessToken).toBe("tok");
    expect(token.expiresAt).toBeGreaterThan(Date.now());
  });

  it("sends Basic auth with an empty secret when the platform wants it (Reddit)", async () => {
    let auth: string | null = null;
    const fetchImpl: typeof fetch = async (_input, init) => {
      auth = new Headers(init?.headers).get("authorization");
      return Response.json({ access_token: "tok", token_type: "bearer" });
    };
    await exchangeCodeForToken(
      "reddit",
      { ...CFG, basicAuthForToken: true },
      params,
      fetchImpl,
    );
    expect(auth).toBe(`Basic ${btoa("client-123:")}`);
  });

  it("routes through the proxy when the platform refuses secretless PKCE", async () => {
    let url = "";
    const fetchImpl: typeof fetch = async (input) => {
      url = String(input);
      return Response.json({ access_token: "tok" });
    };
    await exchangeCodeForToken(
      "github",
      { ...CFG, tokenExchange: "proxy", tokenProxyUrl: "https://proxy.test/github" },
      params,
      fetchImpl,
    );
    expect(url).toBe("https://proxy.test/github");
  });

  it("throws not-configured without a proxy URL in proxy mode", async () => {
    await expect(
      exchangeCodeForToken("github", { ...CFG, tokenExchange: "proxy" }, params),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof IntegrationAuthError && e.reason === "not-configured",
    );
  });

  it("maps a token-endpoint refusal to exchange-failed", async () => {
    const fetchImpl: typeof fetch = async () => new Response("nope", { status: 400 });
    await expect(
      exchangeCodeForToken("spotify", CFG, params, fetchImpl),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof IntegrationAuthError && e.reason === "exchange-failed",
    );
  });
});
