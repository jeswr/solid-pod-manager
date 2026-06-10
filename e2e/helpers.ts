/**
 * Shared e2e helpers for driving the Solid-OIDC popup login against the local
 * CSS (extracted from golden-path.spec.ts so every suite reuses the verified
 * buffered-popup pattern).
 */
import type { BrowserContext, Page } from "@playwright/test";

/**
 * Buffer every new page in the context so none is missed while another is being
 * inspected. Returns a `next(timeout)` that yields pages in arrival order.
 * Subscribe BEFORE clicking login: the transient `prompt=none` popup and the
 * interactive one open ~100ms apart, so an unbuffered waitForEvent misses the
 * second while inspecting the first (observed against the prod build).
 */
export function bufferPages(context: BrowserContext): (timeoutMs: number) => Promise<Page> {
  const queue: Page[] = [];
  let wake: (() => void) | undefined;
  context.on("page", (p) => {
    queue.push(p);
    wake?.();
  });
  return async function next(timeoutMs: number): Promise<Page> {
    if (queue.length === 0) {
      await new Promise<void>((resolve, reject) => {
        wake = resolve;
        setTimeout(() => reject(new Error("timed out waiting for a popup")), timeoutMs);
      });
      wake = undefined;
    }
    const page = queue.shift();
    if (!page) throw new Error("popup queue empty after wake");
    return page;
  };
}

/**
 * Wait for the INTERACTIVE login popup. The provider first opens a transient
 * `prompt=none` popup that bounces to callback.html?error=interaction_required
 * and closes itself; skip anything that is not the CSS login/authorize UI.
 */
export async function waitForLoginPopup(
  nextPage: (timeoutMs: number) => Promise<Page>,
): Promise<Page> {
  for (let i = 0; i < 4; i++) {
    const popup = await nextPage(30_000);
    // Give the popup a moment to render its UI (or close itself).
    const hasLogin = await popup
      .locator('#email, input[name="email"], button:has-text("Authorize")')
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (popup.isClosed()) continue;
    if (hasLogin) return popup;
  }
  throw new Error("Interactive login popup never appeared");
}

/** Drive the CSS login + consent screens inside the popup. */
export async function completeCssLogin(
  popup: Page,
  email: string,
  password: string,
): Promise<void> {
  const emailField = popup.locator('#email, input[name="email"]').first();
  if (await emailField.isVisible().catch(() => false)) {
    await emailField.fill(email);
    await popup.locator('#password, input[name="password"]').first().fill(password);
    await popup.getByRole("button", { name: /log ?in/i }).click();
  }
  // Consent / authorize screen.
  const authorize = popup.getByRole("button", { name: /authorize|consent|continue/i });
  await authorize.first().click({ timeout: 20_000 }).catch(() => {});
}

/** Full login flow from the app's login screen (assumes `page` is on it). */
export async function loginThroughPopup(
  page: Page,
  context: BrowserContext,
  webId: string,
  email: string,
  password: string,
): Promise<void> {
  await page.fill('input[type="url"]', webId);
  const nextPage = bufferPages(context);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  const popup = await waitForLoginPopup(nextPage);
  await completeCssLogin(popup, email, password);
}
