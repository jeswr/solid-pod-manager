/**
 * login-input.test.ts — the smart login input: ONE field accepting either a
 * WebID URL or a bare OIDC issuer URL.
 *
 * The bare-issuer case is the load-bearing one: a fresh human who just joined
 * a provider has NO WebID to type — entering the provider's address alone
 * must resolve (this exact case was the top finding of the live login E2E).
 */
import { describe, expect, it } from "vitest";
import {
  HOME_PROVIDER,
  LOGIN_PROVIDERS,
  NotALoginAddressError,
  PUBLIC_PROVIDERS,
  discoverIssuer,
  resolveLoginInput,
} from "./login-input";
import { InvalidWebIdError } from "./login-ux";

const WEBID = "https://pod.test/profile/card#me";
const ISSUER = "https://as.test";

const profileTurtle = `
  <${WEBID}> <http://www.w3.org/ns/solid/terms#oidcIssuer> <${ISSUER}> ;
    <http://xmlns.com/foaf/0.1/name> "Pat Test" .
`;

/** A fetch stub routing by URL; everything unrouted is a 404. */
function fakeFetch(
  routes: Record<string, () => Response>,
): typeof fetch {
  return async (input) => {
    const raw = typeof input === "string" ? input : new Request(input).url;
    const url = raw.split("#")[0]; // a fragment never reaches the server
    const handler = routes[url];
    return handler ? handler() : new Response("not found", { status: 404 });
  };
}

const turtle = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/turtle" } });
const oidcConfig = (issuer: string) =>
  new Response(
    JSON.stringify({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("resolveLoginInput", () => {
  it("resolves a WebID with a solid:oidcIssuer (the existing-user path)", async () => {
    const fetchImpl = fakeFetch({ [WEBID.split("#")[0]]: () => turtle(profileTurtle) });
    const target = await resolveLoginInput(WEBID, fetchImpl);
    expect(target).toMatchObject({
      kind: "webid",
      webId: WEBID,
      issuers: [ISSUER],
      displayName: "Pat Test",
    });
  });

  it("resolves a BARE issuer URL for a fresh human with no WebID", async () => {
    const fetchImpl = fakeFetch({
      [`${ISSUER}/.well-known/openid-configuration`]: () => oidcConfig(ISSUER),
    });
    const target = await resolveLoginInput(ISSUER, fetchImpl);
    expect(target).toEqual({ kind: "issuer", issuer: ISSUER });
  });

  it("resolves a bare issuer typed WITH a trailing slash", async () => {
    const fetchImpl = fakeFetch({
      [`${ISSUER}/.well-known/openid-configuration`]: () => oidcConfig(ISSUER),
    });
    const target = await resolveLoginInput(`${ISSUER}/`, fetchImpl);
    expect(target).toEqual({ kind: "issuer", issuer: ISSUER });
  });

  it("falls back to issuer discovery when the URL serves RDF without an oidcIssuer (e.g. a CSS root container)", async () => {
    // https://pod.test/ answers BOTH: parseable RDF (a root container) and
    // OIDC discovery — the RDF has no solid:oidcIssuer, so issuer wins.
    const fetchImpl = fakeFetch({
      "https://pod.test/": () => turtle("<https://pod.test/> a <http://www.w3.org/ns/ldp#Container> ."),
      "https://pod.test/.well-known/openid-configuration": () => oidcConfig("https://pod.test"),
    });
    const target = await resolveLoginInput("https://pod.test/", fetchImpl);
    expect(target).toEqual({ kind: "issuer", issuer: "https://pod.test" });
  });

  it("falls back to WebID deref when a path-bearing URL is not an issuer", async () => {
    const doc = WEBID.split("#")[0];
    const fetchImpl = fakeFetch({ [doc]: () => turtle(profileTurtle) });
    const target = await resolveLoginInput(WEBID, fetchImpl);
    expect(target.kind).toBe("webid");
  });

  it("tries WebID resolution for a bare origin that is not an issuer", async () => {
    // A WebID hosted at an origin root (rare but legal).
    const rootWebId = "https://me.test/";
    const fetchImpl = fakeFetch({
      [rootWebId]: () =>
        turtle(
          `<${rootWebId}> <http://www.w3.org/ns/solid/terms#oidcIssuer> <${ISSUER}> .`,
        ),
    });
    const target = await resolveLoginInput(rootWebId, fetchImpl);
    expect(target).toMatchObject({ kind: "webid", issuers: [ISSUER] });
  });

  it("throws InvalidWebIdError synchronously-detectable garbage", async () => {
    await expect(resolveLoginInput("not a url", fakeFetch({}))).rejects.toBeInstanceOf(
      InvalidWebIdError,
    );
  });

  it("throws NotALoginAddressError when the URL is neither a WebID nor an issuer", async () => {
    await expect(
      resolveLoginInput("https://nothing.test/profile#me", fakeFetch({})),
    ).rejects.toBeInstanceOf(NotALoginAddressError);
  });
});

describe("discoverIssuer", () => {
  it("returns the canonical issuer the server declares", async () => {
    const fetchImpl = fakeFetch({
      [`${ISSUER}/.well-known/openid-configuration`]: () => oidcConfig(ISSUER),
    });
    await expect(discoverIssuer(`${ISSUER}//`, fetchImpl)).resolves.toBe(ISSUER);
  });

  it("returns undefined for non-JSON, incomplete, and error responses", async () => {
    await expect(discoverIssuer(ISSUER, fakeFetch({}))).resolves.toBeUndefined();
    const htmlImpl = fakeFetch({
      [`${ISSUER}/.well-known/openid-configuration`]: () =>
        new Response("<html></html>", { status: 200 }),
    });
    await expect(discoverIssuer(ISSUER, htmlImpl)).resolves.toBeUndefined();
    const incompleteImpl = fakeFetch({
      [`${ISSUER}/.well-known/openid-configuration`]: () =>
        new Response(JSON.stringify({ issuer: ISSUER }), { status: 200 }),
    });
    await expect(discoverIssuer(ISSUER, incompleteImpl)).resolves.toBeUndefined();
  });

  it("returns undefined when fetch itself rejects", async () => {
    const failing: typeof fetch = async () => {
      throw new TypeError("network down");
    };
    await expect(discoverIssuer(ISSUER, failing)).resolves.toBeUndefined();
  });
});

describe("provider directory", () => {
  it("offers the home provider FIRST, then the public providers", () => {
    expect(LOGIN_PROVIDERS[0]).toBe(HOME_PROVIDER);
    expect(HOME_PROVIDER.home).toBe(true);
    expect(LOGIN_PROVIDERS.slice(1)).toEqual(PUBLIC_PROVIDERS);
    expect(PUBLIC_PROVIDERS.every((p) => !p.home)).toBe(true);
  });

  it("home provider has a default issuer and name (overridable at build time)", () => {
    expect(HOME_PROVIDER.issuer).toMatch(/^https:\/\//);
    expect(HOME_PROVIDER.name.length).toBeGreaterThan(0);
  });
});
