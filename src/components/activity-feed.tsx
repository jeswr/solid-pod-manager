"use client";

import Link from "next/link";
import { FileClock } from "lucide-react";
import { categoryIcon } from "@/components/category-icon";
import { categoryById } from "@/lib/categories";
import { formatModified } from "@/lib/format";
import type { ActivityEntry } from "@/lib/activity";

/**
 * Renders the "recently changed" feed (shared by Home and the Activity page).
 * Each row links to the resource's detail view. Honest framing: this is what
 * changed and when — never a fabricated "who read your data" claim.
 */
export function ActivityFeed({ entries }: { entries: ActivityEntry[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {entries.map((entry) => {
        const Icon = categoryIcon(categoryById(entry.categoryId)?.icon ?? "boxes");
        const when = formatModified(entry.modified) ?? "";
        return (
          <li key={entry.url}>
            <Link
              href={`/my-data/${entry.categoryId}/item?url=${encodeURIComponent(entry.url)}`}
              className="group flex items-center gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span
                aria-hidden="true"
                className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground"
              >
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{entry.name}</span>
                <span className="block truncate text-sm text-muted-foreground">
                  Changed in {entry.categoryLabel}
                </span>
              </span>
              <time
                dateTime={entry.modified}
                className="shrink-0 text-xs text-muted-foreground tabular"
              >
                {when}
              </time>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** The empty state for the feed — honest about what it shows. */
export function ActivityEmpty() {
  return (
    <div className="flex flex-col items-start gap-2 rounded-2xl border border-dashed border-border bg-muted/30 p-6 text-sm text-muted-foreground">
      <FileClock className="size-5 text-muted-foreground" aria-hidden="true" />
      <p>
        Nothing has changed in your pod recently. As you and your apps add or
        update data, the most recent changes will appear here.
      </p>
    </div>
  );
}
