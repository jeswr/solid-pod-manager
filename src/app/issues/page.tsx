// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Issues — a first-party lightweight tracker. Lists the user's issues
 * (`wf:Task` under `issues/`) open-first, with a state badge and create / open /
 * edit / delete via `/issues/edit`. Same-pod CRUD.
 *
 * CROSS-POD ASSIGNMENT (pss-phg): the "Assign to someone" form writes a `wf:Task`
 * into the user's OWN pod stamped `wf:assignee <theirWebID>`, grants that person
 * the MINIMAL read access on just that task resource, and best-effort notifies
 * them with an as:Announce — the WRITE counterpart to the "Assigned to me" view.
 * All cross-pod safety (SSRF-validated inbox, minimal WAC grant, WebID
 * validation) lives in `assign-task.ts`; this page only wires the picker + form.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { CircleDot, Plus, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { issuesStore, sortIssues, openCount, type Issue, type IssueState } from "@/lib/issues";
import { assignTask } from "@/lib/assign-task";
import { AssignError } from "@/lib/errors";
import { useStore, useItems } from "@/components/use-productivity";
import { useSession } from "@/components/session-provider";
import { PeoplePicker } from "@/components/people-picker";
import { EmptyState, ErrorState } from "@/components/states";
import { ItemRowSkeleton } from "@/components/item-row";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
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
  const [assignOpen, setAssignOpen] = useState(false);

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
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setAssignOpen((v) => !v)}
            aria-expanded={assignOpen}
            aria-controls="assign-task-form"
          >
            <UserPlus aria-hidden="true" />
            Assign to someone
          </Button>
          <Button asChild>
            <Link href="/issues/edit">
              <Plus aria-hidden="true" />
              New issue
            </Link>
          </Button>
        </div>
      </header>

      {assignOpen && (
        <AssignTaskForm
          onAssigned={() => {
            setAssignOpen(false);
            reload();
          }}
          onCancel={() => setAssignOpen(false)}
        />
      )}

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

/**
 * Assign a task to another person, cross-pod. Picks a contact / friend / WebID
 * via the shared {@link PeoplePicker} (single-select), then calls
 * {@link assignTask}: the task is written into the USER'S OWN pod with
 * `wf:assignee`, the assignee gets a MINIMAL read grant on just that resource,
 * and a best-effort as:Announce is sent to their inbox. A failed notification
 * does NOT fail the assignment — we surface it as a softer toast.
 */
function AssignTaskForm({
  onAssigned,
  onCancel,
}: {
  onAssigned: () => void;
  onCancel: () => void;
}) {
  const { webId, activeStorage } = useSession();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignees, setAssignees] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const assignee = assignees[0];

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!webId || !activeStorage) {
      toast.error("Sign in to assign a task.");
      return;
    }
    if (!title.trim()) {
      toast.error("Give the task a title.");
      return;
    }
    if (!assignee) {
      toast.error("Pick someone to assign the task to.");
      return;
    }
    setSaving(true);
    try {
      const { notified } = await assignTask({
        assignerWebId: webId,
        podRoot: activeStorage,
        assigneeWebId: assignee,
        task: { title: title.trim(), description: description.trim() || undefined },
      });
      if (notified) {
        toast.success("Task assigned and the assignee was notified.");
      } else {
        // The assignment (write + read-grant) succeeded; only delivery failed.
        toast.success("Task assigned. We couldn't notify them automatically — they can still see it.");
      }
      onAssigned();
    } catch (err) {
      // Typed reasons → specific copy; everything else → a generic retry.
      if (err instanceof AssignError && err.reason === "invalid-assignee") {
        toast.error("The person you're assigning to needs a WebID (an https:// URL).");
      } else if (err instanceof AssignError && err.reason === "grant-failed") {
        toast.error("Couldn't share the task with the assignee. Please try again.");
      } else {
        toast.error("Could not assign the task. Please try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      id="assign-task-form"
      onSubmit={onSubmit}
      className="flex flex-col gap-5 rounded-xl border border-border bg-muted/30 p-4"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="assign-title">Task title</Label>
        <Input
          id="assign-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing?"
          required
          autoFocus
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="assign-desc">Details (optional)</Label>
        <Textarea
          id="assign-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Add any context…"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Assign to</Label>
        <PeoplePicker
          value={assignees}
          onChange={setAssignees}
          single
          label="Find someone to assign to"
          placeholder="Search contacts, or paste a WebID…"
        />
        <p className="text-xs text-muted-foreground text-pretty">
          The task is saved in your pod and shared read-only with this person; we&rsquo;ll notify
          their inbox if we can.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={saving}>
          {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : <UserPlus aria-hidden="true" />}
          Assign task
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
