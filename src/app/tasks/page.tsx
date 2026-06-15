// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Tasks — a first-party to-do app. Lists the user's tasks (`icaltzd:Vtodo`
 * under `tasks/`) with incomplete-first ordering, an inline complete toggle, and
 * create / open / edit / delete via `/tasks/edit`. iCal (.ics) import/export
 * round-trips the same VTODO shape. Mirrors the Contacts/Notes patterns.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CalendarClock, Download, ListTodo, Plus, Upload } from "lucide-react";
import { toast } from "sonner";
import { tasksStore, sortTasks, isOverdue, type Task } from "@/lib/tasks";
import { useStore, useItems } from "@/components/use-productivity";
import { LaunchInApp } from "@/components/launch-in-app";
import { EmptyState, ErrorState } from "@/components/states";
import { ItemRowSkeleton } from "@/components/item-row";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { formatDate } from "@/lib/format";
import { exportICal, importICal } from "@/lib/ical";
import { downloadText, readFileText } from "@/lib/download";
import type { StoredItem } from "@/lib/productivity-store";

export default function TasksPage() {
  const store = useStore<Task>(tasksStore);
  const { data, loading, error, reload } = useItems(store);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const tasks = useMemo(() => sortTasks(data ?? []), [data]);

  const onToggle = useCallback(
    async (item: StoredItem<Task>, completed: boolean) => {
      if (!store) return;
      // Use the new checked value Radix reports, not the (possibly stale)
      // `item.data.completed`, so rapid toggles don't write the wrong state.
      if (completed === item.data.completed) return;
      try {
        await store.update(item.url, { ...item.data, completed }, item.etag);
        reload();
      } catch {
        toast.error("Could not update this task. Please try again.");
      }
    },
    [store, reload],
  );

  function onExport() {
    if (!data || data.length === 0) {
      toast.error("There are no tasks to export.");
      return;
    }
    downloadText("tasks.ics", exportICal({ tasks: data }), "text/calendar");
  }

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-importing the same file
    if (!file || !store) return;
    setBusy(true);
    try {
      const { tasks: parsed, recurringCount, timezoneQualifiedCount, dateOnlyCount } = importICal(
        await readFileText(file),
      );
      if (parsed.length === 0) {
        toast.error("No tasks (VTODO) found in that file.");
        return;
      }
      if (recurringCount > 0) {
        toast.warning(
          `${recurringCount} recurring ${recurringCount === 1 ? "task" : "tasks"} imported as a single occurrence — repeats are not expanded.`,
        );
      }
      if (timezoneQualifiedCount > 0) {
        toast.warning(
          `${timezoneQualifiedCount} ${timezoneQualifiedCount === 1 ? "task has" : "tasks have"} a named timezone — imported using this device's timezone, so the due time may be off. Check after importing.`,
        );
      }
      if (dateOnlyCount > 0) {
        toast.warning(
          `${dateOnlyCount} ${dateOnlyCount === 1 ? "task has" : "tasks have"} an all-day due date — imported as a time at midnight; all-day dates aren't preserved yet.`,
        );
      }
      let added = 0;
      let failed = false;
      for (const t of parsed) {
        try {
          await store.create(t, t.title);
          added += 1;
        } catch {
          failed = true;
          break; // stop on first write error; keep what already imported
        }
      }
      if (added > 0) reload();
      if (failed) {
        toast.error(
          added > 0
            ? `Imported ${added} of ${parsed.length} tasks before an error. The rest were not imported.`
            : "Could not import the tasks. Please try again.",
        );
      } else {
        toast.success(`Imported ${added} ${added === 1 ? "task" : "tasks"}`);
      }
    } catch {
      toast.error("Could not import that file. Please check it is a valid .ics calendar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"
          >
            <ListTodo className="size-6" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
            <p className="measure mt-1 text-sm text-muted-foreground text-pretty">
              Your to-do list, stored privately in your pod.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept=".ics,text/calendar"
            className="sr-only"
            onChange={onImportFile}
            aria-hidden="true"
            tabIndex={-1}
          />
          <LaunchInApp app="issues" />
          <Button variant="outline" onClick={() => fileInput.current?.click()} disabled={busy || !store}>
            <Upload aria-hidden="true" />
            Import
          </Button>
          <Button variant="outline" onClick={onExport} disabled={!data || data.length === 0}>
            <Download aria-hidden="true" />
            Export
          </Button>
          <Button asChild>
            <Link href="/tasks/edit">
              <Plus aria-hidden="true" />
              New task
            </Link>
          </Button>
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
      ) : tasks.length === 0 ? (
        <EmptyState
          icon={ListTodo}
          title="No tasks yet"
          description="Add the things you need to do. They are saved privately to your pod."
          action={
            <Button asChild>
              <Link href="/tasks/edit">
                <Plus aria-hidden="true" />
                New task
              </Link>
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Your tasks">
          {tasks.map((task) => (
            <li key={task.url}>
              <TaskRow task={task} onToggle={(completed) => onToggle(task, completed)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const PRIORITY_LABEL: Record<Task["priority"], string | undefined> = {
  none: undefined,
  low: "Low",
  medium: "Medium",
  high: "High",
};

function TaskRow({
  task,
  onToggle,
}: {
  task: StoredItem<Task>;
  onToggle: (completed: boolean) => void;
}) {
  const t = task.data;
  const href = `/tasks/edit?id=${encodeURIComponent(task.url)}`;
  const title = t.title.trim() || "Untitled task";
  const overdue = isOverdue(t);
  const priorityLabel = PRIORITY_LABEL[t.priority];

  return (
    <div className="group flex items-center gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:bg-accent/40">
      <Checkbox
        checked={t.completed}
        onCheckedChange={(v) => onToggle(v === true)}
        aria-label={t.completed ? `Mark "${title}" as not done` : `Mark "${title}" as done`}
        className="shrink-0"
      />
      <Link
        href={href}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate font-medium ${t.completed ? "text-muted-foreground line-through" : ""}`}
          >
            {title}
          </span>
          <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            {t.due && (
              <>
                <CalendarClock className="size-3 shrink-0" aria-hidden="true" />
                <span className={overdue ? "font-medium text-destructive" : ""}>
                  {overdue ? "Overdue · " : "Due "}
                  {formatDate(t.due)}
                </span>
              </>
            )}
            {!t.due && !priorityLabel && (t.description?.trim() || "No due date")}
          </span>
        </span>
        {priorityLabel && (
          <Badge variant={t.priority === "high" ? "destructive" : "secondary"} className="shrink-0">
            {priorityLabel}
          </Badge>
        )}
      </Link>
    </div>
  );
}
