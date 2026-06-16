// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Tasks renderer (design: `docs/typed-data-views.md` §4): a list of task rows —
 * a done/not-done indicator + title + due date + priority — with **no raw
 * triples**. Consumes the pure `TaskModel`; all RDF stayed in `lib/`.
 *
 * This is a READ card (the editable form lives behind the "Edit" view-mode), so
 * the done indicator is a static icon, not an interactive checkbox — there is no
 * mutation here. The pure layer keeps `due` as a raw ISO string; this card
 * formats it for the user's locale via `Intl` and flags overdue incomplete tasks.
 */
import { Circle, CircleCheck } from "lucide-react";
import type { TaskItem, TaskModel } from "@/lib/typed-views/task-view";
import type { TaskPriority } from "@/lib/tasks";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

/** The task-row list for a tasks resource. */
export function TaskCardList({ model }: { model: TaskModel; url: string }) {
  if (model.items.length === 0) {
    return <p className="text-sm text-muted-foreground">No tasks found in this resource.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {model.items.map((task) => (
        <TaskRow key={task.id} task={task} />
      ))}
    </div>
  );
}

function TaskRow({ task }: { task: TaskItem }) {
  const due = formatDate(task.due);
  const overdue = isOverdue(task.due, task.completed);

  return (
    <Card>
      <CardContent className="flex items-start gap-4 py-4">
        <div className="flex size-6 shrink-0 items-center justify-center pt-0.5 text-muted-foreground">
          {task.completed ? (
            <CircleCheck className="size-5 text-primary" aria-label="Completed" />
          ) : (
            <Circle className="size-5" aria-label="Not completed" />
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-1">
          <span
            className={
              task.completed
                ? "font-medium leading-tight text-muted-foreground line-through"
                : "font-medium leading-tight"
            }
          >
            {task.title}
          </span>
          {task.description && (
            <p className="line-clamp-2 text-sm text-muted-foreground">{task.description}</p>
          )}

          <div className="mt-1 flex flex-wrap items-center gap-2">
            {due && (
              <Badge variant={overdue ? "destructive" : "secondary"}>
                {overdue ? "Overdue " : "Due "}
                {due}
              </Badge>
            )}
            {task.priority !== "none" && (
              <Badge variant="outline">{priorityLabel(task.priority)}</Badge>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Human label for a priority band. */
function priorityLabel(priority: TaskPriority): string {
  switch (priority) {
    case "high":
      return "High priority";
    case "medium":
      return "Medium priority";
    case "low":
      return "Low priority";
    default:
      return "";
  }
}

/** Overdue = a due date in the past on an incomplete task. */
function isOverdue(due: string | undefined, completed: boolean): boolean {
  if (completed || !due) return false;
  const t = Date.parse(due);
  return !Number.isNaN(t) && t < Date.now();
}

/** Locale-friendly date, e.g. "11 Jun 2026". Tolerates bad/absent input. */
function formatDate(iso?: string): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(t));
}
