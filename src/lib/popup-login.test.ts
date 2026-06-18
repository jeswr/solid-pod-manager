/**
 * popup-login.test.ts — the app-owned OAuth popup lifecycle.
 *
 * The security-critical behaviour is the postMessage gate: ONLY a string
 * message from the expected origin AND from our own popup window may end the
 * flow. Everything else (spoofed origins, other windows, structured data)
 * must be ignored. Lifecycle behaviour — silent→interactive same-window
 * reuse, cancel, user-closed popup, timeout, blocked-popup recovery — is
 * driven through a fake window so the tests run in plain Node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openPopupUnlessRenewable,
  PopupBlockedError,
  PopupLoginController,
  type MessageEventLike,
  type OpenerWindowLike,
  type PopupWindowLike,
  type RenewProbe,
} from "./popup-login";

const ORIGIN = "https://app.test";
const AUTH_URI = new URL("https://as.test/authorize?client_id=x");

class FakePopup implements PopupWindowLike {
  closed = false;
  focused = 0;
  urls: string[] = [];
  close(): void {
    this.closed = true;
  }
  focus(): void {
    this.focused++;
  }
}

class FakeWindow implements OpenerWindowLike {
  listeners = new Set<(event: MessageEventLike) => void>();
  popup: FakePopup | null = new FakePopup();
  /** When true, open() is "blocked" (returns null) unless the popup is already open. */
  blockFreshOpens = false;
  opens: string[] = [];

  open(url?: string): PopupWindowLike | null {
    this.opens.push(url ?? "");
    if (this.popup !== null && !this.popup.closed) {
      // Named-window reuse: navigation of the existing popup.
      this.popup.urls.push(url ?? "");
      return this.popup;
    }
    if (this.blockFreshOpens) return null;
    this.popup = new FakePopup();
    this.popup.urls.push(url ?? "");
    return this.popup;
  }

  addEventListener(_: "message", listener: (event: MessageEventLike) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_: "message", listener: (event: MessageEventLike) => void): void {
    this.listeners.delete(listener);
  }
  emit(event: MessageEventLike): void {
    for (const l of [...this.listeners]) l(event);
  }
}

let win: FakeWindow;

function makeController(
  options: Partial<ConstructorParameters<typeof PopupLoginController>[0]> = {},
): PopupLoginController {
  win = new FakeWindow();
  win.popup = null; // no popup until open()/getCode
  return new PopupLoginController({
    expectedOrigin: ORIGIN,
    windowRef: win,
    ...options,
  });
}

const signal = () => new AbortController().signal;

/**
 * Drain the microtask queue (several ticks: getCode's await chain takes more
 * than one) so the controller's message listener is registered / settled
 * state is observable before the test proceeds. Fake-timer safe.
 */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("message gate", () => {
  it("resolves with the callback URL for a message from the right origin and source", async () => {
    const controller = makeController();
    controller.open();
    const code = controller.getCode(AUTH_URI, signal());
    await flush();
    win.emit({
      origin: ORIGIN,
      source: win.popup,
      data: `${ORIGIN}/callback.html?code=abc&state=s`,
    });
    await expect(code).resolves.toBe(`${ORIGIN}/callback.html?code=abc&state=s`);
    // Terminal response: the popup is closed and the listener removed.
    expect(win.popup?.closed).toBe(true);
    expect(win.listeners.size).toBe(0);
  });

  it("ignores messages from a different origin — even with the right source", async () => {
    const controller = makeController();
    controller.open();
    const code = controller.getCode(AUTH_URI, signal());
    await flush();
    win.emit({
      origin: "https://evil.test",
      source: win.popup,
      data: `${ORIGIN}/callback.html?code=spoofed&state=s`,
    });
    // Still pending: the spoof did not settle the flow.
    win.emit({
      origin: ORIGIN,
      source: win.popup,
      data: `${ORIGIN}/callback.html?code=real&state=s`,
    });
    await expect(code).resolves.toContain("code=real");
  });

  it("ignores messages whose source is not our popup window", async () => {
    const controller = makeController();
    controller.open();
    const code = controller.getCode(AUTH_URI, signal());
    await flush();
    win.emit({
      origin: ORIGIN,
      source: { some: "other window" },
      data: `${ORIGIN}/callback.html?code=spoofed&state=s`,
    });
    win.emit({ origin: ORIGIN, source: null, data: `${ORIGIN}/callback.html?code=null&state=s` });
    win.emit({
      origin: ORIGIN,
      source: win.popup,
      data: `${ORIGIN}/callback.html?code=real&state=s`,
    });
    await expect(code).resolves.toContain("code=real");
  });

  it("ignores non-string message data", async () => {
    const controller = makeController();
    controller.open();
    const code = controller.getCode(AUTH_URI, signal());
    await flush();
    win.emit({ origin: ORIGIN, source: win.popup, data: { url: "x" } });
    win.emit({
      origin: ORIGIN,
      source: win.popup,
      data: `${ORIGIN}/callback.html?code=real&state=s`,
    });
    await expect(code).resolves.toContain("code=real");
  });
});

