/**
 * "Recently changed in your pod" — an honest activity feed (DESIGN.md §3).
 *
 * IMPORTANT (no fabrication, R6): a standard Solid pod exposes NO server-side
 * access log, so we do NOT claim "which app read your data, and when" — that
 * would be a lie the data can't back. Instead this surfaces what we CAN know
 * truthfully: the most recently *modified* resources across the user's data
 * categories, read from each resource's `dcterms:modified` (the `modified`
 * timestamp the container listing already carries). It reflects changes made by
 * ANY app, not just this one — which is both honest and more useful.
 *
 * The selection/sort is a pure function so it is unit-testable without a pod;
 * the I/O (listing containers) lives in the hook layer.
 */
import type { DataCategory } from "./categories.js";
import type { PodItem } from "./pod-data.js";

/** One entry in the recent-changes feed. */
export interface ActivityEntry {
  /** Resource URL (its detail page is /my-data/<category>/item?url=…). */
  url: string;
  name: string;
  categoryId: string;
  categoryLabel: string;
  /** ISO timestamp the resource was last modified. */
  modified: string;
  isContainer: boolean;
}

/** A category paired with the items discovered inside it. */
export interface CategoryItems {
  category: DataCategory;
  items: PodItem[];
}

/**
 * Flatten per-category items into a single feed of the most recently changed
 * resources, newest first. Items without a `modified` timestamp are dropped
 * (we will not invent a time), as are containers (a folder's mtime is noise
 * next to the documents inside it). De-duplicates by URL, keeping the newest.
 *
 * Pure — no I/O. `limit` caps the returned entries (default 8).
 */
export function buildRecentChanges(
  perCategory: readonly CategoryItems[],
  limit = 8,
): ActivityEntry[] {
  const byUrl = new Map<string, ActivityEntry>();

  for (const { category, items } of perCategory) {
    for (const item of items) {
      if (item.isContainer || !item.modified) continue;
      if (Number.isNaN(new Date(item.modified).getTime())) continue;
      const entry: ActivityEntry = {
        url: item.url,
        name: item.name,
        categoryId: category.id,
        categoryLabel: category.label,
        modified: item.modified,
        isContainer: false,
      };
      const existing = byUrl.get(item.url);
      if (!existing || entry.modified > existing.modified) byUrl.set(item.url, entry);
    }
  }

  return [...byUrl.values()]
    .sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0))
    .slice(0, Math.max(0, limit));
}
