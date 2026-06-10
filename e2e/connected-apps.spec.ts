/**
 * Connected-apps e2e (DESIGN.md P2): against a real local CSS, a fresh
 * account's pod is seeded with a Health category (type index + container) and
 * a fake app's client document; then the FULL permission lifecycle runs in
 * the product UI:
 *
 *   login → consent screen (`/connected-apps/grant?client=…&categories=health`)
 *   → Allow → the `.acl` on the server REALLY grants the agent → Connected
 *   apps lists the app by its client_name → app detail shows the category +
 *   mode → one-click "Revoke all" → the app disappears AND the `.acl` no
 *   longer names the agent (asserted via DPoP-authenticated fetch).
 *
 * The consent screen and revoke button call `WacPermissionsBackend`
 * (src/lib/permissions.ts) in the browser — the lib's grant/revoke paths are
 * what this exercises end to end. (The spec itself cannot import src/lib:
 * Playwright transpiles specs to CJS and `@jeswr/fetch-rdf` publishes only an
 * `import` exports condition.)
 *
 * Fresh account per write test (test-infra skill); buffered-popup login from
 * e2e/helpers.ts.
 */
import { test, expect } from "@playwright/test";
import { createCssAccount, type CssAccount } from "./css-account";
import { loginThroughPopup } from "./helpers";

const BASE = "http://localhost:3099";

/** DPoP-authenticated fetch from the account fixture's client credentials. */
function authedFetch(acct: CssAccount): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    headers.set("authorization", `DPoP ${acct.token}`);
    headers.set("dpop", await acct.proof(method, url));
    return fetch(url, { ...init, headers });
  };
}

test.describe("Connected apps: consent-grant → list → revoke → ACL changed", () => {
  test("grants and revokes a fake app end to end", async ({ page, context }) => {
    test.setTimeout(180_000);

    // ── Fixture: fresh account + Health category + fake app client document ──
    const pod = `p2apps${Date.now()}`;
    const acct = await createCssAccount({ pod, name: "Paula P-Two" });
    const doFetch = authedFetch(acct);

    const put = async (url: string, body: string, contentType: string) => {
      const res = await doFetch(url, {
        method: "PUT",
        headers: { "content-type": contentType },
        body,
      });
      if (!res.ok) throw new Error(`seed PUT ${url} -> ${res.status}: ${await res.text()}`);
    };

    // A Health item so the category exists, and a public type index mapping it.
    const healthContainer = `${acct.podRoot}health/`;
    await put(
      `${healthContainer}log.ttl`,
      `@prefix schema: <https://schema.org/>.
<#m1> a schema:MedicalEntity ; schema:name "Resting heart rate" .`,
      "text/turtle",
    );
    const typeIndex = `${acct.podRoot}settings/publicTypeIndex.ttl`;
    await put(
      typeIndex,
      `@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix schema: <https://schema.org/>.
<> a solid:TypeIndex, solid:ListedDocument .
<#health> a solid:TypeRegistration ;
  solid:forClass schema:MedicalEntity ;
  solid:instanceContainer <${healthContainer}> .`,
      "text/turtle",
    );
    // Re-seed the profile WITH the type-index link (replaces css-account's seed).
    await put(
      `${acct.podRoot}profile/card`,
      `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix pim: <http://www.w3.org/ns/pim/space#>.
<> a foaf:PersonalProfileDocument; foaf:maker <${acct.webId}>; foaf:primaryTopic <${acct.webId}>.
<${acct.webId}> a foaf:Person;
  solid:oidcIssuer <${BASE}/>;
  pim:storage <${acct.podRoot}>;
  solid:publicTypeIndex <${typeIndex}>;
  foaf:name "Paula P-Two".`,
      "text/turtle",
    );
    // The fake app's client document (name + homepage; never a logo). Stored as
    // plain JSON so CSS treats it as an opaque document.
    const fakeAppId = `${acct.podRoot}fitness-tracker-id.json`;
    await put(
      fakeAppId,
      JSON.stringify({
        client_id: fakeAppId,
        client_name: "Fitness Tracker",
        client_uri: "https://fitness-tracker.example",
      }),
      "application/json",
    );

    // ── Login through the OIDC popup as the fresh account ──
    await page.goto("/");
    await loginThroughPopup(page, context, acct.webId, acct.email, acct.password);
    await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible({
      timeout: 30_000,
    });

    // ── The consent screen: per-category, equal-weight choices ──
    await page.goto(
      `/connected-apps/grant?client=${encodeURIComponent(fakeAppId)}&categories=health`,
    );
    await expect(
      page.getByRole("heading", { name: /fitness tracker is asking to access your data/i }),
    ).toBeVisible({ timeout: 30_000 });
    const healthCheckbox = page.getByRole("checkbox", { name: /health/i });
    await expect(healthCheckbox).toBeChecked(); // per-category, pre-selected
    await expect(page.getByRole("button", { name: /don'?t allow/i })).toBeVisible();
    await expect(
      page.getByText(/you can change or revoke this anytime in connected apps/i),
    ).toBeVisible();

    // Allow — this runs WacPermissionsBackend.grant in the browser.
    await page.getByRole("button", { name: /allow selected/i }).click();

    // ── Lands on Connected apps; the app is listed by its human-readable name ──
    await expect(page.getByRole("heading", { name: /^connected apps$/i })).toBeVisible({
      timeout: 30_000,
    });
    const appLink = page.getByRole("link", { name: /fitness tracker/i });
    await expect(appLink).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/can see your/i).first()).toBeVisible();

    // The ACL on the server REALLY grants it now.
    const aclBefore = await (await doFetch(`${healthContainer}.acl`)).text();
    expect(aclBefore).toContain(fakeAppId);

    // ── App detail: per-category row with mode badge + danger zone ──
    await appLink.click();
    await expect(page.getByRole("heading", { name: /fitness tracker/i })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Can view", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /remove all access/i })).toBeVisible();

    // ── Back to the list: one-click revoke ──
    await page.getByRole("link", { name: /^connected apps$/i }).first().click();
    await expect(page.getByRole("link", { name: /fitness tracker/i })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: /^revoke all$/i }).click();

    // Reassuring confirmation (DESIGN.md §6), and the app is gone from the list.
    await expect(
      page.getByText(/fitness tracker can no longer access your data/i),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("link", { name: /fitness tracker/i })).toHaveCount(0, {
      timeout: 20_000,
    });
    await expect(page.getByText(/no apps connected yet/i)).toBeVisible({ timeout: 20_000 });

    // ── The ACL on the server REALLY changed ──
    const aclAfter = await (await doFetch(`${healthContainer}.acl`)).text();
    expect(aclAfter).not.toContain(fakeAppId);
    // The owner's own rule survives (we never lock the user out).
    expect(aclAfter).toContain(acct.webId);
  });
});