describe("silent → interactive, same window", () => {
  it("keeps the popup open on an interaction-needed response and reuses it for the retry", async () => {
    const controller = makeController();
    controller.open();
    const popup = win.popup;
    expect(popup).not.toBeNull();

    const silent = controller.getCode(AUTH_URI, signal());
    await flush();
    win.emit({
      origin: ORIGIN,
      source: popup,
      data: `${ORIGIN}/callback.html?error=login_required&state=s`,
    });
    await expect(silent).resolves.toContain("error=login_required");
    // The popup survives: the interactive retry must navigate it, not reopen.
    expect(popup?.closed).toBe(false);

    const interactive = controller.getCode(AUTH_URI, signal());
    await flush();
    expect(win.popup).toBe(popup); // same named window, navigated
    expect(popup?.urls.at(-1)).toBe(AUTH_URI.href);
    win.emit({
      origin: ORIGIN,
      source: popup,
      data: `${ORIGIN}/callback.html?code=abc&state=s`,
    });
    await expect(interactive).resolves.toContain("code=abc");
    expect(popup?.closed).toBe(true);
  });

  it("closes the popup on terminal errors (e.g. access_denied)", async () => {
    const controller = makeController();
    controller.open();
    const code = controller.getCode(AUTH_URI, signal());
    await flush();
    win.emit({
      origin: ORIGIN,
      source: win.popup,
      data: `${ORIGIN}/callback.html?error=access_denied&state=s`,
    });
    await expect(code).resolves.toContain("access_denied");
    expect(win.popup?.closed).toBe(true);
  });
});

describe("cancellation and cleanup", () => {
  it("cancel() rejects the pending flow with AbortError, closes the popup, removes listeners", async () => {
    const controller = makeController();
    controller.open();
    const code = controller.getCode(AUTH_URI, signal());
    await flush();
    controller.cancel();
    await expect(code).rejects.toMatchObject({ name: "AbortError" });
    expect(win.popup?.closed).toBe(true);
    expect(win.listeners.size).toBe(0);
  });

  it("rejects as cancelled when the user closes the popup", async () => {
    const controller = makeController();
    controller.open();
    const code = controller.getCode(AUTH_URI, signal());
    await flush();
    win.popup?.close(); // the user closes the window
    // Attach the handler BEFORE advancing timers, or the rejection counts as unhandled.
    const expectation = expect(code).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(2_000); // poll + close grace
    await expectation;
    expect(win.listeners.size).toBe(0);
  });

  it("still resolves when the message lands just before the close is noticed", async () => {
    const controller = makeController();
    controller.open();
    const code = controller.getCode(AUTH_URI, signal());
    await flush();
    win.emit({
      origin: ORIGIN,
      source: win.popup,
      data: `${ORIGIN}/callback.html?code=abc&state=s`,
    });
    await vi.advanceTimersByTimeAsync(5_000); // close-poll keeps quiet after settle
    await expect(code).resolves.toContain("code=abc");
  });

  it("rejects with TimeoutError after the configured timeout", async () => {
    const controller = makeController({ timeoutMs: 10_000 });
    controller.open();
    const code = controller.getCode(AUTH_URI, signal());
    await flush();
    // Attach the handler BEFORE advancing timers, or the rejection counts as unhandled.
    const expectation = expect(code).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(10_001);
    await expectation;
    expect(win.popup?.closed).toBe(true);
    expect(win.listeners.size).toBe(0);
  });

  it("rejects when the abort signal fires and closes the popup", async () => {
    const controller = makeController();
    controller.open();
    const abort = new AbortController();
    const code = controller.getCode(AUTH_URI, abort.signal);
    await flush();
    abort.abort(new Error("flow torn down"));
    await expect(code).rejects.toThrow("flow torn down");
    expect(win.popup?.closed).toBe(true);
    expect(win.listeners.size).toBe(0);
  });
});

