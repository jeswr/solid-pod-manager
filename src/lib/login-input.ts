/**
 * login-input.ts — the smart login input + provider directory behind the
 * first-party sign-in surface.
 *
 * ONE input accepts EITHER a WebID URL or a bare OIDC issuer URL, because a
 * fresh human signing up at a provider has an issuer ("the server I joined")
 * long before they can recite a WebID. Resolution order:
 *
 * - A **bare origin** (no path, no fragment) is most likely an issuer — probe
 *   OIDC discovery first, then fall back to WebID dereference.
 * - Anything with a path or fragment is most likely a WebID — dereference it
 *   and read `solid:oidcIssuer` first, then fall back to issuer discovery.
 *
 * Both orders try BOTH interpretations before giving up, so either kind of
 * URL works in the one input. All network reads are public (no auth).
 */
import {
  fetchLoginCandidate,
  validateWebId,
  type LoginCandidate,
} from "./login-ux.js";

/** A pod / identity provider offered on the sign-in surface. */
export interface LoginProvider {
  /** Human name shown on the button. */
  name: string;
  /** The OIDC issuer the login flow runs against. */
  issuer: string;
  /** One-line description. */
  blurb: string;
  /** True for the provider this deployment is the home of ("this server"). */
  home?: boolean;
}

/**
 * The home provider: the Solid server this Pod Manager deployment fronts.
 * Baked at build time from `NEXT_PUBLIC_HOME_IDP` / `NEXT_PUBLIC_HOME_IDP_NAME`
 * (static export — there is no runtime server to read env from).
 */
export const HOME_PROVIDER: LoginProvider = {
  name: process.env.NEXT_PUBLIC_HOME_IDP_NAME ?? "solid-test.jeswr.org",
  issuer: process.env.NEXT_PUBLIC_HOME_IDP ?? "https://idp.solid-test.jeswr.org",
  blurb: "Recommended — your pod lives right here",
  home: true,
};

/**
 * Well-known public Solid providers (each origin doubles as its OIDC issuer).
 * Same list the landing page offers for pod creation; ordered by how
 * beginner-friendly the sign-up is.
 */
export const PUBLIC_PROVIDERS: LoginProvider[] = [
  {
    name: "solidcommunity.net",
    issuer: "https://solidcommunity.net",
    blurb: "Free, run by the Solid community",
  },
  {
    name: "solidweb.org",
    issuer: "https://solidweb.org",
    blurb: "Free community pod host",
  },
  {
    name: "teamid.live",
    issuer: "https://teamid.live",
    blurb: "Free, quick sign-up",
  },
];

/** Every provider offered on the sign-in surface, home first. */
export const LOGIN_PROVIDERS: LoginProvider[] = [
  HOME_PROVIDER,
  ...PUBLIC_PROVIDERS,
];

/** What the smart input resolved to. */
export type LoginTarget =
  | ({ kind: "webid" } & LoginCandidate)
  | { kind: "issuer"; issuer: string };

/** The input is a URL, but neither a WebID profile nor an OIDC issuer. */
export class NotALoginAddressError extends Error {
  readonly input: string;
  constructor(input: string, cause?: unknown) {
    super(
      `Not a WebID and not an OIDC issuer: ${input}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "NotALoginAddressError";
    this.input = input;
  }
}

/**
 * Probe a URL for OIDC issuer-ness: fetch
 * `<url>/.well-known/openid-configuration` and require a JSON body declaring
 * `issuer` + `authorization_endpoint`. Returns the server's canonical issuer
 * string (what discovery validation will be run against), or `undefined` when
 * the URL is not an issuer. Never throws.
 */
export async function discoverIssuer(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const base = url.replace(/\/+$/, "");
  try {
    const response = await fetchImpl(
      `${base}/.well-known/openid-configuration`,
      { headers: { accept: "application/json" } },
    );
    if (!response.ok) return undefined;
    const config = (await response.json()) as {
      issuer?: unknown;
      authorization_endpoint?: unknown;
    };
    if (
      typeof config.issuer !== "string" ||
      typeof config.authorization_endpoint !== "string"
    ) {
      return undefined;
    }
    return config.issuer;
  } catch {
    return undefined;
  }
}

/** A bare origin (no meaningful path, no fragment) reads as an issuer first. */
function looksLikeIssuer(url: URL): boolean {
  return (url.pathname === "/" || url.pathname === "") && url.hash === "";
}

/**
 * Resolve the smart input: WebID or issuer (see module docs for the order).
 * Throws `InvalidWebIdError` for non-URLs (synchronously detectable — callers
 * can validate before opening a popup) and {@link NotALoginAddressError} when
 * the URL answers as neither.
 */
export async function resolveLoginInput(
  input: string,
  fetchImpl?: typeof fetch,
): Promise<LoginTarget> {
  const normalized = validateWebId(input); // throws InvalidWebIdError on garbage
  const url = new URL(normalized);

  const asWebId = async (): Promise<LoginTarget> => ({
    kind: "webid",
    ...(await fetchLoginCandidate(normalized, fetchImpl)),
  });
  const asIssuer = async (): Promise<LoginTarget | undefined> => {
    const issuer = await discoverIssuer(normalized, fetchImpl);
    return issuer === undefined ? undefined : { kind: "issuer", issuer };
  };

  if (looksLikeIssuer(url)) {
    const issuer = await asIssuer();
    if (issuer !== undefined) return issuer;
    try {
      return await asWebId();
    } catch (e) {
      throw new NotALoginAddressError(input, e);
    }
  }

  let webIdFailure: unknown;
  try {
    return await asWebId();
  } catch (e) {
    webIdFailure = e;
  }
  const issuer = await asIssuer();
  if (issuer !== undefined) return issuer;
  throw new NotALoginAddressError(input, webIdFailure);
}
