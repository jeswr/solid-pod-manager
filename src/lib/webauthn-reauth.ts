// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * webauthn-reauth.ts — the redirect-free WebAuthn (passkey) re-auth strategy for
 * the app's 401-upgrade pipeline.
 *
 * The app is the WebAuthn **Relying Party**. After a one-time normal login plus a
 * passkey registration (see `webauthn-register.ts`), a returning visit can mint a
 * fresh Solid-OIDC access token with NO redirect and NO popup: the vendored
 * `@jeswr/solid-webauthn-client` `WebAuthnTokenProvider` does a background `fetch`
 * to the broker's `/.oidc/webauthn/assertion-options`, runs the platform passkey
 * prompt (`navigator.credentials.get()`), and exchanges the assertion at the
 * token endpoint (RFC 8693, `subject_token_type:
 * urn:solid:token-type:webauthn-assertion`, DPoP-bound).
 *
 * It slots into `@solid/reactive-authentication`'s `ReactiveFetchManager`
 * `TokenProvider[]` as the FIRST provider — first `matches` wins, so passkey
 * re-auth is tried before the interactive `WebIdDPoPTokenProvider`. `matches`
 * returns true only for issuer hosts the user has registered a passkey for ON
 * THIS DEVICE; everywhere else this provider declines and the normal redirect
 * login runs unchanged. See `docs/passkey-webauthn-port-design.md` §5 in
 * prod-solid-server for the locked design.
 *
 * NO auto-provision: if the assertion does not resolve to a provisioned WebID the
 * broker returns an error and mints nothing — the provider's `upgrade` then
 * throws, the manager falls through to the interactive provider, and the UI shows
 * the broker's error (see `webauthn-register.ts` for the registration-time
 * surfacing). We never try to create an identity.
 */

import {
  type TokenProvider,
  type WebAuthnConfig,
  type WebAuthnIssuerConfig,
  WebAuthnTokenProvider,
} from "@jeswr/solid-webauthn-client";
import type { KeyValueStorage } from "./login-ux.js";

/**
 * The minimal token-provider contract the re-auth wrapper delegates a failed/
 * wrong-account upgrade to (the app's interactive `WebIdDPoPTokenProvider`).
 * Re-exported so the session provider can type its cast without importing the
 * vendored client's type directly.
 *
 * `upgrade` accepts the OPTIONAL `forceRefresh` flag the proactive-auth-fetch
 * stale-token retry passes (roborev Finding 2): when the passkey path delegates to
 * the interactive fallback during a stale-token RETRY, that retry's `forceRefresh`
 * must reach the fallback so it mints a FRESH token rather than reusing the rejected
 * cached one. The vendored `TokenProvider.upgrade` is 1-arg; the real interactive
 * `WebIdDPoPTokenProvider.upgrade(request, forceRefresh?)` accepts it, and a 1-arg
 * provider simply ignores the extra argument.
 */
export type TokenProviderLike = Pick<TokenProvider, "matches"> & {
  upgrade(request: Request, forceRefresh?: boolean): Promise<Request>;
} & Partial<Pick<TokenProvider, "invalidate">>;

/**
 * Read the unverified `webid` claim from a Solid-OIDC `at+jwt` access token. NOT
 * a security check — the RS verifier does the real signature/issuer/cnf checks.
 * This only lets the app FAIL-CLOSED on an account mismatch (the passkey prompt
 * could return a credential for a different WebID on the same issuer/RP), so it
 * does not need crypto or a JWT library. Returns `undefined` on any malformed
 * input (the caller then declines and falls through to interactive login).
 */
