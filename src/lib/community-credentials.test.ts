// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { afterEach, describe, expect, it } from "vitest";
import {
  clearCommunityCredentials,
  clearCommunityCredentialsIfOwnerChanged,
  getCommunityCredentials,
  hasMatrixCredential,
  setCommunityCredentials,
} from "./community-credentials.js";

const ALICE = "https://alice.example/profile#me";
const BOB = "https://bob.example/profile#me";

afterEach(() => clearCommunityCredentials());

describe("community credentials (in-memory only)", () => {
  it("starts empty — Matrix locked, forum still usable", () => {
    expect(getCommunityCredentials()).toEqual({});
    expect(hasMatrixCredential()).toBe(false);
  });

  it("unlocks Matrix once a token is set, and clears it", () => {
    setCommunityCredentials({ matrixAccessToken: "syt_token" }, ALICE);
    expect(hasMatrixCredential()).toBe(true);
    expect(getCommunityCredentials().matrixAccessToken).toBe("syt_token");
    clearCommunityCredentials();
    expect(hasMatrixCredential()).toBe(false);
  });

  it("trims values and drops blanks (a blank token disconnects, not stores empty)", () => {
    setCommunityCredentials({
      matrixAccessToken: "  ",
      discourseUserApiKey: "  key  ",
      discourseUserApiClientId: "",
    });
    const c = getCommunityCredentials();
    expect(c.matrixAccessToken).toBeUndefined();
    expect(c.discourseUserApiKey).toBe("key");
    expect(c.discourseUserApiClientId).toBeUndefined();
    expect(hasMatrixCredential()).toBe(false);
  });

  it("returns a copy — callers cannot mutate the stored creds", () => {
    setCommunityCredentials({ matrixAccessToken: "t" }, ALICE);
    const c = getCommunityCredentials();
    c.matrixAccessToken = "tampered";
    expect(getCommunityCredentials().matrixAccessToken).toBe("t");
  });
});

describe("account-switch credential lifecycle (owner-aware clear)", () => {
  it("does NOT clear on a same-WebID remount (token lives for the tab)", () => {
    setCommunityCredentials({ matrixAccessToken: "alice_tok" }, ALICE);
    // Simulate /community mount → unmount → remount, same account: each mount
    // calls the guard. The token must survive.
    clearCommunityCredentialsIfOwnerChanged(ALICE);
    clearCommunityCredentialsIfOwnerChanged(ALICE);
    expect(hasMatrixCredential()).toBe(true);
    expect(getCommunityCredentials().matrixAccessToken).toBe("alice_tok");
  });

  it("clears on a genuine account switch (Alice → Bob)", () => {
    setCommunityCredentials({ matrixAccessToken: "alice_tok" }, ALICE);
    clearCommunityCredentialsIfOwnerChanged(BOB);
    expect(hasMatrixCredential()).toBe(false);
  });

  it("clears on logout (WebID → undefined)", () => {
    setCommunityCredentials({ matrixAccessToken: "alice_tok" }, ALICE);
    clearCommunityCredentialsIfOwnerChanged(undefined);
    expect(hasMatrixCredential()).toBe(false);
  });

  it("re-adopts the new owner so a subsequent same-WebID mount is a no-op", () => {
    setCommunityCredentials({ matrixAccessToken: "alice_tok" }, ALICE);
    clearCommunityCredentialsIfOwnerChanged(BOB); // switch → cleared, owner now BOB
    setCommunityCredentials({ matrixAccessToken: "bob_tok" }, BOB);
    clearCommunityCredentialsIfOwnerChanged(BOB); // same owner → no-op
    expect(getCommunityCredentials().matrixAccessToken).toBe("bob_tok");
  });

  it("an initial guard call for the active WebID does not wipe a freshly-set token", () => {
    // setCommunityCredentials records the owner, so the FIRST mount's guard for
    // that same WebID is a no-op (the bug: a component ref would see undefined
    // and clear it).
    setCommunityCredentials({ matrixAccessToken: "alice_tok" }, ALICE);
    clearCommunityCredentialsIfOwnerChanged(ALICE);
    expect(hasMatrixCredential()).toBe(true);
  });
});
