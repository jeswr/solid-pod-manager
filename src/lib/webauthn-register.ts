// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * webauthn-register.ts — the one-time "set up a passkey for this device" ceremony.
 *
 * Run AFTER a normal interactive login, while the user still has a live OP
 * session (the broker's register routes are reachable only inside that session —
 * `docs/passkey-webauthn-port-design.md` §5). The app is the WebAuthn Relying
 * Party; the signed `clientDataJSON.origin` unspoofably attests the app, so the
 * broker binds the new credential to the WebID the session already resolved.
 *
 * Flow (the app is the RP):
 *   1. POST `<issuer>/interaction/webauthn/register-options` `{ clientId }`
 *      → `PublicKeyCredentialCreationOptionsJSON`
 *   2. `navigator.credentials.create()` (via SimpleWebAuthn's `startRegistration`)
 *      → the platform passkey-creation prompt
 *   3. POST `<issuer>/interaction/webauthn/register`
 *      `{ version, credential, clientId }` → `{ webId, clientId, credentialId }`
 *
 * NO auto-provision: the broker only registers a credential against a WebID that
 * is already a provisioned mapping. If it is not, the broker returns a clear
 * error and stores nothing — we surface that error verbatim and do NOT try to
 * create an identity ({@link WebAuthnRegistrationError}).
 *
 * Both the OP session cookie (register routes are session-scoped) AND any
 * patched-fetch credentials matter, so requests use `credentials: "include"`.
 */

import {
  BUNDLE_VERSION,
  type RegistrationBundle,
  type RegistrationOptions,
  type RegistrationResponseJSON,
} from "@jeswr/solid-webauthn-protocol";
import { startRegistration } from "@simplewebauthn/browser";

const REGISTER_OPTIONS_PATH = "/interaction/webauthn/register-options";
const REGISTER_PATH = "/interaction/webauthn/register";

/** The broker's response to a successful registration. */
export interface RegistrationResult {
  webId: string;
  clientId: string;
  credentialId: string;
}

/**
 * A registration attempt the broker refused — most importantly the
 * no-auto-provision case (the WebID is not a provisioned mapping). `message`
 * carries the broker's own copy so the UI can surface it verbatim; `status` is
 * the HTTP status for branching (e.g. distinguishing 403 not-provisioned from a
 * transient 5xx). NEVER recover by trying to create an identity.
 */
export class WebAuthnRegistrationError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "WebAuthnRegistrationError";
    this.status = status;
  }
}

/** The WebAuthn `create()` ceremony, injectable so the flow is unit-testable in node. */
export type RegistrationCeremony = (
  optionsJSON: RegistrationOptions,
) => Promise<RegistrationResponseJSON>;

const defaultCeremony: RegistrationCeremony = (optionsJSON) =>
  startRegistration({ optionsJSON });

export interface RegisterPasskeyOptions {
  /** The OIDC issuer / broker origin to register the passkey against. */
  issuer: string;
  /** The app's Client ID Document URL (`/clientid.jsonld`) — bound into the credential. */
  clientId: string;
  /** Injectable fetch (defaults to the patched global). */
  fetchImpl?: typeof fetch;
  /** Injectable ceremony (defaults to SimpleWebAuthn `startRegistration`). */
  ceremony?: RegistrationCeremony;
  /** Optional cancellation (e.g. a "cancel set-up" button). */
  signal?: AbortSignal;
}

async function readBrokerError(response: Response): Promise<string> {
  // Surface the broker's own error copy when it sends one (oidc-provider returns
  // `{ error, error_description }`); fall back to the status line.
  try {
    const body = (await response.clone().json()) as {
      error?: unknown;
      error_description?: unknown;
      message?: unknown;
    };
    const detail =
      (typeof body.error_description === "string" && body.error_description) ||
      (typeof body.message === "string" && body.message) ||
      (typeof body.error === "string" && body.error) ||
      "";
    if (detail) return detail;
  } catch {
    // not JSON — fall through
  }
  return `${response.status} ${response.statusText}`.trim();
}

/**
 * Register a passkey for this device against `issuer`, returning the broker's
 * `{ webId, clientId, credentialId }`. Throws {@link WebAuthnRegistrationError}
 * on a broker refusal (incl. the no-auto-provision case) so the UI surfaces the
 * broker's message and creates nothing.
 */
export async function registerPasskey({
  issuer,
  clientId,
  fetchImpl = fetch,
  ceremony = defaultCeremony,
  signal,
}: RegisterPasskeyOptions): Promise<RegistrationResult> {
  const optionsEndpoint = new URL(REGISTER_OPTIONS_PATH, issuer);
  const registerEndpoint = new URL(REGISTER_PATH, issuer);

  // (1) Fetch creation options. Session-scoped → send the OP cookie.
  const optionsResponse = await fetchImpl(optionsEndpoint, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ clientId }),
    signal,
  });
  if (!optionsResponse.ok) {
    throw new WebAuthnRegistrationError(
      await readBrokerError(optionsResponse),
      optionsResponse.status,
    );
  }
  const optionsJSON = (await optionsResponse.json()) as RegistrationOptions;

  // (2) Run the platform passkey-creation prompt.
  const credential = await ceremony(optionsJSON);

  // (3) Send the registration bundle.
  const bundle: RegistrationBundle = {
    version: BUNDLE_VERSION,
    credential,
    clientId,
  };
  const registerResponse = await fetchImpl(registerEndpoint, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(bundle),
    signal,
  });
  if (!registerResponse.ok) {
    // The no-auto-provision refusal (and any other broker rejection) lands here.
    throw new WebAuthnRegistrationError(
      await readBrokerError(registerResponse),
      registerResponse.status,
    );
  }
  return (await registerResponse.json()) as RegistrationResult;
}
