// @vitest-environment jsdom
// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
//
// Render test for the WebID-index people-search panel (webid-index-search.tsx):
// it renders the result cards (name / avatar fallback / WebID), "Add as contact"
// writes the index entry to PM's contacts store (mapped via indexEntryToContact),
// and "Suggest to index" calls the client's suggestWebId with the signed-in
// user's WebID as the AS2 actor. The session, store, and the search hook are
// mocked so the render is deterministic and offline (no network, no real auth).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ── Mocks: session, store, the search hook, and the index client ─────────────

const createMock = vi.fn(async () => ({ url: "https://me.pod/contacts/x.ttl", etag: null }));
const suggestMock = vi.fn((webid: string, opts?: { actor?: string }) => {
  void webid;
  void opts;
  return Promise.resolve("submitted");
});
// Deferred indirection so the hoisted vi.mock factory below can reference the
// mock without tripping the "no top-level variables in a factory" hoist rule —
// the closure resolves `suggestMock` at CALL time, not at factory-eval time.
function callSuggest(webid: string, opts?: { actor?: string }): Promise<string> {
  return suggestMock(webid, opts);
}

vi.mock("@/components/session-provider", () => ({
  useSession: () => ({ webId: "https://me.pod/card#me", status: "logged-in" }),
}));

vi.mock("@/components/use-productivity", () => ({
  useStore: () => ({ create: createMock }),
}));

// The hook returns a fixed page so the render is deterministic.
const searchState = {
  data: {
    entries: [
      {
        webid: "https://alice.pod/card#me",
        name: "Ada Lovelace",
        photoUrl: null,
        modified: null,
      },
    ],
    next: null,
  },
  error: undefined,
  loading: false,
  revalidating: false,
  enabled: true,
  reload: vi.fn(),
};
vi.mock("@/components/use-webid-search", () => ({
  useWebIdSearch: () => searchState,
}));

vi.mock("@/lib/webid-index", () => ({
  isWebIdIndexEnabled: true,
  webIdIndexClient: { suggestWebId: callSuggest } as unknown,
}));

// sonner toasts are side-effects we don't assert on; stub them to no-ops.
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { indexEntryToContact, WebIdIndexSearch } from "./webid-index-search.js";

afterEach(() => {
  createMock.mockClear();
  suggestMock.mockClear();
});

describe("indexEntryToContact (pure mapping)", () => {
  it("maps name + WebID, falling back to the WebID when unnamed", () => {
    expect(indexEntryToContact({ webid: "https://a.pod/#me", name: "Ada", photoUrl: null, modified: null })).toEqual({
      fn: "Ada",
      webId: "https://a.pod/#me",
    });
    expect(indexEntryToContact({ webid: "https://a.pod/#me", name: null, photoUrl: null, modified: null })).toEqual({
      fn: "https://a.pod/#me",
      webId: "https://a.pod/#me",
    });
  });
});

describe("WebIdIndexSearch — render + actions", () => {
  it("renders a result card with the name and WebID", () => {
    render(<WebIdIndexSearch />);
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("https://alice.pod/card#me")).toBeInTheDocument();
    // The search input is present and labelled.
    expect(screen.getByRole("searchbox", { name: /search the webid index/i })).toBeInTheDocument();
  });

  it("'Add as contact' writes the mapped entry to the contacts store and fires onAdded", async () => {
    const onAdded = vi.fn();
    render(<WebIdIndexSearch onAdded={onAdded} />);
    fireEvent.click(screen.getByRole("button", { name: /add ada lovelace as a contact/i }));
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    // Mapped via indexEntryToContact: name + WebID preserved.
    expect(createMock).toHaveBeenCalledWith(
      { fn: "Ada Lovelace", webId: "https://alice.pod/card#me" },
      "Ada Lovelace",
    );
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    // The button flips to "Added".
    await waitFor(() => expect(screen.getByText("Added")).toBeInTheDocument());
  });

  it("'Suggest to index' calls suggestWebId with the signed-in WebID as actor", async () => {
    render(<WebIdIndexSearch />);
    fireEvent.click(screen.getByRole("button", { name: /suggest ada lovelace to the index/i }));
    await waitFor(() => expect(suggestMock).toHaveBeenCalledTimes(1));
    expect(suggestMock).toHaveBeenCalledWith("https://alice.pod/card#me", {
      actor: "https://me.pod/card#me",
    });
  });
});
