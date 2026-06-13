// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * One row in the files browser: a folder navigates deeper (in-app routing),
 * a resource opens the item viewer. Each row carries a per-item actions menu
 * (Open, Download, Rename, Delete) — the file-manager affordances SolidOS
 * exposes, here behind a single overflow button to keep the row clean.
 *
 * Rename + delete are destructive/mutating, so they go through their own
 * confirm/dialog flow (friction before harm, DESIGN §6) and call `onChange` to
 * re-list. Download streams the bytes client-side (an authenticated GET, then a
 * Blob URL) because the resource may be private — a bare `<a download>` would
 * fetch unauthenticated and 401.
 */
import { useState } from "react";
import Link from "next/link";
import {
  ChevronRight,
  Folder,
  FileText,
  MoreVertical,
  Download,
  Pencil,
  Trash2,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import type { PodItem } from "@/lib/files";
import {
  deleteEntry,
  isContainerUrl,
  nameFromUrl,
  parentContainer,
  readBytes,
  renameResource,
  childResourceUrl,
} from "@/lib/files";
import { ResourceDeleteError } from "@/lib/errors";
import { chooseViewer, viewerKindLabel } from "@/lib/viewers";
import { formatBytes, formatModified } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** Build the in-app link for a child: folders re-enter the browser, files open the viewer. */
function hrefFor(item: PodItem): string {
  if (item.isContainer) return `/files?url=${encodeURIComponent(item.url)}`;
  return `/files/item?url=${encodeURIComponent(item.url)}`;
}

export function FileRow({
  item,
  root,
  onChange,
}: {
  item: PodItem;
  root: string;
  onChange: () => void;
}) {
  const viewer = chooseViewer(item.mimeType, item.url);
  const Icon = item.isContainer ? Folder : FileText;
  const kindLabel = item.isContainer ? "Folder" : viewerKindLabel(viewer.kind);
  const size = item.isContainer ? undefined : formatBytes(item.size);
  const modified = formatModified(item.modified);

  return (
    <div className="group flex items-center gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:bg-accent/40">
      <Link
        href={hrefFor(item)}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"
        >
          <Icon className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{item.name}</span>
          <span className="block truncate text-xs text-muted-foreground tabular">
            {[kindLabel, size, modified].filter(Boolean).join(" · ")}
          </span>
        </span>
      </Link>

      <RowActions item={item} root={root} onChange={onChange} />

      <ChevronRight
        className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
        aria-hidden="true"
      />
    </div>
  );
}

function RowActions({
  item,
  root,
  onChange,
}: {
  item: PodItem;
  root: string;
  onChange: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [downloading, setDownloading] = useState(false);

  async function download() {
    setDownloading(true);
    try {
      // Authenticated, byte-exact GET (the resource may be private and/or
      // binary), then a Blob download — a bare <a download> would fetch
      // unauthenticated and 401, and a text round-trip would corrupt binaries.
      const { blob } = await readBytes(item.url);
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = item.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      toast.error("Couldn't download this file.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
            aria-label={`Actions for ${item.name}`}
          >
            <MoreVertical className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <a href={item.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-4" aria-hidden="true" />
              Open original
            </a>
          </DropdownMenuItem>
          {!item.isContainer && (
            <DropdownMenuItem disabled={downloading} onClick={() => void download()}>
              {downloading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="size-4" aria-hidden="true" />
              )}
              Download
            </DropdownMenuItem>
          )}
          {!item.isContainer && (
            <DropdownMenuItem onClick={() => setRenaming(true)}>
              <Pencil className="size-4" aria-hidden="true" />
              Rename
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setDeleting(true)}
          >
            <Trash2 className="size-4" aria-hidden="true" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameDialog
        open={renaming}
        item={item}
        root={root}
        onOpenChange={setRenaming}
        onDone={onChange}
      />
      <DeleteDialog
        open={deleting}
        item={item}
        onOpenChange={setDeleting}
        onDone={onChange}
      />
    </>
  );
}

function RenameDialog({
  open,
  item,
  root,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  item: PodItem;
  root: string;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [busy, setBusy] = useState(false);

  async function rename() {
    setBusy(true);
    try {
      const parent = parentContainer(item.url, root) ?? root;
      const to = childResourceUrl(parent, name);
      if (to === item.url) {
        onOpenChange(false);
        return;
      }
      await renameResource(item.url, to);
      toast.success(`Renamed to “${nameFromUrl(to)}”.`);
      onDone();
      onOpenChange(false);
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Couldn't rename this. Nothing was changed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Rename file</AlertDialogTitle>
          <AlertDialogDescription>
            This makes a copy under the new name and removes the old one.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="rename-input">New name</Label>
          <Input
            id="rename-input"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim() && !busy) void rename();
            }}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!name.trim() || busy}
            onClick={(e) => {
              e.preventDefault();
              void rename();
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            Rename
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DeleteDialog({
  open,
  item,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  item: PodItem;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const isFolder = isContainerUrl(item.url);

  async function remove() {
    setBusy(true);
    try {
      await deleteEntry(item.url);
      toast.success(`Deleted “${item.name}”.`);
      onDone();
      onOpenChange(false);
    } catch (e) {
      const msg =
        e instanceof ResourceDeleteError && (e.status === 409 || e.status === 412)
          ? "This folder isn't empty. Remove what's inside it first."
          : e instanceof ResourceDeleteError
            ? `Couldn't delete this (${e.status}). Nothing was changed.`
            : "Couldn't delete this. Nothing was changed.";
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{item.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {isFolder
              ? "This permanently removes the folder. It must be empty first."
              : "This permanently removes the file from your pod. This can't be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={(e) => {
              e.preventDefault();
              void remove();
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            Yes, delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
