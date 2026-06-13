// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * The files item view (`?url=` = the resource URL). Reuses the shared
 * `ResourceViewer` (typed views #61 + media viewers) for Preview, and adds an
 * Edit-source tab for text/RDF resources (SourceEditor). Breadcrumbs lead back
 * up the containing folder; Delete + Download mirror the file-manager row
 * actions for the open resource.
 *
 * SECURITY (SEC-1): only resources inside the user's own pods are fetched; a
 * cross-pod `?url=` is rejected, never requested with the user's token.
 */
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ChevronRight,
  Download,
  Eye,
  FileCode,
  Loader2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  asContainerUrl,
  breadcrumbs,
  deleteEntry,
  nameFromUrl,
  parentContainer,
  readBytes,
} from "@/lib/files";
import { ResourceDeleteError } from "@/lib/errors";
import { viewerKindLabel } from "@/lib/viewers";
import { formatBytes } from "@/lib/format";
import { useFilesScope } from "@/components/use-files";
import { useResource } from "@/components/use-resource";
import { ResourceViewer } from "@/components/resource-viewer";
import { SourceEditor } from "@/components/source-editor";
import { ErrorState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function FileItemView() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <FileItemScreen />
    </Suspense>
  );
}

function FileItemScreen() {
  const searchParams = useSearchParams();
  const { root, inScope } = useFilesScope();
  const url = searchParams.get("url") ?? "";

  if (!root) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }

  if (!url || !inScope(url)) {
    return (
      <ErrorState
        error={
          new Error(
            url
              ? "This link points outside your pod, so it can't be opened here."
              : "This item link is missing or invalid.",
          )
        }
      />
    );
  }

  return <FileItemDetail url={url} root={root} />;
}

type Tab = "preview" | "source";

function FileItemDetail({ url, root }: { url: string; root: string }) {
  const { data, error, loading } = useResource(url);
  const name = nameFromUrl(url);
  const parent = parentContainer(url, root) ?? root;
  const crumbs = breadcrumbs(asContainerUrl(parent), root);
  const [tab, setTab] = useState<Tab>("preview");

  // Editable = a text/RDF body we can round-trip in the source editor. Binary
  // kinds (image/pdf/audio/video/generic) have no meaningful text source.
  const editable =
    data != null && (data.viewer.kind === "rdf" || data.viewer.kind === "text");

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <ol className="flex flex-wrap items-center gap-1">
          {crumbs.map((crumb) => (
            <li key={crumb.url} className="flex items-center gap-1">
              <Link
                href={`/files?url=${encodeURIComponent(crumb.url)}`}
                className="hover:text-foreground hover:underline"
              >
                {crumb.label}
              </Link>
              <ChevronRight className="size-4" aria-hidden="true" />
            </li>
          ))}
          <li aria-current="page" className="truncate font-medium text-foreground">
            {name}
          </li>
        </ol>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {data ? <Badge variant="secondary">{viewerKindLabel(data.viewer.kind)}</Badge> : null}
            {data?.contentType ? (
              <span className="font-mono text-xs">{data.viewer.mediaType}</span>
            ) : null}
            {data?.size ? <span className="tabular">{formatBytes(data.size)}</span> : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DownloadButton url={url} name={name} />
          <DeleteButton url={url} name={name} parent={parent} />
        </div>
      </header>

      {editable && (
        <div
          role="tablist"
          aria-label="View mode"
          className="inline-flex w-fit gap-1 rounded-xl border border-border bg-muted/40 p-1"
        >
          <TabButton active={tab === "preview"} onClick={() => setTab("preview")} icon={Eye}>
            Preview
          </TabButton>
          <TabButton active={tab === "source"} onClick={() => setTab("source")} icon={FileCode}>
            Edit source
          </TabButton>
        </div>
      )}

      <section aria-label={tab === "source" ? "Source editor" : "Preview"} className="flex flex-col gap-3">
        {error ? (
          <ErrorState error={error} />
        ) : loading || !data ? (
          <div className="space-y-3">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-40 w-full rounded-2xl" />
          </div>
        ) : tab === "source" && editable ? (
          <SourceEditor url={url} />
        ) : (
          <ResourceViewer resource={data} />
        )}
      </section>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Eye;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={
        active
          ? "inline-flex items-center gap-1.5 rounded-lg bg-background px-3 py-1.5 text-sm font-medium shadow-sm"
          : "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
      }
    >
      <Icon className="size-4" aria-hidden="true" />
      {children}
    </button>
  );
}

function DownloadButton({ url, name }: { url: string; name: string }) {
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    try {
      const { blob } = await readBytes(url);
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      toast.error("Couldn't download this file.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void download()}>
      {busy ? (
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <Download className="size-4" aria-hidden="true" />
      )}
      Download
    </Button>
  );
}

function DeleteButton({
  url,
  name,
  parent,
}: {
  url: string;
  name: string;
  parent: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function doDelete() {
    setBusy(true);
    try {
      await deleteEntry(url);
      toast.success(`Deleted “${name}”.`);
      router.push(`/files?url=${encodeURIComponent(asContainerUrl(parent))}`);
    } catch (e) {
      setBusy(false);
      setConfirming(false);
      const msg =
        e instanceof ResourceDeleteError
          ? `Couldn't delete this (${e.status}). Nothing was changed.`
          : "Couldn't delete this. Nothing was changed.";
      toast.error(msg);
    }
  }

  if (!confirming) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={() => setConfirming(true)}
      >
        <Trash2 className="size-4" aria-hidden="true" />
        Delete
      </Button>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-2 py-1"
      role="group"
      aria-label={`Confirm deleting ${name}`}
    >
      <span className="text-sm text-muted-foreground">Delete permanently?</span>
      <Button size="sm" variant="destructive" disabled={busy} onClick={() => void doDelete()}>
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
        Yes, delete
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </span>
  );
}
