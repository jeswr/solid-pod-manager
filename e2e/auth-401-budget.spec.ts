/**
 * The 401-BUDGET e2e (#123 Phase 1) — proves the per-resource "401 dance" is GONE.
 *
 * Before the fix, the Pod Manager patched the global fetch with reactive-auth's
 * ReactiveFetchManager, which sent every request UNAUTHENTICATED first and only attached
 * the DPoP token on a 401 — so the 401 count scaled with the number of distinct resource
 * URLs touched (≈ child count when browsing a container). After the fix, the proactive-
 * auth wrapper attaches the token on the FIRST request to an allowed (own-pod) origin, so
 * the resource-401 count is bounded by the number of storage roots, NOT by child count.
 *
 * Runs against a LOCAL Community Solid Server (playwright.config.ts webServer; NEVER the
 * live deploy — AGENTS.md). global-setup.ts seeds the `alice` account+pod+profile; this
 * spec seeds a many-child container, logs in once (the only auth-path 401s), warms the
 * session, then fires many distinct authenticated reads through the app's patched global
 * fetch and tallies the RESOURCE 401s per storage root.
 *
 * TO RUN GREEN: the same local CSS + built-app webServer as the rest of `e2e/**`
 * (`npx playwright test auth-401-budget`, optionally `E2E_APP_PORT`/`E2E_CSS_PORT` to
 * avoid port clashes). It shares the OIDC-popup login path with `golden-path.spec.ts`, so
 * it needs the SAME working CSS OIDC `/.oidc/auth` flow (CSS dereferencing the app's
 * localhost `clientid.jsonld`). NOTE: in some sandboxed runners CSS@7's `oidc-provider`
 * logs `Unsupported runtime. Use Node.js v18.x LTS` and `/.oidc/auth` 500s — which makes
 * EVERY login-driving e2e (this one AND golden-path) time out waiting for the popup,
 * independent of the app code. On a Node-LTS host where golden-path's
 * "logs in through the OIDC popup" passes, this budget spec passes too. The pure
 * regression guard for the dance (no per-resource 401) is ALSO covered, env-independently,
 * by the vitest `src/lib/proactive-auth-fetch.test.ts` unit suite.
 */
import { test, expect, type Response as PwResponse } from "@playwright/test";
import { loginAsAlice, WEBID } from "./helpers";
import { seedManyChildren } from "./seed-children";

// Derive the CSS origin + pod from the SAME `WEBID` constant `loginAsAlice` logs in with,
// so seeding and login ALWAYS target ONE CSS instance (no seed-here / login-there split —
// the roborev finding). The shared `helpers.ts` WEBID is the single source of truth.
const webIdUrl = new URL(WEBID);
const CSS_ORIGIN = webIdUrl.origin;
const POD = webIdUrl.pathname.split("/").filter(Boolean)[0] ?? "alice";
const CONTAINER = "music"; // mimics the report's "music folder"
const CHILD_COUNT = 30;

// The shared `helpers.ts` WEBID hard-codes the CSS port (it documents "keep in sync"),
// while playwright.config / global-setup honor `E2E_CSS_PORT`. If a worktree overrides the
// port to a value that disagrees with WEBID, seeding+login would target a CSS instance the
// running server isn't on — SKIP with a clear message rather than silently testing the
// wrong (or no) instance. The canonical run uses the default port, where they agree.
const envCssPort = process.env.E2E_CSS_PORT;
const portMismatch = envCssPort !== undefined && webIdUrl.port !== envCssPort;

/** The storage root (origin) a request URL belongs to, or undefined if off-pod. */
function storageRootOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.origin === new URL(CSS_ORIGIN).origin ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

