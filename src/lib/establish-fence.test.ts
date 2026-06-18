// AUTHORED-BY Claude Opus 4.8
/**
 * Adversarial tests for the establish-session GENERATION FENCE — the pure check that
 * closes the unfenced credential-boundary race in the Pod Manager's
 * `SessionProvider.completeLogin` / `restore` (the #123 proactive-fetch roborev HIGH the
 * vite siblings fixed). The fence is a monotonic counter: an establish snapshots its
 * generation up front and re-checks it after the profile await; a racing logout / account
 * switch advances the counter, so the superseded establish must bail.
 *
 * WEAKEN → FLIP → RESTORE discipline: each case asserts the SECURE direction (a moved
 * counter ⇒ bail), and the comment names what flips if the fence is weakened to a constant
 * `true` — i.e. the race re-opens.
 */
import { describe, expect, it, vi } from "vitest";
import { establishStillCurrent, runFencedPublish } from "./establish-fence";

describe("establishStillCurrent — the credential-boundary generation fence", () => {
  it("is CURRENT when no supersession advanced the counter (the happy path proceeds)", () => {
    // Same generation in and out of the await ⇒ this establish is still the live one ⇒
    // it may re-arm the authoritative boundary + publish.
    expect(
      establishStillCurrent({ establishGeneration: 7, currentGeneration: 7 }),
    ).toBe(true);
  });

  it("(a) BAILS when a concurrent LOGOUT advanced the counter — no re-arm against a logged-out provider", () => {
    // logout() bumps the counter (8 → 9) while completeLogin/restore awaits the profile.
    // The fence must report NOT current so the resumed establish does not re-open the
    // boundary behind a logged-out UI. Weaken the fence to `return true` and this flips to
    // true — the logged-out credential boundary is resurrected (the race).
    expect(
      establishStillCurrent({ establishGeneration: 8, currentGeneration: 9 }),
    ).toBe(false);
  });

  it("(b)+(c) BAILS when a NEW login (account switch) advanced the counter — no stale republish / no clobber", () => {
    // login(B) bumps the counter (3 → 4) while login(A) awaits A's profile. The fence makes
    // A bail, so A cannot republish A's stale session over B (b) nor clobber B's freshly
    // armed boundary/pointer (c). A weakened fence (`true`) lets A overwrite B — the race.
    expect(
      establishStillCurrent({ establishGeneration: 3, currentGeneration: 4 }),
    ).toBe(false);
  });

  it("(d) BAILS for EVERY advance, not just by one — a burst of logout+login still supersedes", () => {
    // Multiple supersessions during one await (logout then a new login) advance the counter
    // by more than 1. The fence is an EQUALITY check, so any delta ≠ 0 bails — the stale
    // establish never resurrects a logged-out credential. (`!==` is load-bearing: a `<`
    // check would also work, but equality is the simplest fail-closed form.)
    expect(
      establishStillCurrent({ establishGeneration: 1, currentGeneration: 3 }),
    ).toBe(false);
  });

  it("treats generation 0 (initial) as current vs 0 — first establish before any supersession", () => {
    expect(
      establishStillCurrent({ establishGeneration: 0, currentGeneration: 0 }),
    ).toBe(true);
  });

  it("FAILURE-PATH: a superseded establish that FAILS must NOT run cleanup (no clobber of the newer session)", () => {
    // The same fence gates the catch/cleanup paths (completeLogin's catch, restore's catch,
    // the silent-restore caller's catch + outer catch, login's catch): a superseded login
    // (gen 2 snapshot, live gen 4 after a newer login won) that then THROWS must see the
    // fence report NOT current, so it does NOT closeCredentialBoundary()/setStatus(
    // "logged-out") and clobber the newer login's boundary + UI. A weakened fence (`true`)
    // makes the stale failure tear down the newer session — the exact roborev HIGH on the
    // first round of this fix.
    expect(
      establishStillCurrent({ establishGeneration: 2, currentGeneration: 4 }),
    ).toBe(false);
  });

  it("ENTRY-FENCE: a completeLogin entered after a newer login won bails before ANY side effect", () => {
    // completeLogin's FIRST statement consults the fence with the generation its caller
    // bump-captured (gen 5). If a newer login already advanced the live counter (to 6) during
    // the caller's discovery await, the fence reports NOT current, so completeLogin returns
    // before setStatus("authenticating") / closeCredentialBoundary() — it cannot flip the
    // newer login's UI or clear its boundary. Weakened (`true`) ⇒ the stale entry clobbers.
    expect(
      establishStillCurrent({ establishGeneration: 5, currentGeneration: 6 }),
    ).toBe(false);
  });

  it("POPUP-FENCE: a stale flow does not close the newer login's shared popup", () => {
    // getController().closeIfOpen() (the shared popup) is gated by the SAME fence, so a stale
    // login resolving after a newer one started (gen 1 vs live 2) does not close the newer
    // login's window. A weakened fence lets the stale flow close the live popup mid-auth.
    expect(
      establishStillCurrent({ establishGeneration: 1, currentGeneration: 2 }),
    ).toBe(false);
  });

  it("FAILURE-PATH: the CURRENT establish failing DOES clean up (gen unchanged ⇒ proceed)", () => {
    // When no one superseded us, a genuine login/restore failure MUST clean up (close the
    // boundary, fall back to logged-out) — the fence reports current so cleanup runs.
    expect(
      establishStillCurrent({ establishGeneration: 4, currentGeneration: 4 }),
    ).toBe(true);
  });

  it("is fail-closed on a counter that somehow went BACKWARDS (defensive — never expected)", () => {
    // The counter is monotonic in production, but if a snapshot is somehow higher than the
    // live counter, equality still only proceeds on an EXACT match — anything else bails.
    expect(
      establishStillCurrent({ establishGeneration: 5, currentGeneration: 4 }),
    ).toBe(false);
  });
});

