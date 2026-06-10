/**
 * Shared e2e helpers: the seeded account constants and the CSS OIDC popup
 * dance. Imported by spec files only — global-setup.ts must stay
 * self-contained (cross-file imports from it trip Playwright's config
 * transpiler; see its header).
 */
import { expect, type BrowserContext, type Page } from "@playwright/test";

// Keep in sync with CSS_PORT in playwright.config.ts and e2e/global-setup.ts.
export const WEBID = "http://localhost:3099/alice/profile/card#me";
export const EMAIL = "alice@example.com";
export const PASSWORD = "test-password-123";

/**
 * Buffer every new page in the context so none is missed while another is being
 * inspected. Returns a `next(timeout)` that yields pages in arrival order.
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

/** Full golden login: WebID entry → OIDC popup → authenticated Home. */
export async function loginAsAlice(page: Page, context: BrowserContext): Promise<void> {
  await page.goto("/");
  await page.fill('input[type="url"]', WEBID);
  const nextPage = bufferPages(context);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  const popup = await waitForLoginPopup(nextPage);
  await completeCssLogin(popup, EMAIL, PASSWORD);
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible({
    timeout: 30_000,
  });
}
