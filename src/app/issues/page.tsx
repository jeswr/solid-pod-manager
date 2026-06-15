// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Issues — a first-party lightweight tracker. Lists the user's issues
 * (`wf:Task` under `issues/`) open-first, with a state badge and create / open /
 * edit / delete via `/issues/edit`. Same-pod CRUD only (no cross-pod posting).
 * Mirrors the Tasks/Notes patterns.
 */
import { useMemo } from "react";
import Link from "next/link";
import { CircleDot, Plus } from "lucide-react";
import { issuesStore, sortIssues, openCount, type Issue, type IssueState } from "@/lib/issues";
import { useStore, useItems } from "@/components/use-productivity";
import { EmptyState, ErrorState } from "@/components/states";
import { ItemRowSkeleton } from "@/components/item-row";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";
import type { StoredItem } from "@/lib/productivity-store";

const STATE_LABEL: Record<IssueState, string> = {
  open: "Open",
  "in-progress": "In progress",
  closed: "Closed",
};

function stateVariant(state: IssueState): "default" | "secondary" | "outline" {
  if (state === "open") return "default";
  if (state === "in-progress") return "secondary";
  return "outline";
}

export default function IssuesPage() {
  const store = useStore<Issue>(issuesStore);
  const { data, loading, error, reload } = useItems(store);

  const issues = useMemo(() => sortIssues(data ?? []), [data]);
  const open = useMemo(() => (data ? openCount(data) : 0), [data]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"
          >
            <CircleDot className="size-6" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Issues</h1>
            <p className="measure mt-1 text-sm text-muted-foreground text-pretty">
              {data && data.length > 0
                ? `${open} open of ${data.length}, stored privately in your pod.`
                : "A lightweight tracker, stored privately in your pod."}
            </p>
          </div>
        </div>
        <Button asChild>
          <Link href="/issues/edit">
            <Plus aria-hidden="true" />
            New issue
          </Link>
        </Button>
      </header>

      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading ? (
        <ul className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <ItemRowSkeleton key={i} />
          ))}
        </ul>
      ) : issues.length === 0 ? (
        <EmptyState
          icon={CircleDot}
          title="No issues yet"
          description="Track bugs, ideas and to-dos. They are saved privately to your pod."
          action={
            <Button asChild>
              <Link href="/issues/edit">
                <Plus aria-hidden="true" />
                New issue
              </Link>
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Your issues">
          {issues.map((issue) => (
            <li key={issue.url}>
              <IssueRow issue={issue} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function IssueRow({ issue }: { issue: StoredItem<Issue> }) {
  const it = issue.data;
  const href = `/issues/edit?id=${encodeURIComponent(issue.url)}`;
  const title = it.title.trim() || "Untitled issue";
  const closed = it.state === "closed";

  return (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <Badge variant={stateVariant(it.state)} className="shrink-0">
        {STATE_LABEL[it.state]}
      </Badge>
      <span className="min-w-0 flex-1">
        <span className={`block truncate font-medium ${closed ? "text-muted-foreground line-through" : ""}`}>
          {title}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {it.created ? `Opened ${formatDate(it.created)}` : "Recently opened"}
          {it.description?.trim() ? ` · ${it.description.trim()}` : ""}
        </span>
      </span>
    </Link>
  );
}
