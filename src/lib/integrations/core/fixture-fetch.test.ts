import { describe, it, expect } from "vitest";
import { IntegrationSyncError, RateLimitedError } from "./errors.js";
import { fixtureFetch, getJson, postJson } from "./fixture-fetch.js";
import type { FixtureRoute } from "./types.js";

const ROUTES: FixtureRoute[] = [
  { url: "https://api.test/v1/me", json: { id: "u1" } },
  { url: "https://api.test/v1/items", json: { items: [1, 2] } },
  { method: "POST", url: "https://api.test/v1/search", json: { results: [] } },
  { url: "https://api.test/v1/limited", json: {}, status: 429 },
  { url: "https://api.test/v1/broken", json: {}, status: 500 },
];

describe("fixtureFetch", () => {
  const api = fixtureFetch("demo", ROUTES);

  it("answers by method + URL prefix (query strings welcome)", async () => {
    const res = await api("https://api.test/v1/items?limit=5");
    expect(await res.json()).toEqual({ items: [1, 2] });
    const posted = await api("https://api.test/v1/search", { method: "POST" });
    expect(posted.ok).toBe(true);
  });

  it("throws (never hits the network) for an unrecorded call", async () => {
    await expect(api("https://api.test/v1/unknown")).rejects.toBeInstanceOf(
      IntegrationSyncError,
    );
    // Method counts: GET /v1/search is not the recorded POST route.
    await expect(api("https://api.test/v1/search")).rejects.toBeInstanceOf(
      IntegrationSyncError,
    );
  });
});

describe("getJson / postJson error mapping", () => {
  const api = fixtureFetch("demo", ROUTES);

  it("parses JSON on success", async () => {
    await expect(getJson("demo", api, "https://api.test/v1/me")).resolves.toEqual({
      id: "u1",
    });
    await expect(
      postJson("demo", api, "https://api.test/v1/search", { q: "x" }),
    ).resolves.toEqual({ results: [] });
  });

  it("maps 429 to RateLimitedError", async () => {
    await expect(
      getJson("demo", api, "https://api.test/v1/limited"),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("maps other failures to IntegrationSyncError with the status", async () => {
    await expect(getJson("demo", api, "https://api.test/v1/broken")).rejects.toSatisfy(
      (e: unknown) => e instanceof IntegrationSyncError && e.status === 500,
    );
  });
});
