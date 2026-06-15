// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * Mutation correctness for the SWR read cache: a grant/revoke must act on the
 * agent's CURRENT grant set, sourced from a freshly-discovered app list — never
 * a stale cached UI snapshot. These tests pin {@link grantsForAgent} /
 * {@link grantsForCategory} (the projection the mutation paths feed into
 * `revokeGrants`/`grant`) against both a stale and a fresh snapshot.
 */
import { describe, expect, it } from "vitest";
import { categoryById } from "./categories.js";
import {
  grantsForAgent,
  grantsForCategory,
  type AccessGrant,
  type AppAccess,
} from "./permissions.js";

const APP = "https://app.example/id#this";

function grant(target: string, authorization: string): AccessGrant {
  return {
    aclUrl: `${target}.acl`,
    authorization: `${target}.acl#${authorization}`,
    target,
    inherits: true,
  };
}

const HEALTH = categoryById("health")!;
const FINANCE = categoryById("finance")!;

/** A snapshot where APP can read only `health`. */
function staleSnapshot(): AppAccess[] {
  return [
    {
      agentId: APP,
      kind: "agent",
      wholePod: false,
      modes: ["read"],
      categories: [
        {
          category: HEALTH,
          modes: ["read"],
          grants: [grant("https://alice.example/health/", "health")],
        },
      ],
    },
  ];
}

/** The CURRENT state: APP gained `finance` access after the stale snapshot. */
function freshSnapshot(): AppAccess[] {
  const apps = staleSnapshot();
  apps[0].categories.push({
    category: FINANCE,
    modes: ["read"],
    grants: [grant("https://alice.example/finance/", "finance")],
  });
  apps[0].modes = ["read"];
  return apps;
}

describe("grantsForAgent — revoke-all sources the CURRENT grant set", () => {
  it("a fresh snapshot includes a grant added after the stale one (no stale revoke)", () => {
    const stale = grantsForAgent(staleSnapshot(), APP);
    const fresh = grantsForAgent(freshSnapshot(), APP);

    // The stale snapshot would have missed the finance grant entirely.
    expect(stale).toHaveLength(1);
    expect(fresh).toHaveLength(2);
    const targets = fresh.map((g) => g.target).sort();
    expect(targets).toEqual([
      "https://alice.example/finance/",
      "https://alice.example/health/",
    ]);
  });

  it("returns [] for an agent that has no current access (already revoked)", () => {
    expect(grantsForAgent(freshSnapshot(), "https://other.example/id#this")).toEqual([]);
    expect(grantsForAgent([], APP)).toEqual([]);
  });
});

describe("grantsForCategory — per-category revoke sources the CURRENT grants", () => {
  it("finds the category's grants in the fresh snapshot", () => {
    const fresh = grantsForCategory(freshSnapshot(), APP, "finance");
    expect(fresh).toHaveLength(1);
    expect(fresh[0].target).toBe("https://alice.example/finance/");
  });

  it("returns [] when the category is not (or no longer) granted", () => {
    // finance is absent from the stale snapshot → empty (a no-op revoke).
    expect(grantsForCategory(staleSnapshot(), APP, "finance")).toEqual([]);
    expect(grantsForCategory(freshSnapshot(), APP, "no-such-category")).toEqual([]);
  });
});
