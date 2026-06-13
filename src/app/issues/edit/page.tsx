// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Issue editor — create (no `?id=`) or edit/delete an existing issue (`?id=` =
 * the issue's resource URL). A query parameter (not a path segment) so the page
 * prerenders under `output: "export"`. Title required; description / state /
 * assignee optional. A non-WebID assignee is rejected at the form so we never
 * write a malformed node. Conditional writes use the read ETag (412 → reopen).
 * Mirrors the Task editor.
 */
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, Loader2, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { issuesStore, isWebId, type Issue, type IssueState } from "@/lib/issues";
import { useStore, useItem } from "@/components/use-productivity";
import { ErrorState } from "@/components/states";
import { ResourceWriteError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";

const STATES: { value: IssueState; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "in-progress", label: "In progress" },
  { value: "closed", label: "Closed" },
];

export default function IssueEditorPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <IssueEditor />
    </Suspense>
  );
}

function IssueEditor() {
  const url = useSearchParams().get("id") ?? undefined;
  const isNew = !url;

  const router = useRouter();
  const store = useStore<Issue>(issuesStore);
  const { data: item, loading, error } = useItem(store, url);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [state, setState] = useState<IssueState>("open");
  const [assignee, setAssignee] = useState("");
  const [etag, setEtag] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (item) {
      setTitle(item.data.title);
      setDescription(item.data.description ?? "");
      setState(item.data.state);
      setAssignee(item.data.assignee ?? "");
      setEtag(item.etag);
    }
  }, [item]);

  const ready = Boolean(store) && (isNew || Boolean(item) || !loading);
  const assigneeInvalid = assignee.trim() !== "" && !isWebId(assignee.trim());

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!store) return;
    if (!title.trim()) {
      toast.error("Please enter a title.");
      return;
    }
    if (assigneeInvalid) {
      toast.error("Assignee must be a WebID (an https:// URL), or left blank.");
      return;
    }
    setSaving(true);
    try {
      const issue: Issue = {
        title: title.trim(),
        description: description.trim() || undefined,
        state,
        created: item?.data.created, // preserve original open date on edit
        assignee: assignee.trim() || undefined,
      };
      if (isNew) {
        const { url: created } = await store.create(issue, title);
        toast.success("Issue created");
        router.replace(`/issues/edit?id=${encodeURIComponent(created)}`);
      } else if (url) {
        await store.update(url, issue, etag);
        toast.success("Issue saved");
        router.push("/issues");
      }
    } catch (err) {
      if (err instanceof ResourceWriteError && err.status === 412) {
        toast.error("This issue changed elsewhere. Reopen it and try again.");
      } else {
        toast.error("Could not save this issue. Please try again.");
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
      toast.success("Issue deleted");
      router.push("/issues");
    } catch {
      toast.error("Could not delete this issue. Please try again.");
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <ol className="flex items-center gap-1">
          <li>
            <Link href="/issues" className="hover:text-foreground hover:underline">
              Issues
            </Link>
          </li>
          <ChevronRight className="size-4" aria-hidden="true" />
          <li aria-current="page" className="font-medium text-foreground">
            {isNew ? "New issue" : "Edit issue"}
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
            <Label htmlFor="issue-title">Title</Label>
            <Input
              id="issue-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Summarise the issue"
              required
              autoFocus={isNew}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="issue-state">State</Label>
              <select
                id="issue-state"
                value={state}
                onChange={(e) => setState(e.target.value as IssueState)}
                className="h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {STATES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="issue-assignee">Assignee WebID (optional)</Label>
              <Input
                id="issue-assignee"
                type="url"
                inputMode="url"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                placeholder="https://…/profile#me"
                aria-invalid={assigneeInvalid}
              />
              {assigneeInvalid && (
                <p className="text-xs text-destructive">Enter a full https:// WebID, or leave blank.</p>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="issue-description">Description (optional)</Label>
            <Textarea
              id="issue-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add any details…"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
              {isNew ? "Create issue" : "Save changes"}
            </Button>
            <Button type="button" variant="ghost" asChild>
              <Link href="/issues">Cancel</Link>
            </Button>
            {!isNew && (
              <Button
                type="button"
                variant="destructive"
                className="ml-auto"
                onClick={onDelete}
                disabled={deleting}
              >
                {deleting ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                Delete
              </Button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
