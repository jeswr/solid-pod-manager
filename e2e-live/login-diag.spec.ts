/**
 * Live diagnosis of the Pod Manager login experience at app.solid-test.jeswr.org.
 *
 * Counts every user-visible prompt / popup / redirect between "click Sign in"
 * and "working session", then exercises reload-restore and an authenticated
 * read, recording each hop with a timestamp. Chrome's popup blocker is ON
 * (see playwright.config.ts) to mirror a real user.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- diagnostic spec: monkey-patches window.open/attachShadow and reads untyped instrumentation back out of the page */
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import * as fs from "node:fs";

const APP = "https://app.solid-test.jeswr.org";
const WEBID = process.env.SMOKE_WEBID ?? "https://solid-test.jeswr.org/signup-smoke-3/profile/card#me";
const USER = process.env.SMOKE_USER ?? "signup-smoke-3";
const PASSWORD = process.env.SMOKE_PASSWORD!;

interface Hop { t: number; kind: string; detail: string }

const hops: Hop[] = [];
const t0 = Date.now();
function hop(kind: string, detail: string) {
  hops.push({ t: Date.now() - t0, kind, detail });
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${kind}: ${detail}`);
}

function instrument(context: BrowserContext) {
  // Force shadow roots open so we can see/click the <authorization-code-flow>
  // dialogs; record window.open calls and whether the browser blocked them.
  return context.addInitScript(() => {
    const w = window as any;
    w.__diag = { opens: [] as { url: string; blocked: boolean }[] };
    const origAttach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init: ShadowRootInit) {
      return origAttach.call(this, { ...init, mode: "open" });
    };
    const origOpen = window.open.bind(window);
    window.open = ((url?: any, target?: any, features?: any) => {
      const res = origOpen(url, target, features);
      w.__diag.opens.push({ url: String(url), blocked: res === null });
      return res;
    }) as typeof window.open;
  });
}

function watchPopups(context: BrowserContext) {
  context.on("page", (p) => {
    hop("popup-opened", p.url() || "(about:blank)");
    p.on("framenavigated", (f) => {
      if (f === p.mainFrame()) {
        const u = new URL(f.url());
        // redact query secrets but keep error/code markers
        const marks: string[] = [];
        for (const k of ["error", "code", "prompt", "state"]) {
          if (u.searchParams.has(k)) marks.push(k === "code" ? "code=…" : `${k}=${k === "state" ? "…" : u.searchParams.get(k)}`);
        }
        hop("popup-nav", `${u.origin}${u.pathname}${marks.length ? "?" + marks.join("&") : ""}`);
      }
    });
    p.on("close", () => hop("popup-closed", ""));
  });
}

/** One pass of the interaction loop. Returns true when logged in. */
async function driveLoop(page: Page, context: BrowserContext, label: string, maxMs = 90_000): Promise<boolean> {
  const seen = new Set<string>();
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    // success?
    const active = await page.evaluate(() => localStorage.getItem("solid-pod-manager:active-webid")).catch(() => null);
    const status = await page.evaluate(() => (document.querySelector('[role="alert"]') as HTMLElement)?.innerText ?? null).catch(() => null);
    if (status && !seen.has("err:" + status)) {
      seen.add("err:" + status);
      hop("app-error", `${label}: ${status}`);
    }
    if (active) {
      hop("logged-in", `${label}: active-webid=${active}`);
      return true;
    }

    // main-page dialogs (authorization-code-flow modals, forced-open shadow DOM)
    for (const d of await page.locator("dialog[open]").all().catch(() => [])) {
      const text = (await d.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      if (!text) continue;
      const key = "dlg:" + text;
      if (!seen.has(key)) {
        seen.add(key);
        hop("modal-prompt", `${label}: "${text}"`);
      }
      const openBtn = d.locator('button[value="open"]');
      if (await openBtn.count()) {
        hop("user-click", `${label}: accepted "Open new window" prompt`);
        seen.delete(key); // it may reappear
        await openBtn.click().catch(() => {});
      }
    }

    // popups needing interaction
    for (const p of context.pages()) {
      if (p === page) continue;
      const url = p.url();
      if (/realms\/solid/.test(url) && (await p.locator("#kc-login").count().catch(() => 0))) {
        if (!seen.has("kc:" + url.split("?")[0])) {
          seen.add("kc:" + url.split("?")[0]);
          hop("user-input", `${label}: Keycloak login form (username+password+submit)`);
          await p.fill("#username", USER).catch(() => {});
          await p.fill("#password", PASSWORD).catch(() => {});
          await p.click("#kc-login").catch(() => {});
        }
      }
      const allow = p.locator('button[name="decision"][value="accept"]');
      if ((await allow.count().catch(() => 0)) && !seen.has("consent:" + url)) {
        seen.add("consent:" + url);
        hop("user-click", `${label}: broker consent "Authorize access" -> Allow`);
        await allow.click().catch(() => {});
      }
    }
    await page.waitForTimeout(400);
  }
  return false;
}

/**
 * When LOCAL_OUT is set (a path to a `next build` static export), serve the
 * app's origin from that local build instead of the deployed site — the live
 * broker and Solid server stay real. This lets the same spec measure the
 * deployed code ("before") and the working tree ("after") over the exact
 * origin the Client Identifier Document is bound to.
 */
async function routeLocalBuild(context: BrowserContext, outDir: string) {
  const types: Record<string, string> = {
    ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
    ".json": "application/json", ".jsonld": "application/ld+json",
    ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png",
    ".txt": "text/plain", ".woff2": "font/woff2",
  };
  await context.route(`${APP}/**`, async (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    const candidates = path === "/"
      ? ["/index.html"]
      : /\.[a-z0-9]+$/i.test(path)
        ? [path]
        : [`${path}.html`, `${path}/index.html`, path];
    for (const candidate of candidates) {
      const file = `${outDir}${candidate}`;
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = candidate.slice(candidate.lastIndexOf("."));
        return route.fulfill({ body: fs.readFileSync(file), contentType: types[ext] ?? "application/octet-stream" });
      }
    }
    return route.fulfill({ status: 404, body: "not found (local out)" });
  });
}

async function dumpOpens(page: Page, label: string) {
  const opens = await page.evaluate(() => (window as any).__diag?.opens ?? []).catch(() => []);
  for (const o of opens) hop("window.open", `${label}: blocked=${o.blocked} ${String(o.url).split("?")[0]}`);
}

test("first login, reload restore, authenticated read", async ({ browser }) => {
  test.skip(!PASSWORD, "SMOKE_PASSWORD required");
  const context = await browser.newContext();
  if (process.env.LOCAL_OUT) await routeLocalBuild(context, process.env.LOCAL_OUT);
  await instrument(context);
  watchPopups(context);
  const page = await context.newPage();

  // ---- Phase 1: first login from a clean context ----
  hop("phase", "1: first login (clean context)");
  await page.goto(APP);
  hop("page", "landing loaded");
  await page.getByRole("button", { name: "Sign in" }).click();
  hop("user-click", "toggle 'Already have a pod? Sign in'");
  await page.fill("#webid", WEBID);
  await page.getByRole("button", { name: "Sign in" }).click();
  hop("user-click", "submitted WebID + Sign in");

  const ok = await driveLoop(page, context, "phase1");
  await dumpOpens(page, "phase1");
  await page.screenshot({ path: "/tmp/login-diag/phase1-end.png", fullPage: true });
  expect(ok, "phase 1 should reach a logged-in session").toBe(true);

  // ---- Phase 2: reload (tokens are in-memory; IdP cookie lives) ----
  hop("phase", "2: reload restore");
  await page.evaluate(() => (window as any).__diag && ((window as any).__diag.opens = []));
  await page.reload();
  // restore is silent (public profile read). Wait for the session to settle.
  await page.waitForFunction(() => localStorage.getItem("solid-pod-manager:active-webid"), null, { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(3_000);
  await dumpOpens(page, "phase2-reload");
  hop("page", `after reload, app shows: ${(await page.locator("h1, h2").first().innerText().catch(() => "?")).trim()}`);

  // ---- Phase 3: authenticated read after reload (401 -> re-auth) ----
  hop("phase", "3: authenticated read after reload (fetch pod root .acl)");
  const fetchDone = page.evaluate(async (target) => {
    const r = await fetch(target).catch((e) => ({ status: `threw ${e}` }) as any);
    return (r as Response).status;
  }, "https://solid-test.jeswr.org/signup-smoke-3/.acl");
  const drove = driveLoop(page, context, "phase3", 60_000);
  const status3 = await fetchDone;
  hop("fetch-result", `phase3: GET .acl -> ${status3}`);
  await drove.catch(() => {});
  await dumpOpens(page, "phase3");

  // ---- Phase 4: second authenticated read in the same page (token reuse?) ----
  hop("phase", "4: immediate second authenticated read (same page)");
  await page.evaluate(() => (window as any).__diag && ((window as any).__diag.opens = []));
  const status4 = await page.evaluate(async (target) => {
    const r = await fetch(target).catch((e) => ({ status: `threw ${e}` }) as any);
    return (r as Response).status;
  }, "https://solid-test.jeswr.org/signup-smoke-3/.acl");
  hop("fetch-result", `phase4: GET .acl -> ${status4}`);
  await dumpOpens(page, "phase4");

  fs.writeFileSync("/tmp/login-diag/hops.json", JSON.stringify(hops, null, 2));
  await context.close();
});
