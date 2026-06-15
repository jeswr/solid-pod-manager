// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Assigned to me — the federation consumption view (pss-erv MVP + pss-l87).
 * Lists `wf:Task` resources assigned to the logged-in WebID, discovered across
 * the user's OWN pods and the pods of authorized agents (friends + contacts),
 * via their Type-Index `wf:Task` registrations.
 *
 * SECURITY (pss-6ae): the assignee claim is UNTRUSTED. A task only appears here
 * when its provenance is verified in `lib/federation-tasks.ts` — own-pod
 * (the user controls the bytes) or in an authorized assigner's OWN verified
 * storage. A stranger's pod claiming "this is assigned to you" never surfaces.
 * The "From your pod" / "From <agent>" badge tells the user the provenance.
 */
import { useMemo } from "react";
import { ClipboardCheck } from "lucide-react";
import { useAssignedTasks } from "@/components/use-federation-tasks";
import { EmptyState, ErrorState } from "@/components/states";
import { ItemRowSkeleton } from "@/components/item-row";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";
import { nameFromUrl } from "@/lib/pod-data";
import { safeLinkHref } from "@/lib/pod-scope";
import { openAssignedCount, type AssignedTask } from "@/lib/federation-tasks";
import type { IssueState } from "@/lib/issues";

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

export default function AssignedPage() {
  const { data, loading, error, reload } = useAssignedTasks();
  const open = useMemo(() => (data ? openAssignedCount(data) : 0), [data]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"
          >
            <ClipboardCheck className="size-6" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Assigned to me</h1>
            <p className="measure mt-1 text-sm text-muted-foreground text-pretty">
              {data && data.length > 0
                ? `${open} open of ${data.length}, gathered from your pods and people you trust.`
                : "Tasks assigned to you across your pods and people you trust."}
            </p>
          </div>
        </div>
      </header>

      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading ? (
        <ul className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <ItemRowSkeleton key={i} />
          ))}
        </ul>
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title="Nothing assigned to you"
          description="Tasks others assign to you in their pods will appear here once you've added them as a friend or contact. Tasks you assign to yourself show up too."
        />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Tasks assigned to you">
          {data.map((task) => (
            <li key={task.url}>
              <AssignedRow item={task} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AssignedRow({ item }: { item: AssignedTask }) {
  const it = item.task;
  const title = it.title.trim() || "Untitled task";
  const closed = it.state === "closed";
  // The task resource is on a trusted pod (own or an authorized agent's). Render
  // a link only for a safe http(s) scheme (pod IRIs are attacker-influenceable).
  const href = safeLinkHref(item.url);
  const sourceLabel = item.own ? "From your pod" : `From ${nameFromUrl(item.source)}`;

  const body = (
    <>
      <Badge variant={stateVariant(it.state)} className="shrink-0">
        {STATE_LABEL[it.state]}
      </Badge>
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate font-medium ${closed ? "text-muted-foreground line-through" : ""}`}
        >
          {title}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {sourceLabel}
          {it.created ? ` · Opened ${formatDate(it.created)}` : ""}
          {it.description?.trim() ? ` · ${it.description.trim()}` : ""}
        </span>
      </span>
      <Badge variant="outline" className="shrink-0">
        {item.own ? "Yours" : "Shared"}
      </Badge>
    </>
  );

  const className =
    "group flex items-center gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

  // Foreign tasks open in a new tab (a different pod's resource viewer); own
  // tasks too — we only have the raw RDF URL, not a PM edit route for foreign data.
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {body}
    </a>
  ) : (
    <div className={className}>{body}</div>
  );
}
