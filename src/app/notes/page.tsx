"use client";

/**
 * Notes — a first-party productivity app. Lists the user's notes (stored as
 * `schema:TextDigitalDocument` under `notes/`) newest-first, with create / open
 * / delete. Editing lives at `/notes/[id]`. Mirrors the loading / empty / error
 * patterns of `my-data` (AppShell already gates on the session).
 */
import { useMemo } from "react";
import Link from "next/link";
import { NotebookPen, Plus } from "lucide-react";
import { notesStore, type Note } from "@/lib/notes";
import { useStore, useItems } from "@/components/use-productivity";
import { EmptyState, ErrorState } from "@/components/states";
import { ItemRowSkeleton } from "@/components/item-row";
import { Button } from "@/components/ui/button";
import { formatModified } from "@/lib/format";
import type { StoredItem } from "@/lib/productivity-store";

export default function NotesPage() {
  const store = useStore<Note>(notesStore);
  const { data, loading, error, reload } = useItems(store);

  const notes = useMemo(
    () =>
      [...(data ?? [])].sort(
        (a, b) => (b.data.modified?.getTime() ?? 0) - (a.data.modified?.getTime() ?? 0),
      ),
    [data],
  );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"
          >
            <NotebookPen className="size-6" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Notes</h1>
            <p className="measure mt-1 text-sm text-muted-foreground text-pretty">
              Quick notes, kept in your own pod. Only apps you approve can read them.
            </p>
          </div>
        </div>
        <Button asChild>
          <Link href="/notes/new">
            <Plus aria-hidden="true" />
            New note
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
      ) : notes.length === 0 ? (
        <EmptyState
          icon={NotebookPen}
          title="No notes yet"
          description="Capture a thought, a list, or a draft. It is saved privately to your pod."
          action={
            <Button asChild>
              <Link href="/notes/new">
                <Plus aria-hidden="true" />
                New note
              </Link>
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Your notes">
          {notes.map((note) => (
            <li key={note.url}>
              <NoteRow note={note} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NoteRow({ note }: { note: StoredItem<Note> }) {
  const href = `/notes/${encodeURIComponent(note.url)}`;
  const title = note.data.title.trim() || "Untitled note";
  const preview = note.data.text.trim().replace(/\s+/g, " ").slice(0, 120);
  const modified = formatModified(note.data.modified?.toISOString());

  return (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"
      >
        <NotebookPen className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {[preview, modified].filter(Boolean).join(" · ") || "Empty note"}
        </span>
      </span>
    </Link>
  );
}
