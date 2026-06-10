"use client";

/**
 * Note editor — create (`id === "new"`) or edit/delete an existing note
 * (`id` = the URL-encoded resource URL). Conditional writes use the read ETag
 * so a concurrent edit fails loudly (412) instead of clobbering.
 */
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, Loader2, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { notesStore, type Note } from "@/lib/notes";
import { useStore, useItem } from "@/components/use-productivity";
import { ErrorState } from "@/components/states";
import { ResourceWriteError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";

export default function NoteEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const isNew = id === "new";
  const url = isNew ? undefined : decodeURIComponent(id);

  const router = useRouter();
  const store = useStore<Note>(notesStore);
  const { data: item, loading, error } = useItem(store, url);

  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [etag, setEtag] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Seed the form once the existing note loads.
  useEffect(() => {
    if (item) {
      setTitle(item.data.title);
      setText(item.data.text);
      setEtag(item.etag);
    }
  }, [item]);

  const ready = Boolean(store) && (isNew || Boolean(item) || !loading);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!store) return;
    setSaving(true);
    try {
      const note: Note = { title, text, modified: new Date() };
      if (isNew) {
        const { url: created } = await store.create(note, title);
        toast.success("Note created");
        router.replace(`/notes/${encodeURIComponent(created)}`);
      } else if (url) {
        await store.update(url, note, etag);
        toast.success("Note saved");
        router.push("/notes");
      }
    } catch (err) {
      if (err instanceof ResourceWriteError && err.status === 412) {
        toast.error("This note changed elsewhere. Reopen it and try again.");
      } else {
        toast.error("Could not save your note. Please try again.");
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
      toast.success("Note deleted");
      router.push("/notes");
    } catch {
      toast.error("Could not delete this note. Please try again.");
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <ol className="flex items-center gap-1">
          <li>
            <Link href="/notes" className="hover:text-foreground hover:underline">
              Notes
            </Link>
          </li>
          <ChevronRight className="size-4" aria-hidden="true" />
          <li aria-current="page" className="font-medium text-foreground">
            {isNew ? "New note" : "Edit note"}
          </li>
        </ol>
      </nav>

      {error ? (
        <ErrorState error={error} />
      ) : !ready ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <form onSubmit={onSave} className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="note-title">Title</Label>
            <Input
              id="note-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Untitled note"
              autoFocus={isNew}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="note-text">Note</Label>
            <Textarea
              id="note-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Write anything. Markdown is welcome."
              className="min-h-64"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={saving}>
              {saving ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Save aria-hidden="true" />
              )}
              {isNew ? "Create note" : "Save changes"}
            </Button>
            <Button type="button" variant="ghost" asChild>
              <Link href="/notes">Cancel</Link>
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
