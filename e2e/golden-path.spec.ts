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
 * sleep), and the buffered-popup helpers in e2e/helpers.ts.
 */
import { test, expect } from "@playwright/test";
import { bufferPages, completeCssLogin, waitForLoginPopup } from "./helpers";

// CSS port mirrors E2E_CSS_PORT (see playwright.config.ts / global-setup.ts).
const CSS_ORIGIN = `http://localhost:${process.env.E2E_CSS_PORT ?? "3099"}`;
const WEBID = `${CSS_ORIGIN}/alice/profile/card#me`; // seeded by global-setup
const EMAIL = "alice@example.com";
const PASSWORD = "test-password-123";

/**
 * A fresh visitor (no recent accounts) sees the "create a pod" view first; the
 * pod-address form is one tap behind "Already have a pod? Sign in". Reveal it.
 */
async function revealSignInForm(page: Page): Promise<void> {
  await page.goto("/");
  const urlInput = page.locator('input[type="url"]');
  if (!(await urlInput.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: /^sign in$/i }).first().click();
  }
  await urlInput.waitFor({ state: "visible" });
}

test.describe("Login surface", () => {
  test("leads with the value prop and a create-a-pod path", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /one home for all your personal data/i }),
    ).toBeVisible();
    // New users get provider choices to create a pod, no jargon wall.
    await expect(page.getByRole("heading", { name: /create your free pod/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /solidcommunity\.net/i })).toBeVisible();
  });

  test("reveals the pod-address sign-in form on request", async ({ page }) => {
    await revealSignInForm(page);
    await expect(page.getByLabel(/your pod address/i)).toBeVisible();
  });

  test("rejects a malformed pod address without navigating away", async ({ page }) => {
    await revealSignInForm(page);
    await page.fill('input[type="url"]', "not-a-valid-url");
    await page.getByRole("button", { name: /^sign in$/i }).click();
    // Native URL validation or the app's own error — either way we stay put.
    await expect(page.locator('input[type="url"]')).toBeVisible();
  });

  test("surfaces an unreachable / non-Solid address with a clear error", async ({ page }) => {
    await revealSignInForm(page);
    await page.fill('input[type="url"]', "https://nonexistent.invalid/profile/card#me");
    await page.getByRole("button", { name: /^sign in$/i }).click();
    // Scope to the form's own error (Next injects its own role="alert" route announcer).
    await expect(page.locator("#webid-error")).toBeVisible({ timeout: 20_000 });
  });
});

test.describe("Golden path: login → My data", () => {
  test("logs in through the OIDC popup and browses My data", async ({ page, context }) => {
    await revealSignInForm(page);

    // Confirm a private resource really is auth-gated, so a pass PROVES the auth
    // upgrade ran. The pod root is world-readable on a fresh CSS pod, but its
    // `.acl` (owner-only Control) is not — that is what login unlocks.
    const probe = await page.request.get(`${CSS_ORIGIN}/alice/.acl`, {
      failOnStatusCode: false,
    });
    expect(probe.status()).toBe(401);

    await page.fill('input[type="url"]', WEBID);

    // Subscribe BEFORE clicking (see bufferPages docs in helpers.ts).
    const nextPage = bufferPages(context);
    await page.getByRole("button", { name: /^sign in$/i }).click();

    const popup = await waitForLoginPopup(nextPage);
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
