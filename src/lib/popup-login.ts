/**
 * popup-login.ts — the app-owned OAuth popup lifecycle (first-party login UI).
 *
 * Replaces the `<authorization-code-flow>` web component from
 * @solid/reactive-authentication: the PROTOCOL layer (WebIdDPoPTokenProvider)
 * stays, but the popup that drives the user through the authorization
 * endpoint is now owned by the app, so the React UI controls every state.
 *
 * The lifecycle rules (each one was a real bug class in popup logins):
 *
 * 1. **Open ONE named popup synchronously in the click handler — but ONLY
 *    when the login can actually need one.** Popup blockers allow
 *    `window.open` only while the user activation is live; the token provider
 *    needs async work (issuer discovery) before it knows the authorization
 *    URL. So the UI calls {@link openPopupUnlessRenewable} synchronously on
 *    click: when the provider's synchronous probe says a cached session or
 *    refresh token completes the login with fetches alone, NO window is
 *    opened (no about:blank flash); otherwise an `about:blank` named window
 *    opens immediately and the provider's later `getCode` NAVIGATES it —
 *    browsers allow navigating an already-open named window without fresh
 *    activation. When the probe was wrong (the refresh grant is rejected
 *    after the activation is spent), `getCode` finds no popup, the fresh
 *    `window.open` is blocked, and the flow recovers through the `onBlocked`
 *    affordance — never a raw unactivated open.
 * 2. **When the provider goes silent first, the interactive retry uses the
 *    SAME window.** On background re-auth the provider tries `prompt=none`;
 *    when the server answers `login_required` / `interaction_required` /
 *    `consent_required` the popup is kept open so the interactive retry
 *    re-navigates it (upstream reactive-authentication PR #13's insight —
 *    closing it would strand the retry behind the popup blocker, the original
 *    click's activation being already consumed). Explicit user-initiated
 *    logins skip the silent hop entirely (the provider navigates straight to
 *    the interactive authorize URL); this controller is mode-agnostic.
 * 3. **Strict message checks.** The callback page posts its URL (carrying the
 *    OAuth `code`) via `postMessage`; only messages whose `event.origin` is
 *    the callback's origin AND whose `event.source` is OUR popup window are
 *    accepted — anything else (extensions, hostile frames, other components)
 *    can neither end the flow nor spoof a code.
 * 4. **No dangling state.** Every exit path (code received, user closed the
 *    popup, app-side cancel, abort signal, timeout) removes the message
 *    listener, stops the closed-poll, and settles the promise exactly once.
 */

/** The browser window surface the controller needs — injectable for tests. */
export interface MessageEventLike {
  origin: string;
  source: unknown;
  data: unknown;
}

/** The popup window surface the controller needs — injectable for tests. */
export interface PopupWindowLike {
  closed: boolean;
  close(): void;
  focus?(): void;
}

/** The opener window surface the controller needs — injectable for tests. */
export interface OpenerWindowLike {
  open(
    url?: string,
    target?: string,
    features?: string,
  ): PopupWindowLike | null;
  addEventListener(
    type: "message",
    listener: (event: MessageEventLike) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEventLike) => void,
  ): void;
}

/** `window.open` returned null and no `onBlocked` handler could recover. */
export class PopupBlockedError extends Error {
  constructor() {
    super(
      "The browser blocked the sign-in window. Allow popups for this site and try again.",
    );
    this.name = "PopupBlockedError";
  }
}

