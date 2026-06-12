/**
 * Live hop-trace of the EXPLICIT sign-in path: how many navigations does the
 * popup make between "user clicks Sign in (WebID typed)" and "the IdP's login
 * form is on screen"?
 *
 * Diagnosis target: the silent `prompt=none` attempt that runs first is
 * doomed on a fresh explicit login (no IdP session), so the user watches
 * authorize → callback.html?error=login_required → authorize again before the
 * login page appears. After the interactive-first fix the trace must be
 * authorize → login page with NO callback.html hop.
 *
 * No credentials are needed: the bounce under test happens BEFORE
 * authentication. Run with LOCAL_OUT=<static export dir> to measure a local
 * build over the real origin (see login-diag.spec.ts), and PROBE_OUT=<dir>
 * (default /tmp/skip-silent) for the evidence files, PROBE_LABEL=before|after.
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import * as fs from "node:fs";

const APP = "https://app.solid-test.jeswr.org";
const WEBID =
  process.env.SMOKE_WEBID ??
  "https://solid-test.jeswr.org/signup-smoke-3/profile/card#me";
const OUT = process.env.PROBE_OUT ?? "/tmp/skip-silent";
const LABEL = process.env.PROBE_LABEL ?? "probe";

interface Hop {
  t: number;
  url: string;
}

/** Serve the app origin from a local static export; broker/RS stay live. */
async function routeLocalBuild(context: BrowserContext, outDir: string) {
  const types: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".jsonld": "application/ld+json",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".txt": "text/plain",
    ".woff2": "font/woff2",
  };
  await context.route(`${APP}/**`, async (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    const candidates =
      path === "/"
        ? ["/index.html"]
        : /\.[a-z0-9]+$/i.test(path)
          ? [path]
          : [`${path}.html`, `${path}/index.html`, path];
    for (const candidate of candidates) {
      const file = `${outDir}${candidate}`;
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = candidate.slice(candidate.lastIndexOf("."));
        return route.fulfill({
          body: fs.readFileSync(file),
          contentType: types[ext] ?? "application/octet-stream",
        });
      }
    }
    return route.fulfill({ status: 404, body: "not found (local out)" });
  });
}

test("explicit sign-in: popup hop trace to the IdP login page", async ({
  browser,
}) => {
  const context = await browser.newContext();
  if (process.env.LOCAL_OUT) await routeLocalBuild(context, process.env.LOCAL_OUT);
  const page = await context.newPage();

  const hops: Hop[] = [];
  const t0 = Date.now();
  const record = (url: string) => {
    const u = new URL(url);
    const marks: string[] = [];
    for (const k of ["error", "code", "prompt"]) {
      if (u.searchParams.has(k))
        marks.push(k === "code" ? "code=…" : `${k}=${u.searchParams.get(k)}`);
    }
    const line = `${u.origin}${u.pathname}${marks.length ? `?${marks.join("&")}` : ""}`;
    hops.push({ t: Date.now() - t0, url: line });
    console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] popup → ${line}`);
  };

  context.on("page", (p) => {
    if (p.url() && p.url() !== "about:blank") record(p.url());
    p.on("framenavigated", (f) => {
      if (f === p.mainFrame() && f.url() !== "about:blank") record(f.url());
    });
  });

  await page.goto(APP);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.fill("#webid", WEBID);
  await page.getByRole("button", { name: "Sign in" }).click();

  // Wait for the IdP's interactive login form to be on screen in the popup.
  let loginPage = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && loginPage === null) {
    for (const p of context.pages()) {
      if (p === page) continue;
      if (await p.locator("#kc-login").count().catch(() => 0)) {
        loginPage = p;
        break;
      }
    }
    if (loginPage === null) await page.waitForTimeout(250);
  }

  const callbackHops = hops.filter((h) => h.url.includes("/callback.html"));
  const authorizeHops = hops.filter(
    (h) => h.url.includes("/auth") || h.url.includes("/authorize"),
  );
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    `${OUT}/hops-${LABEL}.json`,
    JSON.stringify(
      {
        label: LABEL,
        webId: WEBID,
        localOut: process.env.LOCAL_OUT ?? null,
        reachedLoginForm: loginPage !== null,
        totalPopupNavigations: hops.length,
        callbackHops: callbackHops.length,
        authorizeHops: authorizeHops.length,
        hops,
      },
      null,
      2,
    ),
  );
  if (loginPage)
    await loginPage.screenshot({ path: `${OUT}/login-page-${LABEL}.png` });

  expect(loginPage, "the IdP login form should appear").not.toBeNull();
  await context.close();
});
