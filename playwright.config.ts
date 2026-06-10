import { defineConfig, devices } from "@playwright/test";

// Ports: the OIDC issuer is resolved from the seeded profile's solid:oidcIssuer (our
// WebIdDPoPTokenProvider callbacks), so the test CSS can run on ANY port — :3099 keeps
// it clear of the prod-solid-server dev stack (RS :3000, broker :3001, import app :3301)
// and of next dev's default :3000. The app runs on :3200 (AGENTS.md §Servers). Keep the
// CSS port in sync with e2e/global-setup.ts and e2e/golden-path.spec.ts — cross-file
// imports from global-setup trip Playwright's config transpiler, so it's repeated there.
const APP_PORT = 3200;
const CSS_PORT = 3099;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    // First hit on a route cold-compiles under `next dev`; give navigations headroom
    // so the first page.goto doesn't eat the whole test budget.
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    headless: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  globalSetup: "./e2e/global-setup.ts",
  webServer: [
    {
      // In-memory WAC CSS, pinned major 7 (AGENTS.md §Servers).
      command: `npx -y @solid/community-server@7 -p ${CSS_PORT}`,
      url: `http://localhost:${CSS_PORT}/`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      // e2e runs against the PRODUCTION build: `next dev` compiles routes on demand and a
      // mid-login rebuild (CSS dereferencing /clientid.jsonld) Fast-Refresh-reloads the page,
      // destroying the in-flight OIDC state — observed and diagnosed, not hypothetical. The
      // prod server has no on-demand compilation, so the flow is deterministic AND we test
      // the real bundle. Never reused: a stale dev server on this port poisons the run.
      command: `npm run build && npx next start -p ${APP_PORT}`,
      url: `http://localhost:${APP_PORT}`,
      timeout: 240_000,
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
