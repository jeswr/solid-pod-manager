/**
 * Golden-path e2e (DESIGN.md P1): login → see My data, against a real local
 * Community Solid Server seeded by global-setup.ts (account `alice`).
 *
 * Login UX error states are tested first — they are the executable form of the
 * solid-reactive-authentication UX spec and fail loudest. The happy path drives
 * the full Solid-OIDC popup (CSS login → authorize) and asserts the
 * authenticated "My data" taxonomy renders.
 *
 * Patterns (test-infra skill): role/placeholder locators, auto-waits (no
 * sleep), the OIDC popup captured via `context.waitForEvent("page")`, and the
 * transient `prompt=none` popup (which closes itself) tolerated.
 */
import { test, expect, type Page } from "@playwright/test";

const WEBID = "http://localhost:3099/alice/profile/card#me"; // seeded by global-setup
const EMAIL = "alice@example.com";
const PASSWORD = "test-password-123";

test.describe("Login surface", () => {
  test("shows WebID-first entry with a get-a-pod affordance", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /your data, your rules/i })).toBeVisible();
    await expect(page.locator('input[type="url"]')).toBeVisible();
    await expect(page.getByRole("link", { name: /get .*pod/i })).toBeVisible();
  });

  test("rejects a malformed WebID without navigating away", async ({ page }) => {
    await page.goto("/");
    await page.fill('input[type="url"]', "not-a-valid-url");
    await page.getByRole("button", { name: /^sign in$/i }).click();
    // Native URL validation or the app's own error — either way we stay put.
    await expect(page.locator('input[type="url"]')).toBeVisible();
  });

  test("surfaces an unreachable / non-Solid WebID with a clear error", async ({ page }) => {
    await page.goto("/");
    await page.fill('input[type="url"]', "https://nonexistent.invalid/profile/card#me");
    await page.getByRole("button", { name: /^sign in$/i }).click();
    // Scope to the form's own error (Next injects its own role="alert" route announcer).
    await expect(page.locator("#webid-error")).toBeVisible({ timeout: 20_000 });
  });
});

test.describe("Golden path: login → My data", () => {
  test("logs in through the OIDC popup and browses My data", async ({ page, context }) => {
    await page.goto("/");

    // Confirm a private resource really is auth-gated, so a pass PROVES the auth
    // upgrade ran. The pod root is world-readable on a fresh CSS pod, but its
    // `.acl` (owner-only Control) is not — that is what login unlocks.
    const probe = await page.request.get("http://localhost:3099/alice/.acl", {
      failOnStatusCode: false,
    });
    expect(probe.status()).toBe(401);

    await page.fill('input[type="url"]', WEBID);

    const popupPromise = waitForLoginPopup(context);
    await page.getByRole("button", { name: /^sign in$/i }).click();

    const popup = await popupPromise;
    await completeCssLogin(popup, EMAIL, PASSWORD);

    // Landed authenticated on Home.
    await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible({
      timeout: 30_000,
    });

    // Navigate to My data and see the two-tier taxonomy.
    await page.getByRole("link", { name: /^my data$/i }).first().click();
    await expect(page.getByRole("heading", { name: /^my data$/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/^common$/i)).toBeVisible();
    await expect(page.getByRole("link", { name: /identity/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /health/i })).toBeVisible();
  });
});

/**
 * Wait for the INTERACTIVE login popup. The provider first opens a transient
 * `prompt=none` popup that closes itself; skip it and return the one that shows
 * the CSS login form.
 */
async function waitForLoginPopup(
  context: import("@playwright/test").BrowserContext,
): Promise<Page> {
  for (let i = 0; i < 4; i++) {
    const popup = await context.waitForEvent("page", { timeout: 30_000 });
    await popup.waitForLoadState("domcontentloaded").catch(() => {});
    if (popup.isClosed()) continue;
    // The interactive popup lands on the CSS login/authorize UI.
    const hasLogin = await popup
      .locator('#email, input[name="email"], button:has-text("Authorize")')
      .first()
      .isVisible()
      .catch(() => false);
    if (hasLogin) return popup;
  }
  throw new Error("Interactive login popup never appeared");
}

/** Drive the CSS login + consent screens inside the popup. */
async function completeCssLogin(popup: Page, email: string, password: string): Promise<void> {
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