describe("runFencedPublish — fence PLACEMENT in the establish tail (the wiring, not just the math)", () => {
  // Build the injected deps + a generation cell whose value can be advanced AT the read
  // boundary, so the test reproduces a logout / account-switch racing the profile read.
  function harness(opts: { advanceDuringRead?: boolean } = {}) {
    let live = 7; // the live generation; the establish snapshots 7 below
    const order: string[] = [];
    const armProvisional = vi.fn(() => order.push("armProvisional"));
    const armAuthoritative = vi.fn(() => order.push("armAuthoritative"));
    const persist = vi.fn(() => order.push("persist"));
    const publish = vi.fn(() => order.push("publish"));
    const readProfile = vi.fn(async () => {
      order.push("readProfile");
      // SUPERSESSION DURING THE READ: a logout / new login advances the live counter while
      // the profile is in flight — exactly the race the fence guards.
      if (opts.advanceDuringRead) live += 1;
      return { storages: ["https://pod.example/"] };
    });
    return {
      run: () =>
        runFencedPublish<{ storages: string[] }>(7, {
          liveGeneration: () => live,
          armProvisional,
          readProfile,
          armAuthoritative,
          persist,
          publish,
        }),
      armProvisional,
      armAuthoritative,
      persist,
      publish,
      order,
    };
  }

  it("CURRENT: arms provisional → reads → arms authoritative → persists → publishes, in order", async () => {
    const h = harness();
    await expect(h.run()).resolves.toBe(true);
    expect(h.order).toEqual([
      "armProvisional",
      "readProfile",
      "armAuthoritative",
      "persist",
      "publish",
    ]);
  });

  it("SUPERSEDED during the read: BAILS — no authoritative arm, no persist, NO publish (the fence)", async () => {
    // This is the security-critical placement assertion: the provisional arm + the read still
    // happen (the read was already in flight), but once the generation moved, NOTHING that
    // would re-enable reads against a superseded provider or publish a stale session runs.
    // WEAKEN: delete the `establishStillCurrent` guard in runFencedPublish (always proceed)
    // and armAuthoritative/persist/publish fire anyway — this assertion flips. RESTORE ⇒ green.
    const h = harness({ advanceDuringRead: true });
    await expect(h.run()).resolves.toBe(false);
    expect(h.armProvisional).toHaveBeenCalledTimes(1); // the read was already committed
    expect(h.armAuthoritative).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.order).toEqual(["armProvisional", "readProfile"]); // bailed right after the read
  });

  it("propagates a profile-read REJECTION without arming/publishing (the caller owns failure cleanup)", async () => {
    const boom = new Error("profile read failed");
    const armAuthoritative = vi.fn();
    const publish = vi.fn();
    await expect(
      runFencedPublish<{ storages: string[] }>(1, {
        liveGeneration: () => 1,
        armProvisional: vi.fn(),
        readProfile: async () => {
          throw boom;
        },
        armAuthoritative,
        publish,
      }),
    ).rejects.toBe(boom);
    expect(armAuthoritative).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
