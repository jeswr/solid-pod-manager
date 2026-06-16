// @vitest-environment jsdom
// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Files empty-state CTA (task #93, G8/P2). An empty folder must offer a friendly
 * "Upload your first file" call to action (not a bare blank), and clicking it
 * routes the chosen files through the SAME upload path the drop target uses.
 *
 * We mock the data-layer hooks (`use-files`) + the router so the browser renders
 * with an empty folder in jsdom without a live session/SWR/Solid stack; the
 * `uploadMany` helper is mocked so the click resolves without network. The
 * load-bearing assertions are: the CTA renders, and picking a file invokes the
 * upload helper for the current container.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const ROOT = "https://alice.example/storage/";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/components/use-files", () => ({
  useFilesScope: () => ({
    root: ROOT,
    storages: [ROOT],
    inScope: () => true,
  }),
  // Empty folder, settled (not loading), no error.
  useFolder: () => ({
    data: [],
    error: undefined,
    loading: false,
    revalidating: false,
    reload: vi.fn(),
  }),
}));

// `vi.hoisted` so the mock factory (hoisted to the top) can safely reference it.
const { uploadMany } = vi.hoisted(() => ({
  uploadMany: vi.fn(() => Promise.resolve({ uploaded: 1, failed: [] as string[] })),
}));
vi.mock("@/components/file-actions", () => ({
  // The toolbar is irrelevant to this test; render a marker so the page mounts.
  FileToolbar: () => <div data-testid="toolbar" />,
  uploadMany,
}));

vi.mock("@/components/launch-in-app", () => ({
  LaunchInApp: () => null,
}));

import { FilesBrowser } from "@/app/files/files-browser";

describe("files empty-state CTA", () => {
  it("shows the 'Upload your first file' CTA when the folder is empty", () => {
    render(<FilesBrowser />);
    expect(screen.getByText(/this folder is empty/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /upload your first file/i }),
    ).toBeInTheDocument();
  });

  it("picking a file routes through the shared upload path for the container", async () => {
    const { container } = render(<FilesBrowser />);
    // The hidden file input is the only file input in the empty-state CTA.
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    const file = new File(["hi"], "hello.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { value: [file] });
    fireEvent.change(input);
    // The upload helper is called for the current container (the active root).
    await vi.waitFor(() => expect(uploadMany).toHaveBeenCalled());
    expect(uploadMany).toHaveBeenCalledWith(ROOT, [file]);
  });
});