export function webIdClaimOf(accessToken: string): string | undefined {
  const parts = accessToken.split(".");
  if (parts.length < 2) return undefined;
  try {
    const json =
      typeof atob === "function"
        ? atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
        : Buffer.from(parts[1], "base64url").toString("utf8");
    const claims = JSON.parse(json) as { webid?: unknown; webId?: unknown };
    const webid = claims.webid ?? claims.webId;
    return typeof webid === "string" ? webid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wraps the vendored {@link WebAuthnTokenProvider} to BIND re-auth to one
 * expected WebID. The vendored provider mints a token for whatever WebID the
 * broker resolves the assertion to and returns the upgraded request with no
 * app-side identity check — so on a shared issuer/RP the platform prompt could
 * return account B's credential while the app session is account A (roborev
 * High). This wrapper inspects the minted token's `webid` claim and, on a
 * mismatch (or an unreadable token), DELEGATES to the interactive fallback
 * provider for the correct account — it never lets a wrong-account token upgrade
 * the request.
 *
 * Delegation (not throwing) is required: `ReactiveFetchManager` selects the FIRST
 * matching provider and awaits its `upgrade()` with NO catch/next-provider
 * fallback (`dist/ReactiveFetchManager.js`), so a thrown `upgrade()` would just
 * reject the user's fetch. The wrapper therefore owns the fallback to the
 * interactive provider itself. If the passkey ceremony itself fails (e.g. the
 * broker's no-auto-provision refusal, or the user dismissing the prompt), that
 * error likewise routes through the fallback rather than rejecting the fetch.
 */
export class WebIdBoundWebAuthnProvider implements TokenProvider {
  readonly #inner: WebAuthnTokenProvider;
  readonly #fallback: TokenProviderLike;
  readonly #expectedWebId: string;

  constructor(
    inner: WebAuthnTokenProvider,
    fallback: TokenProviderLike,
    expectedWebId: string,
  ) {
    this.#inner = inner;
    this.#fallback = fallback;
    this.#expectedWebId = expectedWebId;
  }

  matches(request: Request): Promise<boolean> {
    return this.#inner.matches(request);
  }

  async upgrade(request: Request, forceRefresh?: boolean): Promise<Request> {
    // The inner provider may consume the request body (it clones/rewraps the
    // Request for the DPoP-bound resource proof). Keep a pristine clone for the
    // fallback path so a body-bearing POST/PUT can still be re-sent (roborev).
    const forFallback = request.clone();
    let upgraded: Request;
    try {
      // The passkey upgrade itself is STATELESS — a fresh ceremony + DPoP key on
      // every call — so `forceRefresh` is meaningless for it (there is no cached
      // credential to force past). But on a stale-token RETRY the DELEGATION to the
      // interactive fallback below MUST forward `forceRefresh` so the fallback mints
      // a fresh token rather than reusing its rejected cached one (roborev Finding 2).
      upgraded = await this.#inner.upgrade(request);
    } catch {
      // The passkey ceremony / exchange failed (broker refusal, cancelled
      // prompt, network). Do NOT reject the fetch — hand off to interactive
      // login (which surfaces a real error to the UI if IT fails).
      return this.#fallback.upgrade(forFallback, forceRefresh);
    }
    const auth = upgraded.headers.get("authorization") ?? "";
    const token = auth.replace(/^DPoP\s+/i, "");
    const webId = webIdClaimOf(token);
    if (webId !== this.#expectedWebId) {
      // Wrong account (or unreadable token): discard the passkey token and run
      // the interactive login for the expected account instead.
      return this.#fallback.upgrade(forFallback, forceRefresh);
    }
    return upgraded;
  }

  async invalidate(request: Request): Promise<void> {
    // INVALIDATE BOTH (roborev): `upgrade()` can return a token minted by EITHER the
    // inner passkey provider OR (on a wrong-account / failed ceremony) the interactive
    // `#fallback`. When a returned token is later rejected and the stale-token retry
    // calls `invalidate`, we don't know which provider issued it — so invalidate both,
    // best-effort. Invalidating only `#inner` would leave a stale fallback-issued token
    // cached.
    //
    // Wrap each optional call in an ASYNC THUNK before `Promise.allSettled` (roborev A1):
    // `Promise.resolve(this.#inner.invalidate?.(request))` evaluates the call EAGERLY, so a
    // SYNCHRONOUS throw from a 1-arg/sync `invalidate` would escape array construction —
    // aborting before the fallback is invalidated AND rejecting `invalidate()` despite the
    // best-effort contract. An async thunk converts a sync throw into a rejected promise that
    // `allSettled` absorbs, so each call is independently isolated and the method always
    // resolves. `return` void.
    await Promise.allSettled([
      (async () => this.#inner.invalidate?.(request))(),
      (async () => this.#fallback.invalidate?.(request))(),
    ]);
  }
}

/** The host component of an issuer/broker origin (e.g. `idp.solid-test.jeswr.org`). */
export function issuerHost(issuer: string): string {
  return new URL(issuer).host;
}

const PASSKEY_STORE_KEY = "solid-pod-manager:passkey-issuers";

/** The host component of a URL, or `undefined` if it does not parse. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Per-device memory of which WebIDs the user has registered a passkey for — keyed
 * by **WebID**, NOT by issuer host: two accounts can share one issuer/broker but
 * only one may have a passkey on this device, and the credential authenticates a
 * specific WebID (the broker resolves the assertion to a provisioned WebID). This
 * is the opt-in switch: a `WebAuthnTokenProvider` is registered only for the
 * resource hosts of WebIDs present here, so a user who never set up a passkey
 * sees exactly today's redirect login.
 *
 * It is intentionally a hint, not a credential — the credential lives in the
 * platform authenticator. A stale/wrong entry only costs one declined passkey
 * prompt before the normal login takes over (the provider's `upgrade` throws and
 * the manager falls through). Mirrors `RecentAccounts` (`login-ux.ts`).
 */
export interface PasskeyRegistration {
  /** The WebID the registered credential resolves to — the identity key. */
  webId: string;
  /** The OIDC issuer / broker origin the passkey authenticates against. */
  issuer: string;
  /**
   * The resource/storage hosts this account browses. The re-auth provider must
   * match the PROTECTED-RESOURCE request host (which is the storage host, often
   * != the issuer host), so these are what the config is keyed by. The WebID's
   * own host is always included (it is itself a protected read on restore).
   */
  resourceHosts: string[];
}

/**
 * Whether a parsed localStorage entry is a well-formed {@link PasskeyRegistration}
 * the login-restore path can safely consume WITHOUT throwing (roborev): a `webId`
 * string, an `issuer` string that parses as a URL (so `issuerHost(issuer)` /
 * `new URL(issuer)` never throws), and a `resourceHosts` array of strings (so the
 * `new Set(resourceHosts)` in `buildWebAuthnConfig` never throws). Anything else —
 * an old schema, a scalar, a missing field, a non-array `resourceHosts` — is dropped.
 */
function isWellFormedRegistration(value: unknown): value is PasskeyRegistration {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.webId !== "string") return false;
  if (typeof v.issuer !== "string") return false;
  try {
    void new URL(v.issuer);
  } catch {
    return false;
  }
  if (!Array.isArray(v.resourceHosts)) return false;
  return v.resourceHosts.every((h) => typeof h === "string");
}

export class PasskeyRegistry {
  readonly #storage: KeyValueStorage;
  constructor(storage: KeyValueStorage = globalThis.localStorage) {
    this.#storage = storage;
  }

  list(): PasskeyRegistration[] {
    try {
      const raw = this.#storage.getItem(PASSKEY_STORE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      // SHAPE-VALIDATE (roborev): valid JSON of the WRONG shape (an old schema, a
      // scalar, a non-array, a missing/invalid `issuer`, a non-array `resourceHosts`)
      // would escape the try and later throw in `.some()/.find()/issuerHost()/new Set()`
      // on the login-restore path. Filter to only well-formed entries so corrupt/old
      // storage NEVER throws downstream — a bad entry just costs one declined prompt.
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isWellFormedRegistration);
    } catch {
      return []; // corrupt storage must not block login
    }
  }

  /** Whether this device has a passkey registered for this exact `webId`. */
  hasFor(webId: string): boolean {
    return this.list().some((r) => r.webId === webId);
  }

  /**
   * Record (or refresh) a passkey registration, deduplicated by WebID. NEVER
   * throws: a successful broker registration must not be reported as a failure
   * just because localStorage is unavailable/full/blocked — the on-device
   * credential already exists; the local hint is best-effort. Returns whether the
   * hint was persisted (the caller can surface a soft "couldn't remember on this
   * device" note without claiming setup failed).
   */
  remember(registration: PasskeyRegistration): boolean {
    try {
      const rest = this.list().filter((r) => r.webId !== registration.webId);
      this.#storage.setItem(
        PASSKEY_STORE_KEY,
        JSON.stringify([registration, ...rest]),
      );
      return true;
    } catch {
      return false; // credential exists server/device-side; hint just not saved
    }
  }

  /** Forget the passkey hint for `webId` (the credential itself is not removable from here). NEVER throws. */
  forget(webId: string): void {
    try {
      this.#storage.setItem(
        PASSKEY_STORE_KEY,
        JSON.stringify(this.list().filter((r) => r.webId !== webId)),
      );
    } catch {
      // best-effort
    }
  }
}

