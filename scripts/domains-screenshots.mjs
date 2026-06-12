#!/usr/bin/env node
/**
 * One-off screenshot harness for the Domains screens (NOT part of the test
 * suites). Drives `next dev` with every network call mocked via Playwright
 * route interception — no CSS, no IdP: the session is "restored" from a
 * mocked WebID profile, and the /account/domains API is replayed from canned
 * responses mirroring prod-solid-server's src/http/domains.ts shapes.
 *
 * Usage: node scripts/domains-screenshots.mjs [--app http://localhost:3200]
 * Output: /tmp/domains-tab/*.png (light + dark, list/add/detail) and
 *         /tmp/purchase-ui/*.png (the Phase 3 buy flow: search/review/
 *         pending-approval/registering/failed).
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const APP = process.argv.includes("--app")
  ? process.argv[process.argv.indexOf("--app") + 1]
  : "http://localhost:3210";
const OUT = "/tmp/domains-tab";
const OUT_PURCHASE = "/tmp/purchase-ui";
mkdirSync(OUT, { recursive: true });
mkdirSync(OUT_PURCHASE, { recursive: true });

const WEBID = "https://pod.example/alice/profile/card#me";
const STORAGE = "https://pod.example/alice/";

const PROFILE_TTL = `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix pim: <http://www.w3.org/ns/pim/space#>.
<${WEBID}> a foaf:Person;
  foaf:name "Alice";
  pim:storage <${STORAGE}>;
  solid:oidcIssuer <https://pod.example/>.
`;

const ROUTING = { cnameTarget: "edge.solid-test.jeswr.org", aTargets: ["198.51.100.7"] };

const CLAIMED = {
  domain: "pod.alice.dev",
  podRoot: STORAGE,
  state: "claimed",
  createdAt: "2026-06-10T09:00:00.000Z",
  routing: ROUTING,
  txtRecord: {
    name: "_solid-domain-challenge.pod.alice.dev",
    value: "pss-verify=4f1f29ab8c52d9f3a6b7e0c1d2e3f405",
    expires: "2026-06-17T09:00:00.000Z",
  },
};
const VERIFIED = {
  domain: "data.alice.dev",
  podRoot: STORAGE,
  state: "verified",
  createdAt: "2026-06-08T12:00:00.000Z",
  verifiedAt: "2026-06-09T08:00:00.000Z",
  lastDnsCheck: "2026-06-12T01:00:00.000Z",
  routing: ROUTING,
};
const LIVE = {
  domain: "alice.dev",
  podRoot: STORAGE,
  state: "live",
  createdAt: "2026-05-01T12:00:00.000Z",
  verifiedAt: "2026-05-01T13:00:00.000Z",
  lastDnsCheck: "2026-06-12T01:00:00.000Z",
  aliasUrl: "https://alice.dev/",
  routing: ROUTING,
};

// --- Purchased bindings (BYOD Phase 3 — server PR #122 shapes) -------------
// NB: purchased bindings NEVER carry txtRecord; the server authors the zone.

const PENDING_PURCHASE = {
  domain: "alice-pods.com",
  podRoot: STORAGE,
  state: "claimed",
  createdAt: "2026-06-12T08:00:00.000Z",
  routing: ROUTING,
  purchase: {
    status: "pending-approval",
    priceUsd: 14,
    requestedAt: "2026-06-12T08:00:00.000Z",
  },
};
const REGISTERING_PURCHASE = {
  domain: "blog-pods.com",
  podRoot: STORAGE,
  state: "claimed",
  createdAt: "2026-06-11T16:00:00.000Z",
  routing: ROUTING,
  purchase: {
    status: "registering",
    priceUsd: 12,
    requestedAt: "2026-06-11T16:00:00.000Z",
    approvedAt: "2026-06-11T18:30:00.000Z",
  },
};
const FAILED_PURCHASE = {
  domain: "oops-pods.net",
  podRoot: STORAGE,
  state: "claimed",
  createdAt: "2026-06-09T10:00:00.000Z",
  routing: ROUTING,
  purchase: {
    status: "failed",
    priceUsd: 11,
    requestedAt: "2026-06-09T10:00:00.000Z",
    approvedAt: "2026-06-09T11:00:00.000Z",
    failureReason: "Registration failed: the registry rejected the operation.",
  },
};

const QUOTES = {
  "alice-pods.com": {
    domain: "alice-pods.com",
    available: true,
    purchasable: true,
    price: { registrationUsd: 14, renewalUsd: 14, currency: "USD" },
    autoRenew: true,
    privacyProtection: true,
    approvalRequired: true,
  },
  "taken.com": {
    domain: "taken.com",
    available: false,
    purchasable: false,
    reason: "This domain is already taken.",
    autoRenew: true,
    privacyProtection: true,
    approvalRequired: true,
  },
  "alice.dev": {
    domain: "alice.dev",
    purchasable: false,
    reason: "The .dev top-level domain is not offered for purchase here.",
    autoRenew: true,
    privacyProtection: true,
    approvalRequired: true,
  },
};

const json = (body, status = 200) => ({
  status,
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify(body),
});

async function preparePage(context, { dark }) {
  const page = await context.newPage();
  await page.addInitScript(
    ([webId, theme]) => {
      localStorage.setItem("solid-pod-manager:active-webid", webId);
      localStorage.setItem("theme", theme);
    },
    [WEBID, dark ? "dark" : "light"],
  );

  // The mocked pod server.
  await page.route("https://pod.example/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    if (path === "/alice/profile/card") {
      return route.fulfill({ status: 200, contentType: "text/turtle", body: PROFILE_TTL });
    }
    if (path === "/account/domains" && method === "GET") {
      return route.fulfill(
        json({
          domains: [CLAIMED, VERIFIED, LIVE, PENDING_PURCHASE, REGISTERING_PURCHASE],
        }),
      );
    }
    if (path === "/account/domains" && method === "POST") {
      return route.fulfill(json(CLAIMED, 201));
    }
    // Purchase flow (Phase 3). The {}-body probe is the feature detection.
    if (path === "/account/domains/quote" && method === "POST") {
      const body = req.postDataJSON() ?? {};
      if (typeof body.domain !== "string") {
        return route.fulfill(
          json({ error: "BadRequest", message: "Field 'domain' is a required string." }, 400),
        );
      }
      const quote = QUOTES[body.domain];
      if (quote) return route.fulfill(json(quote));
      return route.fulfill(
        json({
          domain: body.domain,
          available: true,
          purchasable: true,
          price: { registrationUsd: 9.99, renewalUsd: 12.5, currency: "USD" },
          autoRenew: true,
          privacyProtection: true,
          approvalRequired: true,
        }),
      );
    }
    if (path === "/account/domains/purchase" && method === "POST") {
      return route.fulfill(json(PENDING_PURCHASE, 201));
    }
    if (path === "/account/domains/alice-pods.com" && method === "GET") {
      return route.fulfill(json(PENDING_PURCHASE));
    }
    if (path === "/account/domains/alice-pods.com/verify" && method === "POST") {
      return route.fulfill(json({ ...PENDING_PURCHASE, checks: {} }));
    }
    if (path === "/account/domains/blog-pods.com" && method === "GET") {
      return route.fulfill(json(REGISTERING_PURCHASE));
    }
    if (path === "/account/domains/blog-pods.com/verify" && method === "POST") {
      return route.fulfill(
        json({
          ...REGISTERING_PURCHASE,
          checks: {},
          progress: "Registration in-progress; action needed: PENDING_CUSTOMER_ACTION",
        }),
      );
    }
    if (path === "/account/domains/oops-pods.net" && method === "GET") {
      return route.fulfill(json(FAILED_PURCHASE));
    }
    if (path === "/account/domains/pod.alice.dev" && method === "GET") {
      return route.fulfill(json(CLAIMED));
    }
    if (path === "/account/domains/pod.alice.dev/verify" && method === "POST") {
      return route.fulfill(
        json({
          ...CLAIMED,
          lastDnsCheck: new Date().toISOString(),
          checks: {
            txt: { ok: true, detail: "TXT record found (all resolvers agree)." },
            routing: {
              ok: false,
              detail:
                "Routing record not seen yet. Point the domain at the published CNAME/A targets and retry.",
            },
          },
        }),
      );
    }
    if (path === "/account/domains/alice.dev" && method === "GET") {
      return route.fulfill(json(LIVE));
    }
    return route.fulfill({ status: 404, contentType: "text/plain", body: "not mocked" });
  });
  return page;
}

const run = async () => {
  const browser = await chromium.launch();
  for (const dark of [false, true]) {
    const mode = dark ? "dark" : "light";
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      colorScheme: dark ? "dark" : "light",
    });
    const page = await preparePage(context, { dark });

    // List view (wait for the buy-path probe + the button-variant transition).
    await page.goto(`${APP}/settings/domains`);
    await page.getByText("pod.alice.dev").waitFor({ timeout: 30_000 });
    await page.getByRole("link", { name: /get a new domain/i }).waitFor();
    await page.waitForTimeout(400); // let the variant transition settle
    await page.screenshot({ path: `${OUT}/list-${mode}.png`, fullPage: true });

    // Add flow — input with a value typed.
    await page.goto(`${APP}/settings/domains/add`);
    await page.getByLabel("Domain name").waitFor();
    await page.getByLabel("Domain name").fill("pod.alice.dev");
    await page.screenshot({ path: `${OUT}/add-${mode}.png`, fullPage: true });

    // Detail / DNS setup screen (claimed), then after a manual check.
    await page.goto(`${APP}/settings/domains/domain?name=pod.alice.dev`);
    await page.getByText("_solid-domain-challenge.pod.alice.dev").first().waitFor();
    await page.screenshot({ path: `${OUT}/detail-claimed-${mode}.png`, fullPage: true });
    await page.getByRole("button", { name: /check now/i }).click();
    await page.getByText(/TXT record found/).waitFor();
    await page.screenshot({ path: `${OUT}/detail-checked-${mode}.png`, fullPage: true });

    // Live domain detail.
    await page.goto(`${APP}/settings/domains/domain?name=alice.dev`);
    await page.getByText("https://alice.dev/").first().waitFor();
    await page.screenshot({ path: `${OUT}/detail-live-${mode}.png`, fullPage: true });

    // Release confirm dialog.
    await page.getByRole("button", { name: /disconnect domain/i }).click();
    await page.getByRole("alertdialog").waitFor();
    await page.waitForTimeout(400); // let the open animation settle
    await page.screenshot({ path: `${OUT}/release-confirm-${mode}.png`, fullPage: true });
    await page.keyboard.press("Escape");

    // --- Purchase flow (Phase 3) → /tmp/purchase-ui ------------------------

    // Search: an available, purchasable name with its live price.
    await page.goto(`${APP}/settings/domains/buy`);
    await page.getByLabel("Domain name").waitFor();
    await page.getByLabel("Domain name").fill("alice-pods.com");
    await page.getByRole("button", { name: /check availability/i }).click();
    await page.getByText(/for the first year/).waitFor();
    await page.screenshot({ path: `${OUT_PURCHASE}/buy-search-${mode}.png`, fullPage: true });

    // Review step.
    await page.getByRole("button", { name: /^buy$/i }).click();
    await page.getByText("Review your purchase").waitFor();
    await page.screenshot({ path: `${OUT_PURCHASE}/buy-review-${mode}.png`, fullPage: true });

    // Allowlist refusal — the server's honest reason, verbatim.
    await page.goto(`${APP}/settings/domains/buy`);
    await page.getByLabel("Domain name").waitFor();
    await page.getByLabel("Domain name").fill("alice.dev");
    await page.getByRole("button", { name: /check availability/i }).click();
    await page.getByText(/not offered for purchase/).waitFor();
    await page.screenshot({ path: `${OUT_PURCHASE}/buy-refused-${mode}.png`, fullPage: true });

    // Detail: waiting for operator approval (cancellable).
    await page.goto(`${APP}/settings/domains/domain?name=alice-pods.com`);
    await page.getByText("Waiting for approval").waitFor();
    await page.screenshot({
      path: `${OUT_PURCHASE}/detail-pending-approval-${mode}.png`,
      fullPage: true,
    });

    // Detail: registering, with the server's progress string after a check.
    await page.goto(`${APP}/settings/domains/domain?name=blog-pods.com`);
    await page.getByText("Registering your domain").waitFor();
    await page.getByRole("button", { name: /check now/i }).click();
    await page.getByText(/PENDING_CUSTOMER_ACTION/).waitFor();
    await page.screenshot({
      path: `${OUT_PURCHASE}/detail-registering-${mode}.png`,
      fullPage: true,
    });

    // Detail: a failed registration (honest reason + retry/release).
    await page.goto(`${APP}/settings/domains/domain?name=oops-pods.net`);
    await page.getByText("The registration failed").waitFor();
    await page.screenshot({ path: `${OUT_PURCHASE}/detail-failed-${mode}.png`, fullPage: true });

    await context.close();
  }
  await browser.close();
  console.log(`Screenshots written to ${OUT} and ${OUT_PURCHASE}`);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
