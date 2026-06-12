/**
 * Connect-sources e2e: the 30-app catalog renders tier-honestly, and a
 * demo-mode connect (Spotify, no client id configured) writes the fixture
 * data into the REAL pod (CSS on :3099) — bootstrapping the type index — and
 * the imported items then appear under My data → Media.
 */
import { test, expect } from "@playwright/test";
import { loginAsAlice } from "./helpers";

test.describe("Connect sources", () => {
  test("catalog shows all 30 apps with tier-honest status chips", async ({
    page,
    context,
  }) => {
    await loginAsAlice(page, context);

    await page.goto("/connect");
    await expect(page.getByRole("heading", { name: /connect sources/i })).toBeVisible();

    // All 30 catalog entries render as cards.
    await expect(page.locator('a[href^="/connect/"]')).toHaveCount(30);

    // Tier-honest chips: A unconfigured → Demo; B → approval; C → file import.
    // Copy must match STATUS_COPY in src/components/integration-status.tsx.
    // Twitch is the demo exemplar: a proxy-gated Tier-A app with no production
    // client id, so it stays demo regardless of which apps have gone live in
    // .env.production (Spotify/Discord did — don't assert them as demo).
    const twitchCard = page.locator('a[href="/connect/twitch"]');
    await expect(twitchCard.getByText(/^demo$/i)).toBeVisible();
    const calendarCard = page.locator('a[href="/connect/google-calendar"]');
    await expect(calendarCard.getByText(/needs platform approval/i)).toBeVisible();
    const netflixCard = page.locator('a[href="/connect/netflix"]');
    await expect(netflixCard.getByText(/import a file/i)).toBeVisible();
  });

  test("Tier-C export link: safe external link where the platform has an export page, absent otherwise", async ({
    page,
    context,
  }) => {
    await loginAsAlice(page, context);

    // Netflix has a web export page → a real external <a href> link.
    await page.goto("/connect/netflix");
    const link = page.getByRole("link", { name: /get your export from netflix/i });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "https://www.netflix.com/viewingactivity");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");

    // Apple Health's export is in-app only → no link, just the file hint.
    await page.goto("/connect/apple-health");
    await expect(page.getByText(/Export All Health Data/)).toBeVisible();
    await expect(page.getByRole("link", { name: /get your export from/i })).toHaveCount(0);
  });

  test("Garmin (Tier-B hybrid): approval-gated OAuth path AND a real file import on one page", async ({
    page,
    context,
  }) => {
    await loginAsAlice(page, context);

    await page.goto("/connect/garmin");
    // Level 1 = the page title; the file-import section below adds an <h2>
    // "Import your Garmin export", so this must be scoped to avoid a strict clash.
    await expect(page.getByRole("heading", { level: 1, name: /garmin/i })).toBeVisible();

    // The OAuth path is honestly gated behind platform approval…
    // (the phrase appears both as the tier badge and the alert title — assert at
    // least one is visible without a strict-mode clash).
    await expect(page.getByText(/needs platform approval/i).first()).toBeVisible();

    // …while the file import imports the user's own export today, with the
    // export link pointing at the Garmin activities list.
    await expect(page.getByText(/Import your Garmin export/i)).toBeVisible();
    const exportLink = page.getByRole("link", { name: /get your export from garmin/i });
    await expect(exportLink).toHaveAttribute(
      "href",
      "https://connect.garmin.com/modern/activities",
    );
    await expect(exportLink).toHaveAttribute("target", "_blank");
    await expect(exportLink).toHaveAttribute("rel", "noopener noreferrer");
    // The hint covers both shapes + the full-archive alternative.
    await expect(page.getByText(/Export CSV/)).toBeVisible();
    await expect(page.getByText(/GPX or TCX/)).toBeVisible();

    // Capture the page for the deliverable's manual review.
    await page.screenshot({ path: "/tmp/garmin/connect-garmin.png", fullPage: true });
  });

  test("demo-mode Twitch connect imports fixture data that appears under My data", async ({
    page,
    context,
  }) => {
    await loginAsAlice(page, context);

    // Twitch stays demo (proxy-gated Tier-A, no production client id), so this
    // exercises the demo import path regardless of which apps have gone live.
    await page.goto("/connect");
    await page.locator('a[href="/connect/twitch"]').click();
    await expect(page.getByRole("heading", { name: /twitch/i })).toBeVisible();

    // Honestly labelled demo, with the go-live requirements on show.
    await expect(page.getByText(/demo mode/i)).toBeVisible();
    await expect(page.getByText(/NEXT_PUBLIC_TWITCH_CLIENT_ID/)).toBeVisible();

    // Run the demo import (writes into the real pod through the Solid session).
    await page.getByRole("button", { name: /import demo data/i }).click();
    await expect(page.getByText(/demo data imported/i)).toBeVisible({ timeout: 30_000 });

    // Success points at the populated category (scope to the import section —
    // the "Goes into" header also links Media).
    const mediaChip = page
      .locator('section[aria-label="Import"]')
      .getByRole("link", { name: /^media$/i });
    await expect(mediaChip).toBeVisible();
    await mediaChip.click();

    // The imported documents are now browsable pod data.
    await expect(page.getByRole("heading", { name: /^media$/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("followed-channels.ttl")).toBeVisible({ timeout: 15_000 });
  });
});
