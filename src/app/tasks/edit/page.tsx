// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Task editor — create (no `?id=`) or edit/delete an existing task (`?id=` = the
 * task's resource URL). A query parameter rather than a path segment so the page
 * prerenders under `output: "export"`. A title is required; description / due /
 * priority / completed are optional. Conditional writes use the read ETag
 * (412 → reopen). Mirrors the Event editor.
 */
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, Loader2, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { tasksStore, type Task, type TaskPriority } from "@/lib/tasks";
import { useStore, useItem } from "@/components/use-productivity";
import { ErrorState } from "@/components/states";
import { ResourceWriteError } from "@/lib/errors";
import { fromDateTimeLocal, toDateTimeLocal } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";

const PRIORITIES: { value: TaskPriority; label: string }[] = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

export default function TaskEditorPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <TaskEditor />
    </Suspense>
  );
}

function TaskEditor() {
  const url = useSearchParams().get("id") ?? undefined;
  const isNew = !url;

  const router = useRouter();
  const store = useStore<Task>(tasksStore);
  const { data: item, loading, error } = useItem(store, url);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("none");
  const [completed, setCompleted] = useState(false);
  const [etag, setEtag] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (item) {
      setTitle(item.data.title);
      setDescription(item.data.description ?? "");
      setDue(toDateTimeLocal(item.data.due));
      setPriority(item.data.priority);
      setCompleted(item.data.completed);
      setEtag(item.etag);
    }
  }, [item]);

  const ready = Boolean(store) && (isNew || Boolean(item) || !loading);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!store) return;
    if (!title.trim()) {
      toast.error("Please enter a title.");
      return;
    }
    setSaving(true);
    try {
      const task: Task = {
        title: title.trim(),
        description: description.trim() || undefined,
        due: fromDateTimeLocal(due),
        priority,
        completed,
      };
      if (isNew) {
        const { url: created } = await store.create(task, title);
        toast.success("Task added");
        router.replace(`/tasks/edit?id=${encodeURIComponent(created)}`);
      } else if (url) {
        await store.update(url, task, etag);
        toast.success("Task saved");
        router.push("/tasks");
      }
    } catch (err) {
      if (err instanceof ResourceWriteError && err.status === 412) {
        toast.error("This task changed elsewhere. Reopen it and try again.");
      } else {
        toast.error("Could not save this task. Please try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!store || !url) return;
    setDeleting(true);
    try {
      await store.remove(url);
      toast.success("Task deleted");
      router.push("/tasks");
    } catch {
      toast.error("Could not delete this task. Please try again.");
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <ol className="flex items-center gap-1">
          <li>
            <Link href="/tasks" className="hover:text-foreground hover:underline">
              Tasks
            </Link>
          </li>
          <ChevronRight className="size-4" aria-hidden="true" />
          <li aria-current="page" className="font-medium text-foreground">
            {isNew ? "New task" : "Edit task"}
          </li>
        </ol>
      </nav>

      {error ? (
        <ErrorState error={error} />
      ) : !ready ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <form onSubmit={onSave} className="flex max-w-xl flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs doing?"
              required
              autoFocus={isNew}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task-due">Due (optional)</Label>
              <Input
                id="task-due"
                type="datetime-local"
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task-priority">Priority</Label>
              <select
                id="task-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskPriority)}
                className="h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {PRIORITIES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="task-description">Description (optional)</Label>
            <Textarea
              id="task-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add any details…"
            />
          </div>

          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox
              checked={completed}
              onCheckedChange={(v) => setCompleted(v === true)}
              aria-label="Mark this task as done"
            />
            Mark as done
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={saving}>
              {saving ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Save aria-hidden="true" />
              )}
              {isNew ? "Add task" : "Save changes"}
            </Button>
            <Button type="button" variant="ghost" asChild>
              <Link href="/tasks">Cancel</Link>
            </Button>
            {!isNew && (
              <Button
                type="button"
                variant="destructive"
                className="ml-auto"
                onClick={onDelete}
                disabled={deleting}
              >
                {deleting ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <Trash2 aria-hidden="true" />
                )}
                Delete
              </Button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
