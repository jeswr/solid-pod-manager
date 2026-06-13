"use client";

/**
 * Client half of the item detail view (`?url=` = the resource URL). The server
 * shell (page.tsx) prerenders one per category id; useSearchParams is read
 * under the Suspense boundary that ItemView provides.
 */
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, ExternalLink, Eye, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { categoryById } from "@/lib/categories";
import { deleteResource, nameFromUrl } from "@/lib/pod-data";
import { ResourceDeleteError } from "@/lib/errors";
import { viewerKindLabel } from "@/lib/viewers";
import { formatBytes } from "@/lib/format";
import { isInOwnPods } from "@/lib/pod-scope";
import { useSession } from "@/components/session-provider";
import { useResource } from "@/components/use-resource";
import { ResourceViewer } from "@/components/resource-viewer";
import { ErrorState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function ItemView({ categoryId }: { categoryId: string }) {
  // useSearchParams requires a Suspense boundary in a prerendered page.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <ItemDetailScreen categoryId={categoryId} />
    </Suspense>
  );
}

function ItemDetailScreen({ categoryId }: { categoryId: string }) {
  const category = categoryById(categoryId);
  const searchParams = useSearchParams();
  const { profile } = useSession();
  const url = searchParams.get("url") ?? "";

  // SECURITY (review SEC-1): the auth-patched fetch attaches the user's DPoP token
  // to whatever URL it requests, so we MUST only open resources inside the user's
  // own pods. A cross-origin / cross-pod `?url=` is rejected, never fetched.
  const storages = profile?.storages ?? [];
  if (!isInOwnPods(url, storages)) {
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

  return <ItemDetail url={url} categoryId={categoryId} categoryLabel={category?.label} />;
}

function ItemDetail({
  url,
  categoryId,
  categoryLabel,
}: {
  url: string;
  categoryId: string;
  categoryLabel?: string;
}) {
  const { data, error, loading, reload } = useResource(url);
  const name = nameFromUrl(url);

  return (
    <div className="flex flex-col gap-6">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <ol className="flex flex-wrap items-center gap-1">
          <li>
            <Link href="/my-data" className="hover:text-foreground hover:underline">
              My data
            </Link>
          </li>
          <ChevronRight className="size-4" aria-hidden="true" />
          <li>
            <Link
              href={`/my-data/${categoryId}`}
              className="hover:text-foreground hover:underline"
            >
              {categoryLabel ?? "Category"}
            </Link>
          </li>
          <ChevronRight className="size-4" aria-hidden="true" />
          <li aria-current="page" className="truncate font-medium text-foreground">
            {name}
          </li>
        </ol>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {data ? (
              <Badge variant="secondary">{viewerKindLabel(data.viewer.kind)}</Badge>
            ) : null}
            {data?.contentType ? (
              <span className="font-mono text-xs">{data.viewer.mediaType}</span>
            ) : null}
            {data?.size ? <span className="tabular">{formatBytes(data.size)}</span> : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <ExternalLink className="size-4" aria-hidden="true" />
            Open original
          </a>
          <DeleteItemButton url={url} name={name} categoryId={categoryId} />
        </div>
      </header>

      {/* Access pointer — honest (no fabricated per-item status; the real
          per-app access list lives in Connected apps). */}
      <Card className="border-primary/20 bg-accent/20">
        <CardContent className="flex items-start gap-3 py-4 text-sm">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">Access:</span>{" "}
            apps can only read this if you&apos;ve granted them access.{" "}
            <Link href="/connected-apps" className="font-medium text-primary underline-offset-4 hover:underline">
              See and manage which apps have access
            </Link>
            .
          </p>
        </CardContent>
      </Card>

      {/* Edit is offered through the first-party apps (Notes/Calendar/Contacts)
          for the data types they own; arbitrary foreign resources are viewed and
          can be removed here. A one-line user-facing hint says so (PM NEW-3). */}
      <p className="text-sm text-muted-foreground">
        Viewing only. To change this, open it in the app that created it, or use
        Notes, Calendar or Contacts for those kinds of data. You can remove it
        here at any time.
      </p>

      {/* The content-type-aware viewer */}
      <section aria-label="Preview" className="flex flex-col gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Eye className="size-5 text-muted-foreground" aria-hidden="true" />
          Preview
        </h2>
        {error ? (
          <ErrorState error={error} />
        ) : loading || !data ? (
          <div className="space-y-3">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-40 w-full rounded-2xl" />
          </div>
        ) : (
          <ResourceViewer resource={data} onReload={reload} />
        )}
      </section>
    </div>
  );
}

/**
 * Delete a resource from the pod. A destructive, irreversible action, so it asks
 * for explicit confirmation first (DESIGN §6 — friction before harm) rather than
 * a one-click delete. On success it returns to the category list; a `404`/`410`
 * is treated as already-gone (idempotent).
 */
function DeleteItemButton({
  url,
  name,
  categoryId,
}: {
  url: string;
  name: string;
  categoryId: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function doDelete() {
    setBusy(true);
    try {
      await deleteResource(url);
      toast.success(`Deleted “${name}”.`, {
        description: "It's been removed from your pod.",
      });
      router.push(`/my-data/${categoryId}`);
    } catch (e) {
      setBusy(false);
      setConfirming(false);
      const msg =
        e instanceof ResourceDeleteError
          ? `Couldn't delete this (${e.status}). Nothing was changed.`
          : "Couldn't delete this. Nothing was changed.";
      toast.error(msg, { description: "Check your connection and try again." });
    }
  }

  if (!confirming) {
    return (
      <Button
        variant="outline"
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
      <Button size="sm" variant="destructive" disabled={busy} onClick={doDelete}>
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
        Yes, delete
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </span>
  );
}
