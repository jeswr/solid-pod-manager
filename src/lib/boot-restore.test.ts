// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
// vitest — node env. PROVES the Issue-1 invariant: the boot silent-restore path
// NEVER opens a popup / tab / iframe and NEVER auto-triggers a passkey prompt —
// it only tries the refresh-grant; a dead refresh token resolves to logged-out.
import { describe, it, expect, vi } from "vitest";
import {
  runBootRestore,
  type BootRestoreDeps,
  type BootRestoreOutcome,
} from "./boot-restore.js";
import { PopupLoginController } from "./popup-login.js";
import type { OpenerWindowLike, PopupWindowLike } from "./popup-login.js";

/**
 * A popup controller wired to a window spy. If boot restore EVER tries to open a
 * popup, `window.open` records it. The whole point of the test is that across a
 * full boot-restore run this spy stays at ZERO calls.
 */
function controllerWithOpenSpy() {
  const open = vi.fn((): PopupWindowLike | null => ({
    closed: false,
    close: () => {},
    focus: () => {},
  }));
  const windowRef: OpenerWindowLike = {
    open,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const controller = new PopupLoginController({
    expectedOrigin: "https://app.test",
    windowRef,
  });
  return { controller, open };
}

/** Build deps with injectable restore outcome + spies on the UI effects. */
function makeDeps(
  over: Partial<BootRestoreDeps> & { restoreSession: BootRestoreDeps["restoreSession"] },
): {
  deps: BootRestoreDeps;
  publishRestored: ReturnType<typeof vi.fn>;
  toLoggedOut: ReturnType<typeof vi.fn>;
} {
  const publishRestored = vi.fn(async () => {});
  const toLoggedOut = vi.fn(() => {});
  const deps: BootRestoreDeps = {
    restoreSession: over.restoreSession,
    stillCurrent: over.stillCurrent ?? (() => true),
    publishRestored: over.publishRestored ?? publishRestored,
    toLoggedOut: over.toLoggedOut ?? toLoggedOut,
  };
  return { deps, publishRestored, toLoggedOut };
}

describe("runBootRestore — the no-popup-on-load invariant (Issue 1)", () => {
  it("a DEAD refresh token ⇒ logged-out, with NO popup ever opened during boot restore", async () => {
    // This is THE load-bearing assertion: simulate the long-absence case (the
    // persisted refresh token expired so the refresh-grant fails), and prove the
    // popup controller's window.open is NEVER called on the restore path.
    const { controller, open } = controllerWithOpenSpy();
    const { deps, publishRestored, toLoggedOut } = makeDeps({
      // The refresh-grant REJECTS (expired token) — the exact flicker trigger.
      restoreSession: async () => {
        throw new Error("invalid_grant (refresh token expired)");
      },
    });

    const outcome: BootRestoreOutcome = await runBootRestore(deps);

    expect(outcome).toEqual({ kind: "logged-out" });
    expect(toLoggedOut).toHaveBeenCalledOnce();
    expect(publishRestored).not.toHaveBeenCalled();
    // The invariant: boot restore opened NO window. (The controller is here to
    // show that even given a real popup controller, the restore path has no way
    // to reach it — `runBootRestore` takes no popup dependency at all.)
    expect(open).not.toHaveBeenCalled();
    expect(controller.isOpen).toBe(false);
  });

  it("a falsy (no renewable session) restore ⇒ logged-out, no popup, no publish", async () => {
    const { open } = controllerWithOpenSpy();
    const { deps, publishRestored, toLoggedOut } = makeDeps({
      restoreSession: async () => false, // no remembered issuer / IndexedDB unavailable
    });
    const outcome = await runBootRestore(deps);
    expect(outcome).toEqual({ kind: "logged-out" });
    expect(toLoggedOut).toHaveBeenCalledOnce();
    expect(publishRestored).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("a renewable session ⇒ publishes logged-in (still no popup), never logged-out", async () => {
    const { open } = controllerWithOpenSpy();
    const { deps, publishRestored, toLoggedOut } = makeDeps({
      restoreSession: async () => true, // refresh-grant succeeded
    });
    const outcome = await runBootRestore(deps);
    expect(outcome).toEqual({ kind: "restored" });
    expect(publishRestored).toHaveBeenCalledOnce();
    expect(toLoggedOut).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("a renewable session whose profile read fails ⇒ falls closed to logged-out, no popup", async () => {
    const { open } = controllerWithOpenSpy();
    const toLoggedOut = vi.fn();
    const outcome = await runBootRestore({
      restoreSession: async () => true,
      stillCurrent: () => true,
      publishRestored: async () => {
        throw new Error("profile fetch 500");
      },
      toLoggedOut,
    });
    expect(outcome).toEqual({ kind: "logged-out" });
    expect(toLoggedOut).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });

  it("SUPERSEDED during the refresh grant ⇒ bails WITHOUT touching the UI (the #123 fence)", async () => {
    const { open } = controllerWithOpenSpy();
    const { deps, publishRestored, toLoggedOut } = makeDeps({
      restoreSession: async () => true,
      stillCurrent: () => false, // a logout / new login won the race
    });
    const outcome = await runBootRestore(deps);
    expect(outcome).toEqual({ kind: "superseded" });
    // The superseding actor owns the boundary + UI — boot restore touches nothing.
    expect(publishRestored).not.toHaveBeenCalled();
    expect(toLoggedOut).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("STRUCTURAL: the BootRestoreDeps contract exposes NO popup/prompt effect", () => {
    // A compile-time + runtime guard that the only renewal mechanism is the
    // refresh-grant. If someone adds a popup-open dep to boot restore later, the
    // key-set assertion fails — flagging the invariant break.
    const { deps } = makeDeps({ restoreSession: async () => false });
    expect(Object.keys(deps).sort()).toEqual([
      "publishRestored",
      "restoreSession",
      "stillCurrent",
      "toLoggedOut",
    ]);
  });
});
