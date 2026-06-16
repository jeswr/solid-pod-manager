// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Tests for the conditional /federations nav entry's GATING (nav-items.ts).
 *
 * The entry is feature-gated on NEXT_PUBLIC_FEDERATION_REGISTRY via a `gate()`
 * predicate; `visibleNavItems()` filters the static NAV_ITEMS so the render sites
 * (SidebarNav / BottomNav) never show a gated-off integration. The static array
 * is never mutated. We assert both gate states by mocking the config flag.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("nav-items: /federations is conditional + additive", () => {
  it("the static NAV_ITEMS always carries the gated /federations entry (never mutated)", async () => {
    vi.doMock("@/lib/federation-registry-config", () => ({ isFederationRegistryEnabled: false }));
    const { NAV_ITEMS } = await import("./nav-items.js");
    const fed = NAV_ITEMS.find((i) => i.href === "/federations");
    expect(fed, "the entry exists in the static array").toBeDefined();
    expect(typeof fed?.gate, "the entry is gated by a predicate").toBe("function");
  });

  it("visibleNavItems HIDES /federations when the registry is unset", async () => {
    vi.doMock("@/lib/federation-registry-config", () => ({ isFederationRegistryEnabled: false }));
    const { visibleNavItems } = await import("./nav-items.js");
    expect(visibleNavItems().some((i) => i.href === "/federations")).toBe(false);
    // ... but ungated items still show (the filter only drops failing gates).
    expect(visibleNavItems().some((i) => i.href === "/")).toBe(true);
  });

  it("visibleNavItems SHOWS /federations when the registry is configured", async () => {
    vi.doMock("@/lib/federation-registry-config", () => ({ isFederationRegistryEnabled: true }));
    const { visibleNavItems } = await import("./nav-items.js");
    expect(visibleNavItems().some((i) => i.href === "/federations")).toBe(true);
  });

  it("every ungated item is always visible (gate is opt-in)", async () => {
    vi.doMock("@/lib/federation-registry-config", () => ({ isFederationRegistryEnabled: false }));
    const { NAV_ITEMS, visibleNavItems } = await import("./nav-items.js");
    const visible = visibleNavItems();
    for (const item of NAV_ITEMS) {
      if (item.gate === undefined) {
        expect(visible.some((v) => v.href === item.href), `${item.href} (ungated) must be visible`).toBe(true);
      }
    }
  });
});