/** A user cancellation (popup closed, app cancel) — matches the app's AbortError copy. */
function cancelled(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

export interface PopupLoginControllerOptions {
  /**
   * The origin of the OAuth callback page (`/callback.html`) — the ONLY
   * `event.origin` accepted for the postMessage that ends the flow.
   */
  expectedOrigin: string;
  /** The opener window. Defaults to `globalThis.window`; injectable for tests. */
  windowRef?: OpenerWindowLike;
  /**
   * Called when the flow needs a popup but the browser blocked `window.open`
   * (e.g. a silent re-auth triggered by a background 401, with no user
   * activation). The app surfaces UI whose click handler calls `resume()`
   * (re-opening under fresh activation) or `cancel()`. Without a handler the
   * flow rejects with {@link PopupBlockedError}.
   */
  onBlocked?: (resume: () => void, cancel: () => void) => void;
  /** Reject the code request after this long. Default 5 minutes. */
  timeoutMs?: number;
  /** How often to poll for the user having closed the popup. Default 500ms. */
  pollMs?: number;
}

/** One shared window name: every navigation reuses the same popup. */
const POPUP_NAME = "podManagerLogin";
const POPUP_FEATURES = "popup=yes,width=480,height=760";
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_MS = 500;
/** After the popup closes, wait this long for an already-posted message. */
const CLOSE_GRACE_MS = 1_000;

/**
 * Whether the authorization response is one the token provider retries
 * interactively right away — so the popup must stay OPEN for that retry to
 * re-navigate this same window (closing it would strand the retry behind the
 * popup blocker, the click's activation already spent).
 *
 * Two cases:
 *  - an explicit OIDC "the user must interact" error
 *    (`login_required` / `interaction_required` / `consent_required`); or
 *  - a NON-CALLBACK landing: a response carrying neither `code` nor `error`.
 *    Servers that ignore `prompt=none` (NSS, Trinpod) serve their HTML login
 *    page at HTTP 200 with no OIDC parameter; the provider reclassifies that as
 *    an implicit `interaction_required` (see `isNonCallbackResponse` there), so
 *    the popup must likewise stay open for the interactive retry. Detected by
 *    SHAPE, server-agnostically — never by hostname.
 */
function needsInteraction(authorizationResponse: string): boolean {
  let params: URLSearchParams;
  try {
    params = new URL(authorizationResponse).searchParams;
  } catch {
    // Unparsable: not our callback at all — keep the window for the retry.
    return true;
  }
  const error = params.get("error");
  if (
    error === "login_required" ||
    error === "interaction_required" ||
    error === "consent_required"
  ) {
    return true;
  }
  // Neither a code nor an error: a non-callback landing (prompt=none ignored).
  return !params.has("code") && error === null;
}

/**
 * The shape of the provider-side probe {@link openPopupUnlessRenewable}
 * consults — `WebIdDPoPTokenProvider.canRenewWithoutInteraction`, stated
 * structurally so this module needs no import from the protocol layer.
 */
export interface RenewProbe {
  canRenewWithoutInteraction(issuer: URL, expectedWebId?: string): boolean;
}

/**
 * The click-handler front door (lifecycle rule 1): open the login popup
 * synchronously UNLESS the provider's SYNCHRONOUS probe says this login will
 * complete without any authorize navigation — a live cached session, or a
 * refresh token (the refresh grant is a plain fetch). Call this FIRST in the
 * click/submit handler, before any `await`: when a popup IS needed, the
 * `window.open` happens inside the user activation.
 *
 * The probe only ever skips the popup on a confident YES. No provider yet
 * (auth module still loading), no issuer known synchronously (typed WebID —
 * its issuer is on the profile, a network hop away), or an unparsable issuer
 * all open the popup, preserving the pre-probe behaviour. And when a YES
 * turns out wrong (the refresh grant is rejected after the activation is
 * spent), the provider falls back to the code flow, whose blocked
 * `window.open` is recovered through the controller's `onBlocked` affordance
 * — a button click that supplies fresh activation — never a raw unactivated
 * open.
 */
export function openPopupUnlessRenewable(
  controller: PopupLoginController,
  provider: RenewProbe | null | undefined,
  issuer: string | undefined,
  expectedWebId?: string,
): void {
  if (provider != null && issuer !== undefined) {
    let renewable = false;
    try {
      // WEBID-AWARE (the #123 roborev MEDIUM): pass the known target WebID so the probe only
      // says "no popup needed" when the cached session is for THAT WebID. A same-issuer switch
      // to a different WebID needs a fresh interactive auth, so the popup MUST open here, inside
      // the user activation — otherwise the interactive auth lands outside it (blocked popup).
      renewable = provider.canRenewWithoutInteraction(new URL(issuer), expectedWebId);
    } catch {
      // Unparsable issuer: open the popup and let the login flow surface the
      // error (its failure path closes the dangling window).
    }
    if (renewable) return;
  }
  controller.open();
}

export class PopupLoginController {
  readonly #expectedOrigin: string;
  readonly #window: OpenerWindowLike;
  readonly #onBlocked?: (resume: () => void, cancel: () => void) => void;
  readonly #timeoutMs: number;
  readonly #pollMs: number;
  #popup: PopupWindowLike | null = null;
  /** Cancels the pending code request, when one is in flight. */
  #cancelPending: ((reason: unknown) => void) | null = null;

  constructor(options: PopupLoginControllerOptions) {
    this.#expectedOrigin = options.expectedOrigin;
    this.#window =
      options.windowRef ?? (globalThis.window as unknown as OpenerWindowLike);
    this.#onBlocked = options.onBlocked;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  }

  /** Whether a popup window is currently open. */
  get isOpen(): boolean {
    return this.#popup !== null && !this.#popup.closed;
  }

  /**
   * Open (or re-focus) the named popup. **Call synchronously inside the user's
   * click handler** — this is what preserves the user activation; everything
   * after it may be async. Safe to call when a popup is already open (the
   * named window is reused).
   */
  open(): void {
    const popup = this.#window.open("about:blank", POPUP_NAME, POPUP_FEATURES);
    if (popup !== null) {
      this.#popup = popup;
      popup.focus?.();
    }
  }

  /**
   * Cancel the in-flight code request from the app (e.g. a Cancel button):
   * closes the popup, removes listeners, rejects the pending promise with an
   * `AbortError`. No-op when nothing is pending (still closes a stray popup).
   */
  cancel(): void {
    if (this.#cancelPending !== null) {
      this.#cancelPending(cancelled("Sign-in was cancelled."));
    } else {
      this.closeIfOpen();
    }
  }

  /** Close the popup if it is open (e.g. login failed before getCode ran). */
  closeIfOpen(): void {
    if (this.#popup !== null && !this.#popup.closed) {
      this.#popup.close();
    }
    this.#popup = null;
  }

  /**
   * The `GetCodeCallback` for the token provider: navigate the popup to the
   * authorization URI and resolve with the callback URL posted back by
   * `/callback.html`. Pass `controller.getCode.bind(controller)` (or an arrow)
   * to the provider.
   */
  async getCode(authorizationUri: URL, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    // Supersede any stale pending flow (its popup is being re-navigated).
    this.#cancelPending?.(cancelled("Superseded by a new sign-in attempt."));

    const popup = await this.#navigate(authorizationUri, signal);
    this.#popup = popup;

    return new Promise<string>((resolve, reject) => {
      let settled = false;

      // The executor runs to completion before any of these can fire, so the
      // timer consts below are always initialised when cleanup() runs.
      const cleanup = () => {
        settled = true;
        this.#window.removeEventListener("message", onMessage);
        signal.removeEventListener("abort", onAbort);
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
        this.#cancelPending = null;
      };

      const fail = (reason: unknown, closePopup: boolean) => {
        if (settled) return;
        cleanup();
        if (closePopup) this.closeIfOpen();
        reject(reason);
      };

      const onMessage = (event: MessageEventLike) => {
        // Only the callback page, in OUR popup, may end the flow. Anything
        // else (other windows, extensions, a hostile frame) must neither
        // resolve the flow early nor spoof an authorization response.
        if (event.origin !== this.#expectedOrigin) return;
        if (event.source !== this.#popup) return;
        if (typeof event.data !== "string") return;
        if (settled) return;
        cleanup();
        if (needsInteraction(event.data)) {
          // The provider is about to retry interactively: keep the popup open
          // so the retry NAVIGATES this named window (no activation needed).
        } else {
          this.closeIfOpen();
        }
        resolve(event.data);
      };

      const onAbort = () => fail(signal.reason, true);

      const pollTimer = setInterval(() => {
        if (this.#popup === null || this.#popup.closed) {
          clearInterval(pollTimer);
          // A message posted just before the window closed may still be in
          // the queue — give it a moment before treating this as a cancel.
          setTimeout(() => {
            fail(cancelled("The sign-in window was closed."), false);
          }, CLOSE_GRACE_MS);
        }
      }, this.#pollMs);

      const timeoutTimer = setTimeout(() => {
        fail(new DOMException("Sign-in timed out.", "TimeoutError"), true);
      }, this.#timeoutMs);

      this.#cancelPending = (reason) => fail(reason, true);

      this.#window.addEventListener("message", onMessage);
      signal.addEventListener("abort", onAbort);
    });
  }

  /**
   * Navigate the named popup to the authorization URI. When no popup is open
   * and the browser blocks a fresh `window.open` (no user activation — e.g. a
   * background 401), defer to the `onBlocked` handler, whose `resume` must be
   * called from a new user gesture.
   */
  async #navigate(
    authorizationUri: URL,
    signal: AbortSignal,
  ): Promise<PopupWindowLike> {
    // `window.open` with the SAME name navigates the already-open popup
    // (allowed without activation) or opens a fresh one (needs activation).
    const popup = this.#window.open(
      authorizationUri.href,
      POPUP_NAME,
      POPUP_FEATURES,
    );
    if (popup !== null) return popup;

    if (this.#onBlocked === undefined) throw new PopupBlockedError();

    return new Promise<PopupWindowLike>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      this.#onBlocked?.(
        () => {
          // Called from a fresh user gesture: this open() has activation.
          const reopened = this.#window.open(
            authorizationUri.href,
            POPUP_NAME,
            POPUP_FEATURES,
          );
          signal.removeEventListener("abort", onAbort);
          if (reopened !== null) resolve(reopened);
          else reject(new PopupBlockedError());
        },
        () => {
          signal.removeEventListener("abort", onAbort);
          reject(cancelled("Sign-in was cancelled."));
        },
      );
    });
  }
}
