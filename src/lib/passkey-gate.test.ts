// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
// vitest — node env. PROVES the Finding-3 flicker fix AND the no-auto-prompt-on-load
// invariant at the gate decision: a USER-GESTURE passkey licence lets the composed
// passkey upgrade() (a NATIVE prompt, NO window) serve a protected read with a DEAD
// refresh token — so the recent-account passkey sign-in needs NO OAuth popup — while
// an UNLICENSED (boot) read with no interactive session never qualifies, so no passkey
// prompt can fire automatically on load.
import { describe, it, expect } from "vitest";
import {
  canAttachNonInteractivelyDecision,
  type PasskeyGateInputs,
} from "./passkey-gate.js";

const WEBID = "https://alice.solid-test.jeswr.org/profile/card#me";
const OTHER_WEBID = "https://bob.solid-test.jeswr.org/profile/card#me";

/** Default inputs = a logged-out boot with NO renewable interactive session. */
const base: PasskeyGateInputs = {
  passkeyInteractiveWebId: undefined,
  hasPasskeyProvider: false,
  // The per-load provider is built for WEBID by default (so a licence for WEBID
  // matches the built-for account); tests that license a DIFFERENT WebID override it.
  passkeyProviderWebId: WEBID,
  originAllowed: true,
  interactiveRenewable: false,
};

describe("canAttachNonInteractivelyDecision — the passkey licence (roborev Finding 3)", () => {
  it("LICENSED passkey read with a DEAD interactive session ⇒ attaches (no popup needed)", () => {
    // The flicker case: refresh token dead (interactiveRenewable false), but a
    // user-gesture passkey sign-in licensed this WebID and a passkey provider is
    // wired → attach via the native passkey prompt, NO OAuth window.
    expect(
      canAttachNonInteractivelyDecision({
        ...base,
        passkeyInteractiveWebId: WEBID,
        hasPasskeyProvider: true,
        interactiveRenewable: false,
      }),
    ).toBe(true);
  });

  it("UNLICENSED boot read with a dead session ⇒ does NOT attach (no auto passkey prompt on load)", () => {
    // The load-bearing invariant: on boot the licence ref is UNSET, so even with a
    // passkey provider wired and the origin allowed, a passive read does NOT qualify
    // for the passkey branch → no upgrade() → no navigator.credentials.get() on load.
    expect(
      canAttachNonInteractivelyDecision({
        ...base,
        passkeyInteractiveWebId: undefined, // boot: not licensed
        hasPasskeyProvider: true,
        interactiveRenewable: false,
      }),
    ).toBe(false);
  });

  it("a licence WITHOUT a wired passkey provider ⇒ falls back to interactive renewability", () => {
    // Nothing to serve the passkey path → the licence alone must not attach.
    expect(
      canAttachNonInteractivelyDecision({
        ...base,
        passkeyInteractiveWebId: WEBID,
        hasPasskeyProvider: false,
        interactiveRenewable: false,
      }),
    ).toBe(false);
    // But the interactive renewal path is unaffected.
    expect(
      canAttachNonInteractivelyDecision({
        ...base,
        passkeyInteractiveWebId: WEBID,
        hasPasskeyProvider: false,
        interactiveRenewable: true,
      }),
    ).toBe(true);
  });

  it("a licence for a FOREIGN-origin request (outside the boundary) ⇒ does NOT attach", () => {
    // Defense in depth: the passkey licence never widens the credential boundary.
    expect(
      canAttachNonInteractivelyDecision({
        ...base,
        passkeyInteractiveWebId: WEBID,
        hasPasskeyProvider: true,
        originAllowed: false,
        interactiveRenewable: false,
      }),
    ).toBe(false);
  });

  it("a renewable interactive session still attaches even without any passkey licence (unchanged path)", () => {
    expect(
      canAttachNonInteractivelyDecision({ ...base, interactiveRenewable: true }),
    ).toBe(true);
  });

  it("logged-out boot, nothing renewable, no licence ⇒ does NOT attach (fail-closed)", () => {
    expect(canAttachNonInteractivelyDecision(base)).toBe(false);
  });

  it("the recent-account PASSKEY path is served WITHOUT any OAuth popup (the flicker fix, end-to-end at the gate)", () => {
    // This encodes the Finding-3 invariant at the decision boundary: the ONLY
    // thing the recent-account passkey sign-in needs to acquire a token is the gate
    // saying "attach non-interactively", which for a passkey-licensed, boundary-allowed
    // request is TRUE *independently of* the interactive provider's (popup-owning)
    // renewability. So the protected read is served by the native passkey prompt and
    // NO `PopupLoginController.open()` / `window.open` is ever reached on this path.
    const decision = canAttachNonInteractivelyDecision({
      passkeyInteractiveWebId: WEBID, // licensed by the user-gesture signInWithPasskey
      hasPasskeyProvider: true, // a passkey is wired for this WebID this load
      passkeyProviderWebId: WEBID, // the per-load provider was built FOR this WebID
      originAllowed: true, // the WebID/profile read is inside the boundary
      interactiveRenewable: false, // refresh token DEAD — the exact flicker trigger
    });
    expect(decision).toBe(true); // attaches via the passkey path → no popup, no flash
  });
});

describe("canAttachNonInteractivelyDecision — the licence is bound to the BUILT-FOR WebID (roborev H1)", () => {
  it("a licence for a WebID DIFFERENT from the provider's built-for WebID does NOT qualify (identity-confusion fix)", () => {
    // The H1 case: two passkey accounts; the per-load provider is built for WEBID,
    // but the user clicked OTHER_WEBID's chip → its sign-in licenses OTHER_WEBID. The
    // composed upgrade() would still route to WEBID's bound provider on a shared host,
    // so the licence must NOT qualify the passkey branch. With a dead interactive
    // session it falls through to interactiveRenewable=false ⇒ no attach.
    expect(
      canAttachNonInteractivelyDecision({
        ...base,
        passkeyInteractiveWebId: OTHER_WEBID, // clicked / licensed account B
        passkeyProviderWebId: WEBID, // but the per-load provider is bound to A
        hasPasskeyProvider: true,
        originAllowed: true,
        interactiveRenewable: false,
      }),
    ).toBe(false);
  });

  it("a wrong-WebID licence still falls back to interactive renewability when available", () => {
    // The licence is ignored (wrong account), but an interactive renewable session
    // still attaches via the unchanged path — never blocked by the H1 mismatch.
    expect(
      canAttachNonInteractivelyDecision({
        ...base,
        passkeyInteractiveWebId: OTHER_WEBID,
        passkeyProviderWebId: WEBID,
        hasPasskeyProvider: true,
        originAllowed: true,
        interactiveRenewable: true,
      }),
    ).toBe(true);
  });

  it("a matching licence (licensed === built-for) DOES qualify with a dead interactive session", () => {
    expect(
      canAttachNonInteractivelyDecision({
        ...base,
        passkeyInteractiveWebId: WEBID,
        passkeyProviderWebId: WEBID,
        hasPasskeyProvider: true,
        originAllowed: true,
        interactiveRenewable: false,
      }),
    ).toBe(true);
  });

  it("a licence with NO built-for WebID (no provider wired) does NOT qualify", () => {
    // Defense in depth: even if a licence ref were somehow set with no provider built,
    // an undefined built-for WebID can never equal a defined licensed WebID.
    expect(
      canAttachNonInteractivelyDecision({
        ...base,
        passkeyInteractiveWebId: WEBID,
        passkeyProviderWebId: undefined,
        hasPasskeyProvider: false,
        originAllowed: true,
        interactiveRenewable: false,
      }),
    ).toBe(false);
  });
});
