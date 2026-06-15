// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * session-profile.test.ts — the explicit profile-load lifecycle behind a
 * logged-in session (the follow-up to the silent-restore fix). The contract:
 *
 *   • a profile failure is NOT swallowed into a silent undefined-profile state:
 *     it resolves to an EXPLICIT { status: "error" } (with the cause), never
 *     throwing — so the shell renders a degraded, retryable banner while the
 *     session itself stays logged-in.
 *   • on success it resolves { status: "ready" } with the profile + the chosen
 *     activeStorage (first advertised storage; undefined when none).
 *   • restore-success → profile-error → RETRY → ready: the retry re-runs the
 *     same loader and now reaches "ready" (the session never dropped to login).
 */
import { describe, expect, it, vi } from "vitest";
import { loadProfileState, type LoadProfile } from "./session-profile";
import type { PodProfile } from "./profile";

const WEBID = "https://alice.pod.test/profile/card#me";

const PROFILE: PodProfile = {
  webId: WEBID,
  displayName: "Alice",
  avatarUrl: "https://alice.pod.test/me.jpg",
  bio: undefined,
  storages: ["https://alice.pod.test/", "https://alice.pod.test/other/"],
  issuers: ["https://idp.test/"],
};

describe("loadProfileState — SUCCESS (profile read returns)", () => {
  it("resolves ready with the profile and the first advertised storage", async () => {
    const loadProfile: LoadProfile = vi.fn(async (id) => {
      expect(id).toBe(WEBID);
      return PROFILE;
    });

    const result = await loadProfileState(WEBID, loadProfile);

    expect(result).toEqual({
      status: "ready",
      profile: PROFILE,
      activeStorage: "https://alice.pod.test/",
    });
    expect(loadProfile).toHaveBeenCalledTimes(1);
  });

  it("ready with activeStorage undefined when the profile advertises no storage", async () => {
    const bare: PodProfile = { ...PROFILE, storages: [] };
    const result = await loadProfileState(WEBID, async () => bare);

    expect(result).toEqual({ status: "ready", profile: bare, activeStorage: undefined });
  });
});

describe("loadProfileState — FAILURE is explicit, not swallowed", () => {
  it("resolves error (never throws) with the cause, leaving the session to stay logged-in", async () => {
    const cause = new Error("profile read 500");
    const loadProfile: LoadProfile = vi.fn(async () => {
      throw cause;
    });

    // The function MUST NOT throw — a swallowed throw was the bug being fixed.
    const result = await loadProfileState(WEBID, loadProfile);

    expect(result).toEqual({ status: "error", error: cause });
    // No profile/activeStorage on the error result: surfaces depending on
    // storage render a degraded state + retry, never undefined-with-no-recourse.
    expect(result).not.toHaveProperty("profile");
    expect(result).not.toHaveProperty("activeStorage");
  });

  it("wraps a non-Error rejection in an Error so the error surface always has a message", async () => {
    const result = await loadProfileState(WEBID, async () => {
      throw "network down";
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe("network down");
    }
  });
});

describe("loadProfileState — restore-success → profile-error → RETRY → ready", () => {
  it("a retry re-runs the loader and reaches ready (the session never dropped to login)", async () => {
    // Models the shell: a restored session is logged-in; its first profile load
    // fails (transient blip) → profileStatus "error" with a retry; the user
    // retries and the load now succeeds → "ready". Throughout, the session is
    // logged-in — there is no "login" outcome here at all.
    const loadProfile: LoadProfile = vi
      .fn<LoadProfile>()
      .mockRejectedValueOnce(new Error("transient blip"))
      .mockResolvedValueOnce(PROFILE);

    // 1) restore lands logged-in, first profile load fails → error + retry.
    const first = await loadProfileState(WEBID, loadProfile);
    expect(first.status).toBe("error");

    // 2) retryProfile() re-runs the SAME loader for the SAME WebID → ready.
    const second = await loadProfileState(WEBID, loadProfile);
    expect(second).toEqual({
      status: "ready",
      profile: PROFILE,
      activeStorage: "https://alice.pod.test/",
    });

    expect(loadProfile).toHaveBeenCalledTimes(2);
    expect(loadProfile).toHaveBeenNthCalledWith(1, WEBID);
    expect(loadProfile).toHaveBeenNthCalledWith(2, WEBID);
  });
});
