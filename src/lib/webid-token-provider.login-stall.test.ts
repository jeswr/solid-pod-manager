// AUTHORED-BY Claude Sonnet 5
/**
 * login-stall.test.ts — regression for the interactive-login STALL
 * (P0.2 of the shared-logic review; AccessRadar bead suite-tracker-8575).
 *
 * THE BUG: `WebIdDPoPTokenProvider`'s own OIDC hops — discovery, DYNAMIC CLIENT
 * REGISTRATION, and the authorization-code token grant — were issued via
 * `#httpOptions()` WITHOUT `[oauth.customFetch]`, so oauth4webapi fell back to the
 * bare `fetch` identifier, which resolves LIVE to `globalThis.fetch` at call time.
 * In production that global is PATCHED by the app's proactive-attach transport
 * (`proactive-auth-fetch.ts`), whose credential boundary deliberately includes the
 * active ISSUER's origin (`computeAllowedOrigins` is called with `issuer`, and
 * `includeIssuerOrigin` defaults to true). So a provider-internal OIDC request that
 * the wrapper does NOT exempt re-enters `provider.upgrade()`, which single-flights
 * onto the very in-flight `#authenticate()` promise that ISSUED the request — a
 * circular await that hangs interactive login forever, after the WebID profile read
 * (pinned to the pristine fetch, so it succeeds) and BEFORE the OIDC popup ever
 * opens. No /authorize hop, no popup, no error.
 *
 * THE UNCOVERED HOLE this test exercises: the wrapper's `isProviderOAuthRequest`
 * heuristic DOES exempt the two provider-internal calls it can recognise — the
 * discovery GET (a `/.well-known/` path) and the token POST (carries a `DPoP`
 * proof header) — but NOT a DYNAMIC CLIENT REGISTRATION POST: it lands on an
 * arbitrary registration-endpoint path and carries no `DPoP` header, so the
 * heuristic lets it through to `upgrade()`. To force that hole the mock OP here
 * uses dynamic client registration (the provider is built with NO `clientId`), and
 * the liveness gate is left deliberately OPEN (`canAttachNonInteractively: () =>
 * true`) so the test isolates the transport pin as the thing that closes the hole —
 * NOT the wrapper heuristic, which the fix must not depend on.
 *
 * THE FIX under test: every oauth4webapi call is pinned to an out-of-loop fetch via
 * `[oauth.customFetch]` (`oauthFetch`, defaulting to `profileFetch`); the Pod
 * Manager wires both to the pristine `native-fetch.ts` snapshot. So none of the
 * provider's own OIDC traffic can ride the patched global back into `upgrade()`.
 *
 * The test rebuilds the production wiring: the REAL app-local proactive wrapper
 * (`makeProactiveAuthFetch`) patched over `globalThis.fetch` (recording every URL
 * that rides it), a REAL provider, and an in-test mock OP (the shared
 * `createFakeAuthorizationServer` for the issuer origin + a local pod origin). The
 * pod-root probe is RACED against a 4 s deadline so the pre-fix deadlock fails fast
 * with a descriptive error instead of a silent test timeout. (Reverting the source
 * fix — dropping `[oauth.customFetch]` from `#httpOptions` — reproduces the stall:
 * the DCR POST rides the patched global and the probe never resolves.)
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakeAuthorizationServer,
  type FakeAuthorizationServer,
} from "./test-utils/fake-authorization-server";
import { computeAllowedOrigins, makeProactiveAuthFetch } from "./proactive-auth-fetch";
import {
  WebIdDPoPTokenProvider,
  type WebIdDPoPTokenProviderOptions,
} from "./webid-token-provider";

// The issuer origin is fixed by the shared fake OP.
const ISSUER = "https://as.test";
// A SEPARATE pod origin. Production's resource boundary still includes the issuer
// origin (see the header note), so a provider-internal OIDC call to `as.test` is
// inside the credential boundary — the condition under which the bug bites.
const POD_ROOT = "https://pod.test/";
const WEBID_DOC = "https://pod.test/profile/card";
const WEBID = `${WEBID_DOC}#me`;
const CALLBACK = "https://app.test/callback.html";

const PROFILE_TURTLE = `
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix pim: <http://www.w3.org/ns/pim/space#> .
<${WEBID}> solid:oidcIssuer <${ISSUER}> ;
  pim:storage <${POD_ROOT}> .
`;

/** What the mock world records, for the assertions. */
interface Recorded {
  /** Every URL that reached the PRISTINE (base) fetch. */
  baseUrls: string[];
  /** Every URL that went through the PATCHED global fetch wrapper. */
  patchedUrls: string[];
  /** Authorization header seen by the pod-root probe, if any. */
  podAuthorization: string | null;
  /** Every authorization URL handed to getCode (the "popup"). */
  authorizeHops: URL[];
}

