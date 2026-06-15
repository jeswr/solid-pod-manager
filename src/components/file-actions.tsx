// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * The files-browser toolbar: "New folder", "New file", and "Upload" — the
 * SolidOS green "+" affordance, plain-language and confirmation-light. Each
 * action writes through the `files` data layer (create-only, so nothing is
 * silently clobbered) and calls `onChange` so the listing re-fetches.
 *
 * Drag-and-drop upload lives in the parent (the whole listing is the drop
 * target); this toolbar exposes the click-to-pick equivalent and shares the
 * same `uploadMany` helper for progress.
 */
import { useRef, useState } from "react";
import { FolderPlus, FilePlus, Upload, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  childContainerUrl,
  childResourceUrl,
  createContainer,
  guessContentType,
  uploadFile,
  writeRaw,
} from "@/lib/files";
import { ResourceWriteError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

/** Friendly copy for a write failure, distinguishing the "already exists" case. */
function writeErrorMessage(e: unknown, existsHint: string): string {
  if (e instanceof ResourceWriteError) {
    if (e.status === 412 || e.status === 409) return existsHint;
    if (e.status === 401 || e.status === 403) {
      return "You don't have permission to write here.";
    }
    return `Couldn't save that (${e.status}). Nothing was changed.`;
  }
  return e instanceof Error ? e.message : "Something went wrong. Nothing was changed.";
}

export function FileToolbar({
  container,
  onChange,
}: {
  container: string;
  onChange: () => void;
}) {
  const [dialog, setDialog] = useState<"folder" | "file" | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function handlePicked(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    const result = await uploadMany(container, Array.from(files));
    setUploading(false);
    if (result.uploaded > 0) {
      toast.success(
        result.uploaded === 1 ? "Uploaded 1 file." : `Uploaded ${result.uploaded} files.`,
      );
      onChange();
    }
    if (result.failed.length > 0) {
      toast.error(
        `Couldn't upload ${result.failed.length} of ${files.length}.`,
        { description: result.failed.join(", ").slice(0, 200) },
      );
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => setDialog("folder")}>
        <FolderPlus className="size-4" aria-hidden="true" />
        New folder
      </Button>
      <Button variant="outline" size="sm" onClick={() => setDialog("file")}>
        <FilePlus className="size-4" aria-hidden="true" />
        New file
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={uploading}
        onClick={() => fileInputRef.current?.click()}
      >
        {uploading ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <Upload className="size-4" aria-hidden="true" />
        )}
        Upload
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => void handlePicked(e.target.files)}
      />

      <NewFolderDialog
        open={dialog === "folder"}
        container={container}
        onOpenChange={(o) => setDialog(o ? "folder" : null)}
        onCreated={onChange}
      />
      <NewFileDialog
        open={dialog === "file"}
        container={container}
        onOpenChange={(o) => setDialog(o ? "file" : null)}
        onCreated={onChange}
      />
    </div>
  );
}

/**
 * Upload many files into a container, create-only (so a same-named file isn't
 * clobbered). Returns a count + the names that failed. Exported for reuse by the
 * parent's drag-and-drop handler.
 */
export async function uploadMany(
  container: string,
  files: File[],
): Promise<{ uploaded: number; failed: string[] }> {
  let uploaded = 0;
  const failed: string[] = [];
  for (const file of files) {
    try {
      await uploadFile(container, file);
      uploaded += 1;
    } catch {
      failed.push(file.name);
    }
  }
  return { uploaded, failed };
}

function NewFolderDialog({
  open,
  container,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  container: string;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      await createContainer(childContainerUrl(container, name));
      toast.success(`Created folder “${name}”.`);
      onCreated();
      onOpenChange(false);
      setName("");
    } catch (e) {
      toast.error(writeErrorMessage(e, "A folder with that name already exists."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>New folder</AlertDialogTitle>
          <AlertDialogDescription>
            Create a new folder inside the current one.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="new-folder-name">Folder name</Label>
          <Input
            id="new-folder-name"
            value={name}
            autoFocus
            placeholder="Photos"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim() && !busy) void create();
            }}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!name.trim() || busy}
            onClick={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            Create folder
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function NewFileDialog({
  open,
  container,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  container: string;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      // Default to a Turtle file when no extension was given (the common case
      // for a hand-authored RDF resource); the source editor opens it next.
      const url = childResourceUrl(container, name, "ttl");
      const contentType = guessContentType(url) ?? "text/turtle";
      await writeRaw(url, "", { contentType, createOnly: true });
      toast.success(`Created “${name}”.`, {
        description: "Open it to add content in the source editor.",
      });
      onCreated();
      onOpenChange(false);
      setName("");
    } catch (e) {
      toast.error(writeErrorMessage(e, "A file with that name already exists."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>New file</AlertDialogTitle>
          <AlertDialogDescription>
            Create an empty file. Add an extension (e.g. <code>.ttl</code>,{" "}
            <code>.md</code>) or one will default to Turtle.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="new-file-name">File name</Label>
          <Input
            id="new-file-name"
            value={name}
            autoFocus
            placeholder="notes.ttl"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim() && !busy) void create();
            }}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!name.trim() || busy}
            onClick={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            Create file
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
