// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Unit tests for the pure presentation helpers of the /federations view
 * (`federation-members.ts`): friendly name from a client_id IRI, status badge
 * variant, status/authority labels, and the document-level error builder.
 */
import { describe, expect, it } from "vitest";
import {
  assertedByLabel,
  memberDisplayName,
  registryError,
  statusBadgeVariant,
  statusLabel,
} from "./federation-members.js";

describe("memberDisplayName", () => {
  it("derives the host from a doc-style http(s) client_id IRI", () => {
    expect(memberDisplayName("https://app.example/clientid.jsonld")).toBe("app.example");
    expect(memberDisplayName("https://app.example/")).toBe("app.example");
    expect(memberDisplayName("https://app.example")).toBe("app.example");
  });

  it("keeps a meaningful trailing segment for multi-app origins", () => {
    expect(memberDisplayName("https://apps.example/notes")).toBe("apps.example/notes");
    // A doc-filename last segment is dropped in favour of the bare host.
    expect(memberDisplayName("https://apps.example/foo/clientid.ttl")).toBe("apps.example");
  });

  it("shows a non-http(s) URL or non-URL value verbatim (never a hostless /segment)", () => {
    expect(memberDisplayName("urn:opaque:x")).toBe("urn:opaque:x");
    expect(memberDisplayName("did:web:example.com")).toBe("did:web:example.com");
    expect(memberDisplayName("not a url")).toBe("not a url");
  });

  it("placeholders an empty id", () => {
    expect(memberDisplayName("")).toBe("Unnamed app");
    expect(memberDisplayName("   ")).toBe("Unnamed app");
  });
});

describe("statusBadgeVariant", () => {
  it("emphasises Active and de-emphasises withdrawn / pending / unknown", () => {
    expect(statusBadgeVariant("Active")).toBe("default");
    expect(statusBadgeVariant("Suspended")).toBe("destructive");
    expect(statusBadgeVariant("Revoked")).toBe("destructive");
    expect(statusBadgeVariant("Proposed")).toBe("secondary");
    expect(statusBadgeVariant(undefined)).toBe("secondary");
  });
});

describe("statusLabel", () => {
  it("returns the status or 'Unknown status'", () => {
    expect(statusLabel("Active")).toBe("Active");
    expect(statusLabel("Proposed")).toBe("Proposed");
    expect(statusLabel(undefined)).toBe("Unknown status");
  });
});

describe("assertedByLabel", () => {
  it("shows the first authority host, with a +N suffix for several", () => {
    expect(assertedByLabel(["https://reg.example/authority#k"])).toBe("reg.example");
    expect(assertedByLabel(["https://a.example/#k", "https://b.example/#k"])).toBe(
      "a.example +1 more",
    );
  });

  it("is honest about an absent authority", () => {
    expect(assertedByLabel([])).toBe("an unnamed authority");
    expect(assertedByLabel(undefined)).toBe("an unnamed authority");
    expect(assertedByLabel(["   "])).toBe("an unnamed authority");
  });

  it("falls back to the raw value for a non-URL authority", () => {
    expect(assertedByLabel(["urn:authority:x"])).toBe("urn:authority:x");
  });
});

describe("registryError", () => {
  it("includes the registry's own issue messages when present", () => {
    const err = registryError([
      { code: "fetch", message: "404 Not Found" },
    ] as never);
    expect(err.message).toContain("couldn't read the federation registry");
    expect(err.message).toContain("404 Not Found");
  });

  it("uses a generic message when there are no issue details", () => {
    expect(registryError(undefined).message).toContain("Check the address");
    expect(registryError([]).message).toContain("Check the address");
  });
});
