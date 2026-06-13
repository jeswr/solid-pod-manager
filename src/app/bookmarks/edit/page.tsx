// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Bookmark editor — create (no `?id=`) or edit/delete an existing bookmark
 * (`?id=` = the bookmark's resource URL). A query parameter rather than a path
 * segment so the page prerenders under `output: "export"`. A URL is required
 * (and must be an absolute http(s) link); title / description / tags are
 * optional. Conditional writes use the read ETag (412 → reopen). Mirrors the
 * Contact editor.
 */
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, Loader2, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { bookmarksStore, parseTagsInput, type Bookmark } from "@/lib/bookmarks";
import { useStore, useItem } from "@/components/use-productivity";
import { ErrorState } from "@/components/states";
import { ResourceWriteError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";

/** Validate that a string is an absolute http(s) URL. */
function isHttpUrl(value: string): boolean {
  try {
    const proto = new URL(value).protocol;
    return proto === "http:" || proto === "https:";
  } catch {
    return false;
  }
}

export default function BookmarkEditorPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <BookmarkEditor />
    </Suspense>
  );
}

function BookmarkEditor() {
  const url = useSearchParams().get("id") ?? undefined;
  const isNew = !url;

  const router = useRouter();
  const store = useStore<Bookmark>(bookmarksStore);
  const { data: item, loading, error } = useItem(store, url);

  const [link, setLink] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [etag, setEtag] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (item) {
      setLink(item.data.url);
      setTitle(item.data.title);
      setDescription(item.data.description ?? "");
      setTags(item.data.tags.join(", "));
      setEtag(item.etag);
    }
  }, [item]);

  const ready = Boolean(store) && (isNew || Boolean(item) || !loading);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!store) return;
    const trimmed = link.trim();
    if (!isHttpUrl(trimmed)) {
      toast.error("Please enter a valid web address (starting with http:// or https://).");
      return;
    }
    setSaving(true);
    try {
      const bookmark: Bookmark = {
        url: trimmed,
        title: title.trim(),
        description: description.trim() || undefined,
        tags: parseTagsInput(tags),
      };
      if (isNew) {
        const { url: created } = await store.create(bookmark, title || bookmark.url);
        toast.success("Bookmark added");
        router.replace(`/bookmarks/edit?id=${encodeURIComponent(created)}`);
      } else if (url) {
        await store.update(url, bookmark, etag);
        toast.success("Bookmark saved");
        router.push("/bookmarks");
      }
    } catch (err) {
      if (err instanceof ResourceWriteError && err.status === 412) {
        toast.error("This bookmark changed elsewhere. Reopen it and try again.");
      } else {
        toast.error("Could not save this bookmark. Please try again.");
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
      toast.success("Bookmark deleted");
      router.push("/bookmarks");
    } catch {
      toast.error("Could not delete this bookmark. Please try again.");
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <ol className="flex items-center gap-1">
          <li>
            <Link href="/bookmarks" className="hover:text-foreground hover:underline">
              Bookmarks
            </Link>
          </li>
          <ChevronRight className="size-4" aria-hidden="true" />
          <li aria-current="page" className="font-medium text-foreground">
            {isNew ? "New bookmark" : "Edit bookmark"}
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
            <Label htmlFor="bookmark-url">Web address</Label>
            <Input
              id="bookmark-url"
              type="url"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://example.com/article"
              required
              autoFocus={isNew}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bookmark-title">Title (optional)</Label>
            <Input
              id="bookmark-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What is this page?"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bookmark-tags">Tags (optional)</Label>
            <Input
              id="bookmark-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="reading, work, recipes"
            />
            <p className="text-xs text-muted-foreground">Separate tags with commas.</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bookmark-description">Note (optional)</Label>
            <Textarea
              id="bookmark-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Why you saved it…"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={saving}>
              {saving ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Save aria-hidden="true" />
              )}
              {isNew ? "Add bookmark" : "Save changes"}
            </Button>
            <Button type="button" variant="ghost" asChild>
              <Link href="/bookmarks">Cancel</Link>
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
