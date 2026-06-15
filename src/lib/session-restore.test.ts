// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * session-restore.test.ts — the silent-restore decision (the fix for "reopening
 * a closed tab routes through login again"). The security-sensitive branch
 * table, unit-tested without a browser:
 *
 *   • restore succeeds  → logged-in, NO login UI, NO popup
 *   • no token / no active account / no remembered issuer → login
 *   • expired / revoked refresh token → login
 *
 * The decision is driven off the refresh-grant outcome (not a public-profile
 * fetch), and never opens a popup.
 */
import { describe, expect, it, vi } from "vitest";
import {
  decideSilentRestore,
  type RememberedAccount,
  type RestoreIssuer,
} from "./session-restore";

const WEBID = "https://alice.pod.test/profile/card#me";
const ISSUER = "https://idp.test/";

const remembered: RememberedAccount[] = [
  { webId: WEBID, issuer: ISSUER },
  { webId: "https://bob.pod.test/profile/card#me", issuer: "https://other.test/" },
];

describe("decideSilentRestore — restore SUCCEEDS (returning user, only closed the tab)", () => {
  it("lands logged-in from the persisted refresh token, with the WebID + issuer", async () => {
    const restoreIssuer: RestoreIssuer = vi.fn(async (issuer) => {
      expect(issuer).toBe(ISSUER); // the remembered issuer for the active WebID
      return { webId: WEBID };
    });

    const decision = await decideSilentRestore({
      lastActiveWebId: WEBID,
      remembered,
      restoreIssuer,
    });

    expect(decision).toEqual({ outcome: "restored", webId: WEBID, issuer: ISSUER });
    expect(restoreIssuer).toHaveBeenCalledTimes(1);
    expect(restoreIssuer).toHaveBeenCalledWith(ISSUER);
  });

  it("uses the WebID stated by the restored session (issuer-first / sub-claim restore)", async () => {
    // The restored session may state a different WebID than the active key (e.g.
    // an issuer-first login). The decision trusts the restored session's WebID.
    const restoredWebId = "https://alice.pod.test/profile/card#me-alt";
    const restoreIssuer: RestoreIssuer = vi.fn(async () => ({ webId: restoredWebId }));

    const decision = await decideSilentRestore({
      lastActiveWebId: WEBID,
      remembered,
      restoreIssuer,
    });

    expect(decision).toEqual({ outcome: "restored", webId: restoredWebId, issuer: ISSUER });
  });
});

describe("decideSilentRestore — NO token (genuinely logged out / never signed in)", () => {
  it("shows login when there is no last active account, WITHOUT calling restore", async () => {
    const restoreIssuer: RestoreIssuer = vi.fn();
    for (const last of [null, undefined, ""] as const) {
      const decision = await decideSilentRestore({ lastActiveWebId: last, remembered, restoreIssuer });
      expect(decision).toEqual({ outcome: "login" });
    }
    expect(restoreIssuer).not.toHaveBeenCalled();
  });

  it("shows login when the active WebID has no remembered issuer (no per-issuer grant possible)", async () => {
    const restoreIssuer: RestoreIssuer = vi.fn();
    const decision = await decideSilentRestore({
      lastActiveWebId: "https://stranger.pod.test/profile/card#me",
      remembered,
      restoreIssuer,
    });
    expect(decision).toEqual({ outcome: "login" });
    // No issuer → no token grant to attempt → restore never called.
    expect(restoreIssuer).not.toHaveBeenCalled();
  });

  it("shows login when the remembered account has no issuer recorded", async () => {
    const restoreIssuer: RestoreIssuer = vi.fn();
    const decision = await decideSilentRestore({
      lastActiveWebId: WEBID,
      remembered: [{ webId: WEBID }], // issuer absent
      restoreIssuer,
    });
    expect(decision).toEqual({ outcome: "login" });
    expect(restoreIssuer).not.toHaveBeenCalled();
  });
});

describe("decideSilentRestore — EXPIRED / REVOKED refresh token", () => {
  it("shows login when restoreIssuer reports nothing to restore (undefined)", async () => {
    // restoreIssuer returns undefined for an expired/revoked/absent token AND
    // has already cleared the dead persisted entry — the credential is gone.
    const restoreIssuer: RestoreIssuer = vi.fn(async () => undefined);

    const decision = await decideSilentRestore({
      lastActiveWebId: WEBID,
      remembered,
      restoreIssuer,
    });

    expect(decision).toEqual({ outcome: "login" });
    expect(restoreIssuer).toHaveBeenCalledWith(ISSUER);
  });

  it("fails CLOSED to login when restoreIssuer throws unexpectedly (never asserts a session it couldn't rebuild)", async () => {
    const restoreIssuer: RestoreIssuer = vi.fn(async () => {
      throw new Error("token endpoint 500");
    });

    const decision = await decideSilentRestore({
      lastActiveWebId: WEBID,
      remembered,
      restoreIssuer,
    });

    expect(decision).toEqual({ outcome: "login" });
  });
});