describe("blocked-popup recovery", () => {
  it("throws PopupBlockedError when open is blocked and no handler exists", async () => {
    const controller = makeController();
    win.blockFreshOpens = true; // no open() call happened in a click handler
    await expect(controller.getCode(AUTH_URI, signal())).rejects.toBeInstanceOf(
      PopupBlockedError,
    );
  });

  it("defers to onBlocked; resume() under a fresh gesture re-opens and the flow completes", async () => {
    let handlers: { resume: () => void; cancel: () => void } | null = null;
    const controller = makeController({
      onBlocked: (resume, cancel) => {
        handlers = { resume, cancel };
      },
    });
    win.blockFreshOpens = true;
    const code = controller.getCode(AUTH_URI, signal());
    await flush();
    expect(handlers).not.toBeNull();

    // The user clicks "Open sign-in window": fresh activation, open allowed.
    win.blockFreshOpens = false;
    handlers!.resume();
    await flush();
    win.emit({
      origin: ORIGIN,
      source: win.popup,
      data: `${ORIGIN}/callback.html?code=abc&state=s`,
    });
    await expect(code).resolves.toContain("code=abc");
  });

  it("onBlocked cancel() rejects the flow as cancelled", async () => {
    let handlers: { resume: () => void; cancel: () => void } | null = null;
    const controller = makeController({
      onBlocked: (resume, cancel) => {
        handlers = { resume, cancel };
      },
    });
    win.blockFreshOpens = true;
    const code = controller.getCode(AUTH_URI, signal());
    await flush();
    handlers!.cancel();
    await expect(code).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("openPopupUnlessRenewable (the click-handler front door)", () => {
  const probe = (answer: boolean): RenewProbe => ({
    canRenewWithoutInteraction: () => answer,
  });

  it("does NOT open any window when the probe says the session suffices", () => {
    const controller = makeController();
    openPopupUnlessRenewable(controller, probe(true), "https://as.test");
    expect(win.opens).toEqual([]); // window.open never called — no flash
    expect(controller.isOpen).toBe(false);
  });

  it("opens the popup synchronously when the probe says interaction may be needed", () => {
    const controller = makeController();
    openPopupUnlessRenewable(controller, probe(false), "https://as.test");
    expect(win.opens).toEqual(["about:blank"]);
    expect(controller.isOpen).toBe(true);
  });

  it("opens the popup when no provider is ready yet (loading ≠ yes)", () => {
    const controller = makeController();
    openPopupUnlessRenewable(controller, null, "https://as.test");
    expect(win.opens).toEqual(["about:blank"]);
  });

  it("opens the popup when the issuer is not known synchronously (typed WebID)", () => {
    const controller = makeController();
    const spy = vi.fn(() => true);
    openPopupUnlessRenewable(controller, { canRenewWithoutInteraction: spy }, undefined);
    expect(spy).not.toHaveBeenCalled();
    expect(win.opens).toEqual(["about:blank"]);
  });

  it("opens the popup for an unparsable issuer instead of throwing", () => {
    const controller = makeController();
    const spy = vi.fn(() => true);
    openPopupUnlessRenewable(controller, { canRenewWithoutInteraction: spy }, "not a url");
    expect(spy).not.toHaveBeenCalled(); // new URL threw before the probe ran
    expect(win.opens).toEqual(["about:blank"]);
  });

  it("hands the probe the parsed issuer URL (and the expected WebID when given)", () => {
    const controller = makeController();
    const spy = vi.fn((issuer: URL) => issuer instanceof URL);
    openPopupUnlessRenewable(controller, { canRenewWithoutInteraction: spy }, "https://as.test");
    expect(spy).toHaveBeenCalledWith(new URL("https://as.test"), undefined);

    // WEBID-AWARE (the #123): the optional expected WebID is forwarded to the probe.
    const spy2 = vi.fn(() => false);
    openPopupUnlessRenewable(
      controller,
      { canRenewWithoutInteraction: spy2 },
      "https://as.test",
      "https://pod.test/bob#me",
    );
    expect(spy2).toHaveBeenCalledWith(new URL("https://as.test"), "https://pod.test/bob#me");
  });

  it("opens the popup when the cached session is for a DIFFERENT WebID (same-issuer switch; the #123)", () => {
    const controller = makeController();
    // A WebID-aware probe: renewable for Alice, NOT for Bob on the same issuer.
    const probeFor = (sessionWebId: string) => ({
      canRenewWithoutInteraction: (_issuer: URL, expectedWebId?: string) =>
        expectedWebId === undefined || expectedWebId === sessionWebId,
    });
    // Switching to Bob while a session for Alice is cached → not renewable → popup OPENS (inside
    // the user activation), so the fresh interactive auth for Bob is not left unactivated.
    openPopupUnlessRenewable(
      controller,
      probeFor("https://pod.test/alice#me"),
      "https://as.test",
      "https://pod.test/bob#me",
    );
    expect(win.opens).toEqual(["about:blank"]);
  });
});

describe("open()", () => {
  it("open() then getCode navigates the SAME named window (activation preserved)", async () => {
    const controller = makeController();
    controller.open(); // synchronous, in the click handler
    const popup = win.popup;
    expect(popup?.urls).toEqual(["about:blank"]);
    expect(controller.isOpen).toBe(true);

    const code = controller.getCode(AUTH_URI, signal());
    await flush();
    expect(win.popup).toBe(popup);
    expect(popup?.urls).toEqual(["about:blank", AUTH_URI.href]);
    win.emit({
      origin: ORIGIN,
      source: popup,
      data: `${ORIGIN}/callback.html?code=abc&state=s`,
    });
    await expect(code).resolves.toContain("code=abc");
  });

  it("closeIfOpen() closes a dangling popup when login fails before getCode", () => {
    const controller = makeController();
    controller.open();
    expect(controller.isOpen).toBe(true);
    controller.closeIfOpen(); // e.g. WebID resolution failed
    expect(controller.isOpen).toBe(false);
    expect(win.popup?.closed).toBe(true);
  });
});
