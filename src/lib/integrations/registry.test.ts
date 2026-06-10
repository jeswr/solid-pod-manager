import { describe, it, expect } from "vitest";
import { categoryById } from "../categories.js";
import {
  ADAPTERS,
  adapterById,
  allCatalogEntries,
  isLive,
  statusOf,
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
