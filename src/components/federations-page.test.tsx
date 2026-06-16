// @vitest-environment jsdom
// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
//
// Render test for the /federations discovery view (page.tsx): the pure mapping
// helpers (member name from client_id IRI, status badge variant, assertedBy
// authority label) and the render branches — member mapping (status/authority/
// per-member validity), DOCUMENT-level invalid → ErrorState (NOT empty), and
// valid-but-empty → EmptyState. The hook is mocked so the render is deterministic
// and offline (no network, no real auth).
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FederationMembersState } from "@/components/use-federation-registry";
import type { DiscoveredMember, RegistryDiscovery } from "@/lib/federation-registry";

// The hook state is swapped per test via this mutable holder (the vi.mock factory
// reads it at CALL time, after the hoist).
let state: FederationMembersState;
vi.mock("@/components/use-federation-registry", () => ({
  useFederationMembers: () => state,
  // federationMembersKey is unused by the page; provide a stub so the module
  // shape is complete if anything imports it.
  federationMembersKey: () => "",
}));

import FederationsPage from "@/app/federations/page";

function member(over: Partial<DiscoveredMember> = {}): DiscoveredMember {
  return {
    id: "https://app.example/clientid.jsonld",
    source: "https://registry.example/federation",
    membership: { app: "https://app.example/clientid.jsonld", assertedBy: ["https://reg.example/authority#k"] },
    status: "Active",
    trusted: true,
    valid: true,
    issues: [],
    ...over,
  };
}

function discovery(over: Partial<RegistryDiscovery> = {}): RegistryDiscovery {
  return { members: [member()], valid: true, issues: [], ...over };
}

function settled(data: RegistryDiscovery | undefined): FederationMembersState {
  return {
    data,
    error: undefined,
    loading: false,
    revalidating: false,
    reload: vi.fn(),
    enabled: true,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("FederationsPage — member mapping", () => {
  it("renders each member: status badge, friendly name, and the asserting authority", () => {
    state = settled(discovery());
    render(<FederationsPage />);

    expect(screen.getByRole("heading", { name: "Federations" })).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("app.example")).toBeInTheDocument();
    // The authority is shown in muted text with the honest "listed by" framing.
    expect(screen.getByText(/Listed by reg\.example/)).toBeInTheDocument();
  });

  it("shows a per-member 'couldn't verify' note when valid === false", () => {
    state = settled(discovery({ members: [member({ valid: false, issues: [{ code: "x", message: "malformed" }] as never })] }));
    render(<FederationsPage />);
    expect(screen.getByText(/couldn.t verify this listing/i)).toBeInTheDocument();
  });

  it("does NOT show the per-member note for a valid listing", () => {
    state = settled(discovery());
    render(<FederationsPage />);
    expect(screen.queryByText(/couldn.t verify this listing/i)).not.toBeInTheDocument();
  });
});

describe("FederationsPage — error vs empty branches", () => {
  it("DOCUMENT-level invalid (valid:false) → ErrorState (reloadable), NOT an empty state", () => {
    state = settled(discovery({ members: [], valid: false, issues: [{ code: "fetch", message: "404 Not Found" }] as never }));
    render(<FederationsPage />);
    // The error surface + the registry's own issue detail, with a retry.
    expect(screen.getByText(/couldn.t read the federation registry/i)).toBeInTheDocument();
    expect(screen.getByText(/404 Not Found/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    // It must NOT render the empty-state copy.
    expect(screen.queryByText(/No member apps listed/i)).not.toBeInTheDocument();
  });

  it("valid but ZERO members → EmptyState (not an error)", () => {
    state = settled(discovery({ members: [], valid: true, issues: [] }));
    render(<FederationsPage />);
    expect(screen.getByText(/No member apps listed/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn.t read the federation registry/i)).not.toBeInTheDocument();
  });

  it("disabled (no registry configured) → a plain 'not configured' empty state, no refresh button", () => {
    state = { data: undefined, error: undefined, loading: false, revalidating: false, reload: vi.fn(), enabled: false };
    render(<FederationsPage />);
    expect(screen.getByText(/not configured/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /refresh the federation directory/i })).not.toBeInTheDocument();
  });
});
