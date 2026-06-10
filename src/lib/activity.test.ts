import { describe, expect, it } from "vitest";
import { buildRecentChanges, type CategoryItems } from "./activity.js";
import type { DataCategory } from "./categories.js";
import type { PodItem } from "./pod-data.js";

const cat = (id: string, label: string): DataCategory => ({
  id,
  label,
  tier: "common",
  icon: "boxes",
  assurance: "",
  description: "",
  classes: [],
});

const item = (over: Partial<PodItem>): PodItem => ({
  url: "https://pod.example/x",
  name: "x",
  isContainer: false,
  ...over,
});

describe("buildRecentChanges", () => {
  it("sorts newest first across categories", () => {
    const input: CategoryItems[] = [
      {
        category: cat("notes", "Notes"),
        items: [
          item({ url: "u/a", name: "a", modified: "2026-01-01T00:00:00Z" }),
          item({ url: "u/c", name: "c", modified: "2026-03-01T00:00:00Z" }),
        ],
      },
      {
        category: cat("calendar", "Calendar"),
        items: [item({ url: "u/b", name: "b", modified: "2026-02-01T00:00:00Z" })],
      },
    ];
    const out = buildRecentChanges(input);
    expect(out.map((e) => e.name)).toEqual(["c", "b", "a"]);
    expect(out[0].categoryLabel).toBe("Notes");
  });

  it("drops items without a usable modified timestamp", () => {
    const out = buildRecentChanges([
      {
        category: cat("notes", "Notes"),
        items: [
          item({ url: "u/a", name: "a" }), // no modified
          item({ url: "u/b", name: "b", modified: "not-a-date" }),
          item({ url: "u/c", name: "c", modified: "2026-01-01T00:00:00Z" }),
        ],
      },
    ]);
    expect(out.map((e) => e.name)).toEqual(["c"]);
  });

  it("skips containers (folder mtime is noise)", () => {
    const out = buildRecentChanges([
      {
        category: cat("documents", "Documents"),
        items: [
          item({ url: "u/dir", name: "dir", isContainer: true, modified: "2026-05-01T00:00:00Z" }),
          item({ url: "u/file", name: "file", modified: "2026-04-01T00:00:00Z" }),
        ],
      },
    ]);
    expect(out.map((e) => e.name)).toEqual(["file"]);
  });

  it("de-duplicates by URL keeping the newest, and respects the limit", () => {
    const out = buildRecentChanges(
      [
        {
          category: cat("notes", "Notes"),
          items: [
            item({ url: "u/dup", name: "old", modified: "2026-01-01T00:00:00Z" }),
            item({ url: "u/dup", name: "new", modified: "2026-06-01T00:00:00Z" }),
            item({ url: "u/x", name: "x", modified: "2026-05-01T00:00:00Z" }),
            item({ url: "u/y", name: "y", modified: "2026-04-01T00:00:00Z" }),
          ],
        },
      ],
      2,
    );
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe("new"); // newest of the dup pair
    expect(out.map((e) => e.url)).toEqual(["u/dup", "u/x"]);
  });

  it("returns an empty feed for no input", () => {
    expect(buildRecentChanges([])).toEqual([]);
  });
});
