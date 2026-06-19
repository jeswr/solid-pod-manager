// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
// vitest — node env. The WebAuthn create() ceremony and the broker fetch are
// injected, so the whole register flow (incl. the no-auto-provision refusal) is
// exercised without a DOM or a live broker.
import { describe, it, expect, vi } from "vitest";
import type { RegistrationResponseJSON } from "@jeswr/solid-webauthn-protocol";
import {
  registerPasskey,
  WebAuthnRegistrationError,
} from "./webauthn-register.js";

const ISSUER = "https://idp.solid-test.jeswr.org";
const CLIENT_ID = "https://app.solid-test.jeswr.org/clientid.jsonld";
const WEBID = "https://alice.solid-test.jeswr.org/profile/card#me";

const FAKE_OPTIONS = { challenge: "abc", rp: { id: "idp.solid-test.jeswr.org" } };
const FAKE_CREDENTIAL = { id: "cred-1", type: "public-key" } as unknown as RegistrationResponseJSON;

const ceremony = vi.fn(async () => FAKE_CREDENTIAL);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("registerPasskey", () => {
  it("runs options → ceremony → register and returns the broker result", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.endsWith("/interaction/webauthn/register-options")) {
        return jsonResponse(FAKE_OPTIONS);
      }
      return jsonResponse({ webId: WEBID, clientId: CLIENT_ID, credentialId: "cred-1" });
    }) as unknown as typeof fetch;

    const result = await registerPasskey({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      fetchImpl,
      ceremony,
    });

    expect(result).toEqual({ webId: WEBID, clientId: CLIENT_ID, credentialId: "cred-1" });
    // options endpoint received { clientId }; the ceremony saw the options JSON.
    expect(calls[0].url).toBe(`${ISSUER}/interaction/webauthn/register-options`);
    expect(calls[0].body).toEqual({ clientId: CLIENT_ID });
    expect(ceremony).toHaveBeenCalledWith(FAKE_OPTIONS);
    // register endpoint received the versioned bundle with the credential + clientId.
    expect(calls[1].url).toBe(`${ISSUER}/interaction/webauthn/register`);
    expect(calls[1].body).toEqual({ version: 1, credential: FAKE_CREDENTIAL, clientId: CLIENT_ID });
  });

  it("sends the OP session cookie (credentials: include) on both requests", async () => {
    const inits: RequestInit[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init ?? {});
      return input.toString().endsWith("register-options")
        ? jsonResponse(FAKE_OPTIONS)
        : jsonResponse({ webId: WEBID, clientId: CLIENT_ID, credentialId: "c" });
    }) as unknown as typeof fetch;

    await registerPasskey({ issuer: ISSUER, clientId: CLIENT_ID, fetchImpl, ceremony });
    expect(inits.every((i) => i.credentials === "include")).toBe(true);
  });

  it("surfaces the broker's no-auto-provision refusal verbatim and creates nothing", async () => {
    const message = "This account is not provisioned for passkeys.";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      input.toString().endsWith("register-options")
        ? jsonResponse(FAKE_OPTIONS)
        : jsonResponse(
            { error: "access_denied", error_description: message },
            403,
          ),
    ) as unknown as typeof fetch;

    await expect(
      registerPasskey({ issuer: ISSUER, clientId: CLIENT_ID, fetchImpl, ceremony }),
    ).rejects.toMatchObject({
      name: "WebAuthnRegistrationError",
      message,
      status: 403,
    });
  });

  it("throws before the ceremony if register-options fails", async () => {
    const localCeremony = vi.fn(async () => FAKE_CREDENTIAL);
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "login_required" }, 401)) as unknown as typeof fetch;

    await expect(
      registerPasskey({ issuer: ISSUER, clientId: CLIENT_ID, fetchImpl, ceremony: localCeremony }),
    ).rejects.toBeInstanceOf(WebAuthnRegistrationError);
    expect(localCeremony).not.toHaveBeenCalled();
  });

  it("falls back to the status line when the broker error is not JSON", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      input.toString().endsWith("register-options")
        ? jsonResponse(FAKE_OPTIONS)
        : new Response("nope", { status: 500, statusText: "Internal Server Error" }),
    ) as unknown as typeof fetch;

    await expect(
      registerPasskey({ issuer: ISSUER, clientId: CLIENT_ID, fetchImpl, ceremony }),
    ).rejects.toMatchObject({ status: 500, message: "500 Internal Server Error" });
  });
});
