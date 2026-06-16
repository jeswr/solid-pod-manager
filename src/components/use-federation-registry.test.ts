// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Tests for the federation-registry hook's GATING + KEYING logic
 * (`use-federation-registry.ts`) and the config module's SECURITY + TRUST
 * boundary (`@/lib/federation-registry`).
 *
 * Vitest runs the `node` environment with no DOM / React renderer (see
 * vitest.config.ts), so we cannot mount the real hook. The load-bearing logic is
 * the SWR key derivation — "feature off ⇒ empty key ⇒ NO fetch" — extracted into
 * the pure `federationMembersKey` helper and tested directly. A structural guard
 * asserts the hook routes through it + gates on `isFederationRegistryEnabled`, so
 * the gating cannot silently regress. Two structural guards over the config
 * module assert (a) it passes the UNPATCHED native fetch to the SDK (never the
 * auth-patched global — the foreign-origin boundary) and (b) the TRUST BOUNDARY:
 * the config never imports / feeds the task trust model (`federation-tasks.ts`).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { federationMembersKey } from "./use-federation-registry.js";

describe("federationMembersKey — gating + keying", () => {
  it("keys on the URL-encoded registry URL when enabled", () => {
    expect(federationMembersKey("https://registry.example/federation", true)).toBe(
      `federation-members:${encodeURIComponent("https://registry.example/federation")}`,
    );
    // Trims whitespace before keying.
    expect(federationMembersKey("  https://r.example/fed  ", true)).toBe(
      `federation-members:${encodeURIComponent("https://r.example/fed")}`,
    );
  });

  it("encodes the URL so two distinct registries never share a slot", () => {
    const a = federationMembersKey("https://r.example/a", true);
    const b = federationMembersKey("https://r.example/b", true);
    expect(a).not.toBe(b);
    // No bare reserved chars leak into the key (unambiguous structure).
    expect(a.startsWith("federation-members:")).toBe(true);
    expect(a.includes("/")).toBe(false);
  });

  it("returns an EMPTY key (no fetch) when the feature is disabled", () => {
    expect(federationMembersKey("https://registry.example/federation", false)).toBe("");
  });

  it("returns an EMPTY key (no fetch) for a blank URL even when 'enabled'", () => {
    expect(federationMembersKey("", true)).toBe("");
    expect(federationMembersKey("   ", true)).toBe("");
  });
});

describe("use-federation-registry — structural: gates on the feature flag + no topicUrl", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "use-federation-registry.ts"),
    "utf8",
  );

  it("derives the key via federationMembersKey gated on isFederationRegistryEnabled", () => {
    expect(
      src.includes("federationMembersKey(FEDERATION_REGISTRY_URL, isFederationRegistryEnabled)"),
    ).toBe(true);
  });

  it("routes the read model through useSwrRead (instant-nav) WITHOUT a topicUrl", () => {
    expect(src.includes("useSwrRead<RegistryDiscovery>(key, fetcher)")).toBe(true);
    // The registry is not a Solid resource — there must be no options object
    // (and so no topicUrl) passed to useSwrRead. (The doc comment DOCUMENTS the
    // "no topicUrl" choice; this checks the CALL, not the prose.)
    expect(/useSwrRead<[^>]+>\(key,\s*fetcher,\s*\{/.test(src)).toBe(false);
    expect(/topicUrl\s*:/.test(src)).toBe(false);
  });

  it("normalises the empty-key (inert) state to loading:false (no premature skeletons)", () => {
    // The hook must short-circuit the empty key to a settled state rather than
    // returning useSwrRead's empty-key loading:true default (mirrors webid-search).
    expect(/if \(key === ""\)/.test(src)).toBe(true);
    expect(src.includes("loading: false")).toBe(true);
    expect(src.includes("enabled: isFederationRegistryEnabled")).toBe(true);
  });

  it("guards the fetcher against the feature being off (inert)", () => {
    expect(/if \(!isFederationRegistryEnabled\)/.test(src)).toBe(true);
  });
});

describe("federation-registry config — security: passes the UNPATCHED native fetch", () => {
  const cfg = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "federation-registry.ts"),
    "utf8",
  );

  it("imports getNativeFetch (the pre-patch snapshot), never the auth-patched global", () => {
    // The foreign-origin boundary: the SDK fetch must NOT be the auth-patched
    // globalThis.fetch (its 401-upgrade path would attach the user's DPoP to the
    // third-party registry). It must use the pre-patch native-fetch snapshot.
    expect(cfg.includes("import { getNativeFetch }")).toBe(true);
    expect(cfg.includes("getNativeFetch()")).toBe(true);
    // It must never WIRE globalThis.fetch as the SDK fetch (a `fetch:
    // globalThis.fetch` or a `discoverFromRegistry(url, globalThis.fetch)`). The
    // doc comment names globalThis.fetch to explain the boundary; this checks the
    // CODE, not the prose, so it only fails on an actual wiring.
    expect(/fetch\s*:\s*globalThis\.fetch/.test(cfg)).toBe(false);
    expect(/globalThis\.fetch\s*\)/.test(cfg)).toBe(false);
  });

  it("composes the SDK fetch from the native snapshot with the SSRF guard timeout", () => {
    // registryOptions wires { fetch: <native>, guard: { timeoutMs: 8000 } }.
    expect(/const fetchImpl = getNativeFetch\(\)/.test(cfg)).toBe(true);
    expect(/fetch: fetchImpl/.test(cfg)).toBe(true);
    expect(cfg.includes("timeoutMs: 8000")).toBe(true);
  });

  it("reads the env as a DIRECT property access so Next inlines it in the static export", () => {
    // A computed `process.env[...]` key would defeat Next's build-time
    // replacement; it MUST be the direct property form.
    expect(cfg.includes("process.env.NEXT_PUBLIC_FEDERATION_REGISTRY")).toBe(true);
    expect(/process\.env\[/.test(cfg)).toBe(false);
  });
});

describe("federation-registry config — TRUST BOUNDARY: display-only, never feeds task trust", () => {
  const cfg = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "federation-registry.ts"),
    "utf8",
  );
  const hook = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "use-federation-registry.ts"),
    "utf8",
  );

  // Look for an actual import of the trust model — not a mere mention in a doc
  // comment (the modules deliberately DOCUMENT the boundary in prose). An
  // `import ... from "...federation-tasks..."` / `require("...federation-tasks")`
  // is the thing that would wire membership into the trust model.
  const importsTrustModel = (s: string): boolean =>
    /(?:import[^;]*from|require\s*\()\s*["'][^"']*federation-tasks[^"']*["']/.test(s) ||
    /(?:import[^;]*from|require\s*\()\s*["'][^"']*federation-trust[^"']*["']/.test(s);

  it("the config module does NOT IMPORT the task trust model", () => {
    // Registry membership must never be wired into federation-tasks.ts's
    // AuthorizedSources — surfacing a member can never change /assigned.
    expect(importsTrustModel(cfg)).toBe(false);
    // Nor call its trust-building entry points.
    expect(/\bbuildAuthorizedSources\s*\(/.test(cfg)).toBe(false);
    expect(/\bdiscoverAssignedTasks\s*\(/.test(cfg)).toBe(false);
    expect(/\bnew\s+AuthorizedSources\b/.test(cfg)).toBe(false);
  });

  it("the hook does NOT IMPORT or build the task trust model either", () => {
    expect(importsTrustModel(hook)).toBe(false);
    expect(/\bbuildAuthorizedSources\s*\(/.test(hook)).toBe(false);
  });
});
