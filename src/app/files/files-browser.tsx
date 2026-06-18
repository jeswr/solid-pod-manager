// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * The file/folder browser (Wave 1) — the SolidOS file-manager affordance the
 * app lacked, as a path-addressed SPA over the standard LDP surface. The
 * current container is the `?url=` query param (defaults to the active pod
 * storage root); folders navigate in-app, files open the item viewer.
 *
 * Layout mirrors the server `dataView.ts` container view (breadcrumb + rows,
 * folders-first) and the app's existing list patterns (loading skeletons,
 * EmptyState, ErrorState). The whole listing is a drag-and-drop upload target.
 *
 * SECURITY (SEC-1): the auth-patched fetch attaches the user's DPoP token to
 * whatever URL it requests, so we ONLY ever browse/fetch inside the user's own
 * pods — a `?url=` outside scope is rejected, never fetched.
 */
import { Suspense, useCallback, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ChevronRight,
  FolderOpen,
  FilePlus,
  Loader2,
  Settings2,
  UploadCloud,
} from "lucide-react";
import { toast } from "sonner";
import { RdfFetchError } from "@jeswr/fetch-rdf";
import { asContainerUrl, breadcrumbs, type Crumb } from "@/lib/files";
import { useFilesScope, useFolder } from "@/components/use-files";
import { FileRow } from "@/components/file-row";
import { FileToolbar, uploadMany } from "@/components/file-actions";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/states";
import { ItemRowSkeleton } from "@/components/item-row";
import { Skeleton } from "@/components/ui/skeleton";

export function FilesBrowser() {
  // useSearchParams needs a Suspense boundary under `output: export`.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <FilesScreen />
    </Suspense>
  );
}

function FilesScreen() {
  const searchParams = useSearchParams();
  const { root, inScope } = useFilesScope();

  // No active storage yet (still resolving the session/profile).
  if (!root) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }

  const requested = searchParams.get("url");
  const current = requested ? asContainerUrl(requested) : root;

  // Refuse any container outside the user's own pods (confused-deputy guard).
  if (!inScope(current)) {
    return (
      <ErrorState
        error={new Error("This folder is outside your pod, so it can't be opened here.")}
      />
    );
  }

  return <FolderContents current={current} root={root} />;
}

function FolderContents({ current, root }: { current: string; root: string }) {
  // Bug #11: auxiliary resources (.acl/.meta/.acr) are hidden from the listing
  // by default and revealed under "Advanced options".
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { data, loading, error, reload } = useFolder(current, showAdvanced);
  const crumbs = breadcrumbs(current, root);
  const [dragging, setDragging] = useState(false);
  const [dropUploading, setDropUploading] = useState(false);

  const onDrop = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setDropUploading(true);
      const result = await uploadMany(current, files);
      setDropUploading(false);
      if (result.uploaded > 0) {
        toast.success(
          result.uploaded === 1 ? "Uploaded 1 file." : `Uploaded ${result.uploaded} files.`,
        );
        reload();
      }
      if (result.failed.length > 0) {
        toast.error(`Couldn't upload ${result.failed.length} file(s).`, {
          description: result.failed.join(", ").slice(0, 200),
        });
      }
    },
    [current, reload],
  );

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumbs crumbs={crumbs} />

      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"
          >
            <FolderOpen className="size-6" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              {crumbs.at(-1)?.label ?? "Files"}
            </h1>
            <p className="text-sm text-muted-foreground">
              Browse and manage everything in your pod.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={showAdvanced ? "secondary" : "outline"}
            size="sm"
            aria-pressed={showAdvanced}
            onClick={() => setShowAdvanced((v) => !v)}
            title="Show or hide system files like .acl and .meta"
          >
            <Settings2 className="size-4" aria-hidden="true" />
            Advanced options
          </Button>
          <FileToolbar container={current} onChange={reload} />
        </div>
      </header>

      {/* The listing is a drop target for upload. */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={(e) => {
          // Only clear when leaving the container, not a child.
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void onDrop(Array.from(e.dataTransfer.files));
        }}
        className={
          dragging
            ? "rounded-2xl outline-2 outline-dashed outline-primary outline-offset-4"
            : undefined
        }
      >
        {dragging || dropUploading ? (
          <div className="mb-3 flex items-center justify-center gap-2 rounded-xl border border-dashed border-primary/60 bg-accent/30 px-4 py-6 text-sm text-muted-foreground">
            {dropUploading ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <UploadCloud className="size-4" aria-hidden="true" />
            )}
            {dropUploading ? "Uploading…" : "Drop files to upload here"}
          </div>
        ) : null}

        {error ? (
          <FolderError error={error} onRetry={reload} />
        ) : loading ? (
          <ul className="flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <ItemRowSkeleton key={i} />
            ))}
          </ul>
        ) : (data ?? []).length === 0 ? (
          <EmptyState
            icon={FilePlus}
            title="This folder is empty"
            description="Upload a file, or create a new folder or file to get started."
          />
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Folder contents">
            {data!.map((item) => (
              <li key={item.url}>
                <FileRow item={item} root={root} onChange={reload} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Folder-specific error copy: a 403/401 is a permission case, not "broken". */
function FolderError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  if (error instanceof RdfFetchError && (error.status === 401 || error.status === 403)) {
    return (
      <EmptyState
        icon={FolderOpen}
        title="You don't have access to this folder"
        description="Sign in again, or ask the owner to share it with you."
      />
    );
  }
  if (error instanceof RdfFetchError && error.status === 404) {
    return (
      <EmptyState
        icon={FolderOpen}
        title="This folder doesn't exist"
        description="It may have been moved or deleted."
      />
    );
  }
  return <ErrorState error={error} onRetry={onRetry} />;
}

function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
      <ol className="flex flex-wrap items-center gap-1">
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <li key={crumb.url} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="size-4" aria-hidden="true" />}
              {isLast ? (
                <span aria-current="page" className="truncate font-medium text-foreground">
                  {crumb.label}
                </span>
              ) : (
                <Link
                  href={`/files?url=${encodeURIComponent(crumb.url)}`}
                  className="hover:text-foreground hover:underline"
                >
                  {crumb.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