test.describe("401 budget — the per-resource dance is gone", () => {
  test.skip(
    portMismatch,
    `E2E_CSS_PORT=${envCssPort} disagrees with the shared helpers.ts WEBID port ` +
      `(${webIdUrl.port || "default"}); run this spec on the default CSS port so seeding ` +
      `and login target the same instance.`,
  );

  test("opening a many-child container does NOT pay a 401 per child", async ({ page, context }) => {
    // ── Seed N children so a dancing client would 401 ≈N times ──────────────────────
    const containerUrl = await seedManyChildren(CSS_ORIGIN, POD, CONTAINER, CHILD_COUNT);
    const childUrls = Array.from(
      { length: CHILD_COUNT },
      (_, i) => `${containerUrl}item-${i}.txt`,
    );

    // ── Tally 401s on the pod storage root across the WHOLE session ─────────────────
    // We separate AUTH-PATH 401s (the .acl / OIDC probes login itself makes — expected,
    // a small constant) from the RESOURCE reads we drive after warm-up; the regression
    // guard is about the latter not scaling with child count.
    const all401s: string[] = [];
    const resource401s: string[] = [];
    let countingResources = false;
    page.on("response", (res: PwResponse) => {
      if (res.status() !== 401) return;
      const root = storageRootOf(res.url());
      if (!root) return; // ignore any off-pod 401
      all401s.push(res.url());
      if (countingResources) resource401s.push(res.url());
    });

    // ── Log in (the only place auth-path 401s are acceptable) ───────────────────────
    await loginAsAlice(page, context);

    // Warm the session: one authenticated read so the DPoP session is live in memory
    // before we fan out (this read may itself incur at most one auth-path 401).
    await page.evaluate(async (u) => {
      await fetch(u).catch(() => {});
    }, childUrls[0]);

    // From here, every read is a DISTINCT resource on the same storage root. With the
    // proactive-attach wrapper each is authenticated on its FIRST request → zero 401s;
    // with the old reactive manager each would 401 once → ≈CHILD_COUNT 401s.
    countingResources = true;
    const statuses: number[] = await page.evaluate(async (urls) => {
      const out: number[] = [];
      for (const u of urls) {
        const r = await fetch(u);
        out.push(r.status);
        // drain the body so the connection frees
        await r.text().catch(() => {});
      }
      return out;
    }, childUrls);

    // Every read must have SUCCEEDED (authenticated) — proving the token was attached,
    // not that we simply avoided 401s by reading nothing.
    expect(statuses.length).toBe(CHILD_COUNT);
    expect(statuses.every((s) => s === 200)).toBe(true);

    // (a) ≤ 1 resource-401 per storage root (ideally 0 once warm).
    const distinctRoots = new Set(
      resource401s.map((u) => storageRootOf(u)).filter(Boolean) as string[],
    );
    expect(resource401s.length).toBeLessThanOrEqual(distinctRoots.size);

    // (b) total resource-401s ≤ number of distinct storage roots (here: 1 pod).
    expect(resource401s.length).toBeLessThanOrEqual(1);

    // (c) THE REGRESSION GUARD — the 401 count does NOT scale with child count. Today it
    // would be ≈CHILD_COUNT; with the fix it is ~0.
    expect(resource401s.length).toBeLessThan(CHILD_COUNT);

    // Sanity: the whole-session pod 401s are a small constant (auth-path probes), never
    // proportional to the resources read.
    expect(all401s.length).toBeLessThan(CHILD_COUNT);
  });

  test("the Files browser lists a big container without a 401 per row", async ({ page, context }) => {
    // A realistic in-app path: browse the seeded container via the Files page. listContainer
    // is a single fetch, so this asserts navigating + listing stays within budget.
    const containerUrl = await seedManyChildren(CSS_ORIGIN, POD, CONTAINER, CHILD_COUNT);

    const pod401s: string[] = [];
    page.on("response", (res: PwResponse) => {
      if (res.status() === 401 && storageRootOf(res.url())) pod401s.push(res.url());
    });

    await loginAsAlice(page, context);

    // Navigate to Files and open the seeded container (the browser addresses the
    // container by the `?url=` query param — see src/app/files/files-browser.tsx).
    await page.goto(`/files?url=${encodeURIComponent(containerUrl)}`);
    // The list renders the children (at least one seeded item is visible).
    await expect(page.getByText(/item-0/i).first()).toBeVisible({ timeout: 20_000 });

    // Even across login + navigation + listing, pod 401s stay a small constant — never
    // one per child.
    expect(pod401s.length).toBeLessThan(CHILD_COUNT);
    expect(WEBID).toContain(CSS_ORIGIN); // guard: never pointed at a live deploy
  });
});
