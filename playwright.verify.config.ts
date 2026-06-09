import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: /golden-path\.verify\.spec\.ts/,
  fullyParallel: false, workers: 1, timeout: 90_000, expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: { baseURL: "http://localhost:3201", trace: "retain-on-failure", headless: true },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
