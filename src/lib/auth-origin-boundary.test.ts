// AUTHORED-BY Claude Opus 4.8
/**
 * Exhaustive tests for the CREDENTIAL-ORIGIN BOUNDARY (vendored from
 * `@jeswr/solid-elements`). This is the security boundary that decides where the user's
 * DPoP token may be attached — it must fail CLOSED on every malformed/foreign/cleartext
 * input. (The seam's own suite covers these too; we re-assert them here because PM now
 * depends on this exact behaviour for its credential safety.)
 */
import { describe, expect, it } from "vitest";
import {
  computeAllowedOrigins,
  htuOf,
  isOriginAllowed,
  isUseDpopNonceChallenge,
  parseWwwAuthenticate,
} from "./auth-origin-boundary.js";

const res = (wwwAuth?: string): Response =>
  new Response(null, {
    status: 401,
    headers: wwwAuth ? { "WWW-Authenticate": wwwAuth } : {},
  });

describe("computeAllowedOrigins — the credential boundary", () => {
  it("includes the WebID + issuer + storage origins by default (https)", () => {
    const set = computeAllowedOrigins({
      allowedOrigins: ["https://storage.example/alice/"],
      webId: "https://id.example/alice/profile/card#me",
      issuer: "https://idp.example/",
    });
    expect(set.has("https://storage.example")).toBe(true);
    expect(set.has("https://id.example")).toBe(true);
    expect(set.has("https://idp.example")).toBe(true);
  });

  it("DROPS a cleartext http: origin in production (no allowInsecureLoopback)", () => {
    const set = computeAllowedOrigins({
      allowedOrigins: ["http://storage.example/"], // non-loopback http
      webId: "https://id.example/alice#me",
    });
    expect(set.has("http://storage.example")).toBe(false);
    expect(set.has("https://id.example")).toBe(true);
  });

  it("DROPS a non-loopback http: origin even when allowInsecureLoopback is set", () => {
    const set = computeAllowedOrigins({
      allowedOrigins: ["http://evil.example/"],
      allowInsecureLoopback: true,
    });
    expect(set.has("http://evil.example")).toBe(false);
    expect(set.size).toBe(0);
  });

  it("allows a LOOPBACK http: origin only under allowInsecureLoopback (dev/test)", () => {
    const dev = computeAllowedOrigins({
      allowedOrigins: ["http://localhost:3099/alice/"],
      allowInsecureLoopback: true,
    });
    expect(dev.has("http://localhost:3099")).toBe(true);

    const prod = computeAllowedOrigins({
      allowedOrigins: ["http://localhost:3099/alice/"],
      allowInsecureLoopback: false,
    });
    expect(prod.has("http://localhost:3099")).toBe(false);
  });

  it("treats 127.0.0.1 and [::1] as loopback under the opt-in", () => {
    const set = computeAllowedOrigins({
      allowedOrigins: ["http://127.0.0.1:3000/", "http://[::1]:3000/"],
      allowInsecureLoopback: true,
    });
    expect(set.has("http://127.0.0.1:3000")).toBe(true);
    expect(set.has("http://[::1]:3000")).toBe(true);
  });

  it("can DROP the WebID / issuer origin defaults when disabled", () => {
    const set = computeAllowedOrigins({
      allowedOrigins: ["https://storage.example/"],
      webId: "https://id.example/alice#me",
      issuer: "https://idp.example/",
      includeWebIdOrigin: false,
      includeIssuerOrigin: false,
    });
    expect(set.has("https://storage.example")).toBe(true);
    expect(set.has("https://id.example")).toBe(false);
    expect(set.has("https://idp.example")).toBe(false);
  });

  it("fail-closed: skips an unparseable entry, never throws", () => {
    const set = computeAllowedOrigins({
      allowedOrigins: ["not a url", ""],
      webId: "::::not-a-url",
    });
    expect(set.size).toBe(0);
  });

  it("an EMPTY allow-list attaches the token to NOTHING", () => {
    expect(computeAllowedOrigins({}).size).toBe(0);
  });

  it("drops non-http(s) schemes (file:, data:, etc.)", () => {
    const set = computeAllowedOrigins({
      allowedOrigins: ["file:///etc/passwd", "data:text/plain,x"],
    });
    expect(set.size).toBe(0);
  });
});