/**
 * The pristine mock world: the pod origin (WebID profile + the pod-root probe) is
 * served here directly; every issuer-origin request is delegated to the shared fake
 * OP (`createFakeAuthorizationServer`) which serves discovery + JWKS + dynamic
 * client registration + the token endpoint with a real ES256-signed id_token. Any
 * unexpected URL fails loudly (a 500) so a routing regression can't silently pass.
 */
function makeMockWorld(as: FakeAuthorizationServer): {
  baseFetch: typeof fetch;
  recorded: Recorded;
} {
  const recorded: Recorded = {
    baseUrls: [],
    patchedUrls: [],
    podAuthorization: null,
    authorizeHops: [],
  };
  const baseFetch: typeof fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    recorded.baseUrls.push(request.url);
    const url = new URL(request.url);

    if (request.url === WEBID_DOC || request.url === WEBID) {
      return new Response(PROFILE_TURTLE, {
        status: 200,
        headers: { "content-type": "text/turtle" },
      });
    }
    if (request.url === POD_ROOT) {
      recorded.podAuthorization = request.headers.get("Authorization");
      return new Response(null, { status: 200 });
    }
    if (url.origin === ISSUER) {
      // Discovery / JWKS / dynamic client registration / token — the fake OP.
      return as.fetch(request);
    }
    return new Response(`unexpected request in mock world: ${request.url}`, {
      status: 500,
    });
  };
  return { baseFetch, recorded };
}

/**
 * Run the production login wiring end-to-end over the mock world and return what was
 * recorded. `providerOptions` supplies the fetch-pinning under test.
 */
async function runLoginFlow(
  providerOptions: (baseFetch: typeof fetch) => WebIdDPoPTokenProviderOptions,
): Promise<Recorded> {
  const as = await createFakeAuthorizationServer({ webIdClaim: WEBID });
  const { baseFetch, recorded } = makeMockWorld(as);

  const getCode = async (authorizationUrl: URL): Promise<string> => {
    recorded.authorizeHops.push(authorizationUrl);
    return as.authorize(authorizationUrl);
  };

  // NO clientId → the provider runs DYNAMIC CLIENT REGISTRATION, the OIDC hop the
  // wrapper's `isProviderOAuthRequest` heuristic does NOT exempt (the uncovered
  // hole this regression pins).
  const provider = new WebIdDPoPTokenProvider(CALLBACK, getCode, async () => WEBID, {
    allowInsecureLoopback: false,
    ...providerOptions(baseFetch),
  });

  // The REAL app-local proactive wrapper, wired exactly as `session-provider.tsx`
  // wires it: the resource boundary includes the pod + WebID + ISSUER origins; the
  // OAuth-bypass is scoped to the issuer origin; the pristine `baseFetch` carries the
  // authenticated path. The liveness gate is left OPEN so the test proves the
  // transport pin — not the heuristic — is what keeps the OIDC hops out of the loop.
  const allowedOrigins = computeAllowedOrigins({
    allowedOrigins: [POD_ROOT],
    webId: WEBID,
    issuer: ISSUER,
  });
  const issuerOrigins = computeAllowedOrigins({
    allowedOrigins: [ISSUER],
    includeWebIdOrigin: false,
    includeIssuerOrigin: false,
  });
  const wrapper = makeProactiveAuthFetch({
    provider,
    allowedOrigins: () => allowedOrigins,
    issuerOrigins: () => issuerOrigins,
    baseFetch,
    canAttachNonInteractively: () => true,
  });

  // Patch the global OURSELVES with a recording wrapper (so the test never leaks a
  // patched global past its finally block, and can record every URL that rides it).
  const recordingWrapper: typeof fetch = (input, init) => {
    recorded.patchedUrls.push(new Request(input as RequestInfo, init).url);
    return wrapper(input, init);
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = recordingWrapper;
  try {
    // The pod-root probe — `session-provider.tsx`'s first protected read. Pre-fix
    // this NEVER resolves (the DCR request re-enters upgrade() and awaits its own
    // login); the deadline turns that hang into a fast, descriptive failure.
    const probe = globalThis.fetch(POD_ROOT, { method: "HEAD" });
    const response = await Promise.race([
      probe,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "LOGIN STALL (login-stall regression): the pod-root probe did not " +
                  "complete — the provider's OIDC requests are re-entering the " +
                  "patched global fetch and deadlocking on the single-flight login. " +
                  "Pin them to the pristine fetch ([oauth.customFetch] / oauthFetch).",
              ),
            ),
          4000,
        ),
      ),
    ]);
    expect(response.status).toBe(200);
    return recorded;
  } finally {
    globalThis.fetch = realFetch;
  }
}

