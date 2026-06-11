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
    const spotifyCard = page.locator('a[href="/connect/spotify"]');
    await expect(spotifyCard.getByText(/^demo$/i)).toBeVisible();
    const calendarCard = page.locator('a[href="/connect/google-calendar"]');
    await expect(calendarCard.getByText(/needs platform approval/i)).toBeVisible();
    const netflixCard = page.locator('a[href="/connect/netflix"]');
    await expect(netflixCard.getByText(/import a file/i)).toBeVisible();
  });

  test("demo-mode Spotify connect imports fixture data that appears under My data", async ({
    page,
    context,
  }) => {
    await loginAsAlice(page, context);

    // Open the Spotify connect flow from the catalog.
    await page.goto("/connect");
    await page.locator('a[href="/connect/spotify"]').click();
    await expect(page.getByRole("heading", { name: /spotify/i })).toBeVisible();

    // Honestly labelled demo, with the go-live requirements on show.
    await expect(page.getByText(/demo mode/i)).toBeVisible();
    await expect(page.getByText(/NEXT_PUBLIC_SPOTIFY_CLIENT_ID/)).toBeVisible();

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
    await expect(page.getByText("top-tracks.ttl")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("playlists.ttl")).toBeVisible();
  });
});