describe("isOriginAllowed — the per-request gate", () => {
  const allowed = computeAllowedOrigins({ allowedOrigins: ["https://storage.example/"] });

  it("allows a request to an allowed origin (any path/query)", () => {
    expect(isOriginAllowed(allowed, "https://storage.example/alice/notes/1")).toBe(true);
    expect(isOriginAllowed(allowed, "https://storage.example/a?b=c#d")).toBe(true);
  });

  it("DENIES a request to a foreign origin (the leak boundary)", () => {
    expect(isOriginAllowed(allowed, "https://evil.example/")).toBe(false);
    expect(isOriginAllowed(allowed, "https://storage.example.evil.com/")).toBe(false);
  });

  it("DENIES a different port / scheme on the same host", () => {
    expect(isOriginAllowed(allowed, "https://storage.example:8443/")).toBe(false);
    expect(isOriginAllowed(allowed, "http://storage.example/")).toBe(false);
  });

  it("fail-closed: an unparseable request URL is never allowed", () => {
    expect(isOriginAllowed(allowed, "::::bad")).toBe(false);
  });

  it("an empty allow-set denies everything", () => {
    expect(isOriginAllowed(new Set(), "https://storage.example/")).toBe(false);
  });
});

describe("htuOf — RFC 9449 §4.2 htu claim", () => {
  it("strips query + fragment", () => {
    expect(htuOf("https://x.example/a/b?q=1#f")).toBe("https://x.example/a/b");
  });
  it("returns an unparseable input unchanged", () => {
    expect(htuOf("::::bad")).toBe("::::bad");
  });
});

describe("isUseDpopNonceChallenge — RFC 9449 §8 classification", () => {
  it("true for a pure DPoP use_dpop_nonce challenge", () => {
    expect(isUseDpopNonceChallenge(res('DPoP error="use_dpop_nonce"'))).toBe(true);
  });

  it("false when there is no WWW-Authenticate header", () => {
    expect(isUseDpopNonceChallenge(res())).toBe(false);
  });

  it("false for a DPoP invalid_token (stale token → must force-refresh)", () => {
    expect(isUseDpopNonceChallenge(res('DPoP error="invalid_token"'))).toBe(false);
  });

  it("false (force-refresh) when a DPoP challenge mixes nonce AND another error", () => {
    expect(
      isUseDpopNonceChallenge(
        res('DPoP error="use_dpop_nonce", DPoP error="invalid_token"'),
      ),
    ).toBe(false);
  });

  it("ignores a Bearer challenge that merely mentions the string", () => {
    expect(isUseDpopNonceChallenge(res('Bearer error="use_dpop_nonce"'))).toBe(false);
  });

  it("true when a Bearer invalid_token coexists with a DPoP use_dpop_nonce", () => {
    expect(
      isUseDpopNonceChallenge(
        res('Bearer error="invalid_token", DPoP error="use_dpop_nonce"'),
      ),
    ).toBe(true);
  });

  it("a DPoP challenge with no error is not a nonce signal", () => {
    expect(isUseDpopNonceChallenge(res("DPoP"))).toBe(false);
  });
});

describe("parseWwwAuthenticate — quote-aware multi-challenge parse", () => {
  it("splits multiple challenges and reads top-level params", () => {
    const out = parseWwwAuthenticate(
      'Bearer realm="x", error="invalid_token", DPoP algs="ES256"',
    );
    expect(out.map((c) => c.scheme)).toEqual(["Bearer", "DPoP"]);
    expect(out[0].params.get("realm")).toBe("x");
    expect(out[0].params.get("error")).toBe("invalid_token");
    expect(out[1].params.get("algs")).toBe("ES256");
  });

  it("tolerates BWS around '=' and a comma inside a quoted value", () => {
    const out = parseWwwAuthenticate('DPoP error = "a,b", algs="ES256, RS256"');
    expect(out[0].params.get("error")).toBe("a,b");
    expect(out[0].params.get("algs")).toBe("ES256, RS256");
  });

  it("resolves backslash escapes inside quoted values", () => {
    const out = parseWwwAuthenticate('DPoP error="say \\"hi\\""');
    expect(out[0].params.get("error")).toBe('say "hi"');
  });

  it("degrades safely on empty input", () => {
    expect(parseWwwAuthenticate("")).toEqual([]);
  });
});
