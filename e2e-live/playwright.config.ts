import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  outputDir: "/tmp/login-diag/results",
  use: {
    baseURL: "https://app.solid-test.jeswr.org",
    headless: true,
    trace: "retain-on-failure",
    // Re-enable Chrome's popup blocker (Playwright disables it by default) so we
    // observe the same "Open new window" interstitials a real user sees.
    launchOptions: { ignoreDefaultArgs: ["--disable-popup-blocking"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