/**
 * Build the {@link WebAuthnConfig} keyed by **resource host** — the host the
 * client's `WebAuthnTokenProvider.matches` tests against `request.url`. For Solid
 * layouts where the storage host differs from the issuer host this is essential:
 * protected reads hit the storage host, so keying by issuer host would never
 * match. Each registration contributes one entry per resource host, all pointing
 * at its issuer's token/assertion-options endpoints. `clientId` is the app's
 * Client ID Document URL (the SAME `/clientid.jsonld` the authorization-code flow
 * uses) so the broker resolves the app's allowed origins and binds the token's
 * `client_id`/`azp`.
 *
 * Returns `undefined` when no passkeys are registered — the caller then skips the
 * provider entirely so the pipeline is byte-for-byte today's behaviour.
 */
export function buildWebAuthnConfig(
  registrations: PasskeyRegistration[],
  clientId: string,
): WebAuthnConfig | undefined {
  if (registrations.length === 0) return undefined;
  const config: WebAuthnConfig = {};
  for (const { issuer, webId, resourceHosts } of registrations) {
    const entry: WebAuthnIssuerConfig = { issuer, clientId };
    // The WebID host is itself a protected read on restore; always include it.
    const hosts = new Set(resourceHosts);
    const webIdHost = hostOf(webId);
    if (webIdHost) hosts.add(webIdHost);
    // The issuer host too, in case the broker co-hosts protected resources.
    hosts.add(issuerHost(issuer));
    for (const host of hosts) {
      // First registration wins a host (deterministic; collisions are rare and
      // a wrong guess only costs one declined prompt then the popup fallback).
      config[host] ??= entry;
    }
  }
  return config;
}