afterEach(() => {
  // No global mutation survives runLoginFlow's finally; nothing to reset here.
});

describe("interactive login vs the proactive patched fetch (login-stall P0.2)", () => {
  it("completes login + attaches the DPoP token when both profileFetch and oauthFetch are pinned (the app wiring)", async () => {
    const recorded = await runLoginFlow((baseFetch) => ({
      profileFetch: baseFetch,
      oauthFetch: baseFetch, // session-provider.tsx wires both to `nativeFetch`
    }));

    // The "popup" opened exactly once — pre-fix the stall struck BEFORE this, so
    // authorizeHops stayed empty.
    expect(recorded.authorizeHops).toHaveLength(1);
    expect(
      recorded.authorizeHops[0].origin + recorded.authorizeHops[0].pathname,
    ).toBe(`${ISSUER}/authorize`);

    // The pod probe went out DPoP-authenticated with the minted access token.
    expect(recorded.podAuthorization).toMatch(/^DPoP at-\d+$/);

    // The provider's own OIDC traffic (discovery + dynamic registration + token
    // grant) rode the PRISTINE fetch…
    expect(recorded.baseUrls).toContain(`${ISSUER}/.well-known/openid-configuration`);
    expect(recorded.baseUrls).toContain(`${ISSUER}/register`);
    expect(recorded.baseUrls).toContain(`${ISSUER}/token`);
    // …and NONE of it EVER rode the patched global — the re-entrancy that deadlocked.
    expect(
      recorded.patchedUrls.filter((u) => new URL(u).origin === ISSUER),
    ).toEqual([]);
    // The ONLY request through the patched global is the pod probe itself.
    expect(recorded.patchedUrls).toEqual([POD_ROOT]);
  });

  it("defaults oauthFetch to profileFetch, so pinning the profile read pins the OIDC hops too", async () => {
    // No explicit oauthFetch — the safe default chain (oauthFetch ?? profileFetch)
    // must keep the OIDC traffic out of the patched loop on its own. (This case
    // compiles against the PRE-fix source too, and there it deadlocks — the true
    // pre/post regression.)
    const recorded = await runLoginFlow((baseFetch) => ({
      profileFetch: baseFetch,
    }));
    expect(recorded.podAuthorization).toMatch(/^DPoP at-\d+$/);
    expect(
      recorded.patchedUrls.filter((u) => new URL(u).origin === ISSUER),
    ).toEqual([]);
    expect(recorded.patchedUrls).toEqual([POD_ROOT]);
  });
});
