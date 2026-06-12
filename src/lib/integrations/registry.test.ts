import { describe, it, expect } from "vitest";
import { categoryById } from "../categories.js";
import { FILE_ADAPTERS, fileAdapterById } from "./file-adapters.js";
import {
  ADAPTERS,
  adapterById,
  allCatalogEntries,
  isLive,
  statusOf,
  TIER_B,
  TIER_B_ADAPTERS,
  TIER_C,
} from "./registry.js";

describe("integrations registry", () => {
  it("exposes exactly 30 catalog entries with unique, URL-safe ids", () => {
    const entries = allCatalogEntries();
    expect(entries).toHaveLength(30);
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(30);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it("ships the 8 Tier-A adapters from the catalog", () => {
    expect(ADAPTERS.map((a) => a.metadata.id).sort()).toEqual([
      "discord",
      "dropbox",
      "github",
      "notion",
      "reddit",
      "spotify",
      "strava",
      "twitch",
    ]);
    for (const a of ADAPTERS) {
      expect(a.metadata.tier).toBe("A");
      expect(a.metadata.authKind).toBe("oauth-pkce");
      expect(a.oauth).toBeDefined();
      expect(a.fixtures().length).toBeGreaterThan(0);
      expect(a.metadata.requirements.length).toBeGreaterThan(0); // honest go-live list
      expect(adapterById(a.metadata.id)).toBe(a);
    }
  });

  it("ships the 12 Tier-B adapters, each demoable now with an honest blocker", () => {
    expect(TIER_B_ADAPTERS.map((a) => a.metadata.id).sort()).toEqual([
      "facebook",
      "fitbit",
      "garmin",
      "google-calendar",
      "google-photos",
      "instagram",
      "linkedin",
      "pinterest",
      "slack",
      "tiktok",
      "x-twitter",
      "youtube",
    ]);
    for (const a of TIER_B_ADAPTERS) {
      expect(a.metadata.tier).toBe("B");
      expect(a.metadata.authKind).toBe("oauth-pkce");
      expect(a.oauth).toBeDefined();
      // A real, fixture-backed import drives the demo.
      expect(a.fixtures().length).toBeGreaterThan(0);
      // The first requirement is the specific platform-approval blocker.
      expect(a.metadata.requirements.length).toBeGreaterThan(0);
      expect(adapterById(a.metadata.id)).toBe(a);
      // Even with config they never auto-go-live: the catalog gates them.
      expect(statusOf({ ...a.metadata })).toBe("approval-needed");
    }
  });

  it("Tier-B catalog entries are derived from the adapters and carry a blocker", () => {
    expect(TIER_B).toHaveLength(TIER_B_ADAPTERS.length);
    for (const entry of TIER_B) {
      expect(entry.blocker).toBeTruthy();
      expect(adapterById(entry.id)).toBeDefined();
    }
  });

  it("proxy-requiring Tier-B platforms document their proxy env var", () => {
    for (const a of TIER_B_ADAPTERS) {
      if (a.oauth?.tokenExchange === "proxy") {
        expect(
          a.metadata.requirements.some((r) => r.includes("TOKEN_PROXY")),
          `${a.metadata.id} must document its proxy requirement`,
        ).toBe(true);
      }
    }
  });

  it("every entry's categories exist in the taxonomy", () => {
    for (const entry of allCatalogEntries()) {
      expect(entry.categories.length).toBeGreaterThan(0);
      for (const cat of entry.categories) {
        expect(categoryById(cat), `${entry.id} → ${cat}`).toBeDefined();
      }
    }
  });

  it("tier-honest statuses: A=demo without env config, B=approval, C=export-file", () => {
    // No NEXT_PUBLIC_* integration env vars are set in the test run.
    for (const entry of allCatalogEntries()) {
      const status = statusOf(entry);
      if (entry.tier === "A") expect(status).toBe("demo");
      if (entry.tier === "B") expect(status).toBe("approval-needed");
      if (entry.tier === "C") expect(status).toBe("export-file");
    }
    for (const a of ADAPTERS) expect(isLive(a)).toBe(false);
  });

  it("ships a working file-import adapter for every Tier-C catalog entry", () => {
    expect(FILE_ADAPTERS).toHaveLength(TIER_C.length);
    for (const entry of TIER_C) {
      const adapter = fileAdapterById(entry.id);
      expect(adapter, `missing file adapter for ${entry.id}`).toBeDefined();
      expect(adapter?.metadata.tier).toBe("C");
      expect(adapter?.metadata.authKind).toBe("export-file");
      expect(adapter?.accept.length).toBeGreaterThan(0);
      expect(adapter?.fileHint.length).toBeGreaterThan(0);
      // The adapter's categories must match the catalog entry's, and exist.
      expect([...adapter!.metadata.categories].sort()).toEqual([...entry.categories].sort());
      for (const cat of adapter!.metadata.categories) {
        expect(categoryById(cat)).toBeDefined();
      }
    }
  });

  it("Tier-C export links: a real https URL where the platform has one, absent otherwise", () => {
    // Platforms with a single web page where the user requests/downloads the export.
    const EXPORT_URLS: Record<string, string> = {
      "google-takeout": "https://takeout.google.com",
      netflix: "https://www.netflix.com/viewingactivity",
      "amazon-orders": "https://www.amazon.co.uk/hz/privacy-central/data-requests/preview.html",
      uber: "https://myprivacy.uber.com/privacy/exploreyourdata/download",
      goodreads: "https://www.goodreads.com/review/import",
      steam: "https://help.steampowered.com/en/accountdata",
      chatgpt: "https://chatgpt.com",
    };
    // In-app or institution-specific exports: no URL to send the user to —
    // the field must be ABSENT (the UI renders no link).
    const NO_EXPORT_URL = ["apple-health", "whatsapp", "bank-statements"];

    for (const a of FILE_ADAPTERS) {
      const expected = EXPORT_URLS[a.metadata.id];
      if (expected) {
        expect(a.exportUrl, a.metadata.id).toBe(expected);
        expect(new URL(a.exportUrl!).protocol).toBe("https:");
      } else {
        expect(NO_EXPORT_URL).toContain(a.metadata.id);
        expect(a.exportUrl, `${a.metadata.id} must not carry an exportUrl`).toBeUndefined();
      }
    }
  });

  it("proxy-requiring platforms are honest about it in their requirements", () => {
    for (const a of ADAPTERS) {
      if (a.oauth?.tokenExchange === "proxy") {
        expect(
          a.metadata.requirements.some((r) => r.includes("TOKEN_PROXY")),
          `${a.metadata.id} must document its proxy requirement`,
        ).toBe(true);
      }
    }
  });
});