/**
 * The sentinel a {@link rejectOnlyFallback}'s `upgrade` throws when a passkey
 * ceremony fails on the EXPLICIT `signInWithPasskey` path. It tells the session
 * provider's `signInWithPasskey` "the passkey could not serve this read — do NOT
 * try an interactive popup from inside `upgrade()` (it runs after async work,
 * outside the user activation, and the browser blocks it); reject so the
 * RECENT-ACCOUNT CLICK's `.catch` runs `login()` synchronously under the live
 * gesture instead" (roborev H2).
 */
export class PasskeyCeremonyFailedError extends Error {
  constructor(message = "Passkey ceremony failed; fall back to interactive login.") {
    super(message);
    this.name = "PasskeyCeremonyFailedError";
  }
}

/**
 * A {@link TokenProviderLike} whose `upgrade` always REJECTS with
 * {@link PasskeyCeremonyFailedError} (roborev H2). Used as the fallback for the
 * EXPLICIT `signInWithPasskey` passkey provider so a failed/wrong-account passkey
 * ceremony surfaces as an immediate rejection of the protected read — letting the
 * recent-account click's `.catch` open the interactive popup UNDER the user's
 * gesture, rather than `WebIdBoundWebAuthnProvider.upgrade` trying to open one
 * itself AFTER async work (which the popup blocker would catch, recoverable only
 * via the blocked-popup affordance — never an under-activation popup).
 *
 * `matches` returns false (it is never selected as a primary provider) and
 * `invalidate` is a no-op (it never mints a token to invalidate).
 */
export const rejectOnlyFallback: TokenProviderLike = {
  matches: async () => false,
  upgrade: async () => {
    throw new PasskeyCeremonyFailedError();
  },
  invalidate: async () => {},
};

/**
 * Construct the re-auth provider scoped to a SINGLE WebID — the account being
 * restored/active on this app load. Returns `undefined` when that WebID has no
 * passkey on this device (so the caller registers nothing for it).
 *
 * Scoping to one WebID is the roborev-High fix: the vendored
 * `WebAuthnTokenProvider` mints a token for whatever WebID the broker resolves
 * the assertion to, with no app-side WebID binding. If the provider were wired
 * for EVERY registered WebID, then on a shared storage/resource host a passkey
 * for account B could be tried while the app is restoring/browsing account A. By
 * wiring it only for the active account's WebID + that account's resource hosts,
 * the passkey tried always belongs to the session being established. A fresh
 * login to a DIFFERENT account does not get passkey re-auth until the next load
 * (the manager array is built once at startup) — which matches the design
 * ("payoff on return visits").
 */
export function buildWebAuthnReauthProviderForWebId(
  registry: PasskeyRegistry,
  webId: string,
  clientId: string,
  fallback: TokenProviderLike,
): WebIdBoundWebAuthnProvider | undefined {
  const registration = registry.list().find((r) => r.webId === webId);
  if (registration === undefined) return undefined;
  const config = buildWebAuthnConfig([registration], clientId);
  if (config === undefined) return undefined;
  // Bind the minted token to this WebID: on a mismatch (or a failed ceremony)
  // the wrapper DELEGATES to the interactive `fallback` for the correct account
  // — the manager has no catch/next-provider fallback of its own (roborev High).
  return new WebIdBoundWebAuthnProvider(
    new WebAuthnTokenProvider(config),
    fallback,
    webId,
  );
}
