// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * session-switch.test.ts — the provider-level ACCOUNT-SWITCH regression
 * (the second follow-up to the silent-restore fix).
 *
 * THE INVARIANT UNDER TEST: during an interactive account switch (logged-in as
 * WebID A with A's `activeStorage`/`profile`, then logging into WebID B), at NO
 * observable point may the session expose `status: "logged-in"` for B's WebID
 * paired with A's `activeStorage`/`profile`. A page that guards only on
 * `activeStorage` would otherwise briefly read or act on the WRONG pod.
 *
 * The fix clears `profile`/`activeStorage` AS the load for the new WebID enters
 * `"loading"` (the {@link shouldClearOnSwitch} decision the provider uses), so
 * the switch transitions A → (B, no storage/profile, loading) → (B, B's
 * storage/profile, ready) and never through (B, A's storage).
 *
 * This is a faithful MODEL of `SessionProvider`'s exposed-session state machine:
 * it replays the exact ordered sequence the provider runs on a switch
 * (`setWebId(B)` + `setStatus("logged-in")` then the shared `loadProfileFor(B)`
 * loader), reusing the SAME `shouldClearOnSwitch` + `loadProfileState` the
 * provider wires, and records EVERY observable snapshot so the invariant can be
 * asserted across the whole transition — without a browser/React renderer (the
 * vitest env is `node`; the data layer is the testable surface here, mirroring
 * session-restore.test.ts / session-profile.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
  loadProfileState,
  shouldClearOnSwitch,
  type LoadProfile,
} from "./session-profile";
import type { PodProfile } from "./profile";

const WEBID_A = "https://alice.pod.test/profile/card#me";
const WEBID_B = "https://bob.pod.test/profile/card#me";

const PROFILE_A: PodProfile = {
  webId: WEBID_A,
  displayName: "Alice",
  avatarUrl: undefined,
  bio: undefined,
  storages: ["https://alice.pod.test/"],
  issuers: ["https://idp-a.test/"],
};

const PROFILE_B: PodProfile = {
  webId: WEBID_B,
  displayName: "Bob",
  avatarUrl: undefined,
  bio: undefined,
  storages: ["https://bob.pod.test/"],
  issuers: ["https://idp-b.test/"],
};

/** The slice of the provider's reactive session children actually observe. */
interface ExposedSession {
  status: "loading" | "logged-out" | "authenticating" | "logged-in";
  webId: string | undefined;
  profile: PodProfile | undefined;
  activeStorage: string | undefined;
  profileStatus: "loading" | "ready" | "error";
}

/**
 * A faithful model of `SessionProvider`'s exposed-session state machine — only
 * the fields + transitions that bear on the switch invariant. Every mutation
 * records a snapshot into {@link snapshots}, so a test can assert across EVERY
 * observable state the children would render, not just the terminal one.
 */
class ProviderModel {
  status: ExposedSession["status"] = "logged-out";
  webId: string | undefined;
  profile: PodProfile | undefined;
  activeStorage: string | undefined;
  profileStatus: ExposedSession["profileStatus"] = "loading";

  /** The WebID whose exposed profile/activeStorage belong to (the provider ref). */
  private exposedProfileWebId: string | undefined;
  /** Monotonic generation guard, exactly as the provider's profileLoadGenRef. */
  private gen = 0;

  readonly snapshots: ExposedSession[] = [];

  private snapshot(): void {
    this.snapshots.push({
      status: this.status,
      webId: this.webId,
      profile: this.profile,
      activeStorage: this.activeStorage,
      profileStatus: this.profileStatus,
    });
  }

  /**
   * Mirrors completeLogin's synchronous head: set the new WebID, run the
   * clear-on-switch prologue (enterSwitchLoading — CO-LOCATED with the
   * status change, the fix), THEN mark logged-in — all committed together, so
   * the first observable logged-in snapshot for the new WebID already has the
   * prior account's storage/profile cleared.
   */
  markLoggedIn(id: string): void {
    this.webId = id;
    this.enterSwitchLoading(id);
    this.status = "logged-in";
    this.snapshot();
  }

  /** Mirrors enterSwitchLoading(id): clear stale storage/profile on a real switch. */
  private enterSwitchLoading(id: string): void {
    if (shouldClearOnSwitch(id, this.exposedProfileWebId)) {
      this.exposedProfileWebId = undefined;
      this.profile = undefined;
      this.activeStorage = undefined;
    }
    this.profileStatus = "loading";
  }

  /** Mirrors loadProfileFor(id) — the shared loader (enterSwitchLoading + commit). */
  async loadProfileFor(id: string, loadProfile: LoadProfile): Promise<void> {
    const gen = ++this.gen;
    this.enterSwitchLoading(id); // idempotent: a no-op once already cleared.
    this.snapshot();

    const result = await loadProfileState(id, loadProfile);
    if (gen !== this.gen) return; // superseded — drop stale result.
    if (result.status === "ready") {
      this.profile = result.profile;
      this.activeStorage = result.activeStorage;
      this.exposedProfileWebId = id;
      this.profileStatus = "ready";
    } else {
      this.exposedProfileWebId = undefined;
      this.profile = undefined;
      this.activeStorage = undefined;
      this.profileStatus = "error";
    }
    this.snapshot();
  }
}

/** The forbidden state: logged-in as `wrongFor` but exposing `expectedStorage`. */
function exposesWrongPod(
  s: ExposedSession,
  switchedToWebId: string,
  priorStorage: string,
  priorProfile: PodProfile,
): boolean {
  return (
    s.status === "logged-in" &&
    s.webId === switchedToWebId &&
    (s.activeStorage === priorStorage || s.profile === priorProfile)
  );
}

describe("account switch A → B — never exposes B's logged-in identity with A's pod", () => {
  it("clears A's storage/profile as B's load begins, then resolves to B's", async () => {
    const loadProfile: LoadProfile = async (id) =>
      id === WEBID_A ? PROFILE_A : PROFILE_B;

    const m = new ProviderModel();

    // 1) Logged in as A with A's profile/storage fully exposed.
    m.markLoggedIn(WEBID_A);
    await m.loadProfileFor(WEBID_A, loadProfile);
    expect(m.status).toBe("logged-in");
    expect(m.webId).toBe(WEBID_A);
    expect(m.activeStorage).toBe("https://alice.pod.test/");
    expect(m.profile).toBe(PROFILE_A);

    const switchStartIndex = m.snapshots.length;

    // 2) Interactive switch to B: provider marks logged-in for B, then the
    //    shared loader runs (clear-on-switch → loading → ready).
    m.markLoggedIn(WEBID_B);
    await m.loadProfileFor(WEBID_B, loadProfile);

    // THE INVARIANT: across EVERY snapshot from the switch onward, the session
    // is never logged-in as B while still exposing A's storage or profile.
    const fromSwitch = m.snapshots.slice(switchStartIndex);
    expect(fromSwitch.length).toBeGreaterThan(0);
    for (const s of fromSwitch) {
      expect(
        exposesWrongPod(s, WEBID_B, "https://alice.pod.test/", PROFILE_A),
      ).toBe(false);
    }

    // And there IS a logged-in-as-B snapshot whose storage/profile are blank
    // (the loading window) before B's own storage/profile resolve.
    expect(
      fromSwitch.some(
        (s) =>
          s.status === "logged-in" &&
          s.webId === WEBID_B &&
          s.profileStatus === "loading" &&
          s.activeStorage === undefined &&
          s.profile === undefined,
      ),
    ).toBe(true);

    // Terminal: B's own profile/storage.
    expect(m.status).toBe("logged-in");
    expect(m.webId).toBe(WEBID_B);
    expect(m.activeStorage).toBe("https://bob.pod.test/");
    expect(m.profile).toBe(PROFILE_B);
  });

  it("holds even when B's profile load FAILS — never falls back to A's pod", async () => {
    const loadProfile: LoadProfile = async (id) => {
      if (id === WEBID_A) return PROFILE_A;
      throw new Error("B profile read 500");
    };

    const m = new ProviderModel();
    m.markLoggedIn(WEBID_A);
    await m.loadProfileFor(WEBID_A, loadProfile);
    const switchStartIndex = m.snapshots.length;

    m.markLoggedIn(WEBID_B);
    await m.loadProfileFor(WEBID_B, loadProfile);

    for (const s of m.snapshots.slice(switchStartIndex)) {
      expect(
        exposesWrongPod(s, WEBID_B, "https://alice.pod.test/", PROFILE_A),
      ).toBe(false);
    }

    // The session stays logged-in as B with an explicit error (degraded + retry),
    // NOT A's storage/profile, NOT a drop to login.
    expect(m.status).toBe("logged-in");
    expect(m.webId).toBe(WEBID_B);
    expect(m.profileStatus).toBe("error");
    expect(m.activeStorage).toBeUndefined();
    expect(m.profile).toBeUndefined();
  });

  it("same-WebID retry does NOT blank the already-good profile (no flash)", async () => {
    // A's first load fails → error; retry for the SAME WebID must keep the
    // session and reach ready WITHOUT a blanking snapshot of an existing
    // profile (there is none here) — the key assertion is no spurious clear.
    let attempt = 0;
    const loadProfile: LoadProfile = async (id) => {
      expect(id).toBe(WEBID_A);
      attempt += 1;
      if (attempt === 1) throw new Error("transient");
      return PROFILE_A;
    };

    const m = new ProviderModel();
    m.markLoggedIn(WEBID_A);
    await m.loadProfileFor(WEBID_A, loadProfile); // error
    expect(m.profileStatus).toBe("error");

    // Now simulate a successful first ready, then a retry that must not blank it.
    const m2 = new ProviderModel();
    const okProfile: LoadProfile = async () => PROFILE_A;
    m2.markLoggedIn(WEBID_A);
    await m2.loadProfileFor(WEBID_A, okProfile); // ready, exposes A
    const retryStart = m2.snapshots.length;
    await m2.loadProfileFor(WEBID_A, okProfile); // SAME WebID retry

    // No snapshot in the retry window blanked A's profile while logged-in as A.
    for (const s of m2.snapshots.slice(retryStart)) {
      if (s.status === "logged-in" && s.webId === WEBID_A) {
        expect(s.profile).toBe(PROFILE_A);
        expect(s.activeStorage).toBe("https://alice.pod.test/");
      }
    }
    expect(m2.profileStatus).toBe("ready");
  });
});
