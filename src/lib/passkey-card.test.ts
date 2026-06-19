// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
// vitest — node env. Covers the settings PasskeyCard ready-state decision, including
// the {saved:false} case (roborev S2): a passkey set-up that created the credential
// but couldn't persist the local hint must STILL flip the card to "ready" so the UI
// does not invite a duplicate ceremony.
import { describe, it, expect } from "vitest";
import { passkeyCardReady } from "./passkey-card.js";

describe("passkeyCardReady", () => {
  it("is NOT ready when neither the hint nor a this-session set-up exists (default)", () => {
    expect(passkeyCardReady({ hasPasskey: false, setupComplete: false })).toBe(false);
  });

  it("is ready when the per-device hint is persisted (hasPasskey)", () => {
    expect(passkeyCardReady({ hasPasskey: true, setupComplete: false })).toBe(true);
  });

  it("is ready on a {saved:false} set-up even though the hint did NOT persist (roborev S2)", () => {
    // registerPasskey() returned { saved: false }: the credential WAS created on the
    // device but the local hint could not be stored, so hasPasskey stays false. The
    // card must still show "ready" — the credential exists; only the cross-load hint
    // failed — so the user is not invited to run a pointless duplicate ceremony.
    expect(passkeyCardReady({ hasPasskey: false, setupComplete: true })).toBe(true);
  });

  it("is ready when both are true", () => {
    expect(passkeyCardReady({ hasPasskey: true, setupComplete: true })).toBe(true);
  });
});
