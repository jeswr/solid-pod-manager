// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { categoryById } from "./categories.js";
import type { AppAccess } from "./permissions.js";
import { originLabel, reconcileTrustedApps } from "./trusted-apps.js";

function app(over: Partial<AppAccess>): AppAccess {
  return {
    agentId: "https://app.example",
    kind: "origin",
    wholePod: false,
    modes: ["read"],
    categories: [],
    ...over,
  };
}

describe("reconcileTrustedApps", () => {
  it("keeps only origin-kind subjects (apps trusted by web origin)", () => {
    const apps: AppAccess[] = [
      app({ agentId: "https://browser-app.example", kind: "origin" }),
      app({ agentId: "https://someone.example/me#me", kind: "agent" }),
    ];
    const origins = reconcileTrustedApps(apps);
    expect(origins.map((o) => o.origin)).toEqual(["https://browser-app.example"]);
  });

  it("carries whole-pod, grants and category labels for revoke + display", () => {
    const health = categoryById("health");
    if (!health) throw new Error("health category missing");
    const apps: AppAccess[] = [
      app({
        agentId: "https://coach.example",
        kind: "origin",
        wholePod: true,
        categories: [
          {
            category: health,
            modes: ["read"],
            grants: [
              {
                aclUrl: "https://alice.example/.acl",
                authorization: "https://alice.example/.acl#coach",
                target: "https://alice.example/",
                inherits: true,
              },
            ],
          },
        ],
      }),
    ];
    const [coach] = reconcileTrustedApps(apps);
    expect(coach.wholePod).toBe(true);
    expect(coach.grants).toHaveLength(1);
    expect(coach.categoryLabels).toEqual([health.label]);
  });

  it("sorts origins alphabetically", () => {
    const apps: AppAccess[] = [
      app({ agentId: "https://zed.example", kind: "origin" }),
      app({ agentId: "https://acme.example", kind: "origin" }),
    ];
    expect(reconcileTrustedApps(apps).map((o) => o.origin)).toEqual([
      "https://acme.example",
      "https://zed.example",
    ]);
  });
});

describe("originLabel", () => {
  it("shows the full origin (scheme + host) so schemes are never conflated", () => {
    expect(originLabel("https://app.example:8443")).toBe("https://app.example:8443");
    // http vs https on the same host stay distinguishable.
    expect(originLabel("http://app.example")).toBe("http://app.example");
    expect(originLabel("https://app.example")).toBe("https://app.example");
    expect(originLabel("not a url")).toBe("not a url");
  });
});
