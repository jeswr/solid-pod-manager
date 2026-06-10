"use client";

import { use } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronRight, ExternalLink, Eye, ShieldCheck } from "lucide-react";
import { categoryById } from "@/lib/categories";
import { nameFromUrl } from "@/lib/pod-data";
import { viewerKindLabel } from "@/lib/viewers";
import { formatBytes } from "@/lib/format";
import { isInOwnPods } from "@/lib/pod-scope";
import { useSession } from "@/components/session-provider";
import { useResource } from "@/components/use-resource";
import { ResourceViewer } from "@/components/resource-viewer";
import { ErrorState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function ItemDetailPage({
  params,
}: {
  params: Promise<{ category: string }>;
}) {
  const { category: categoryId } = use(params);
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
  const { data, error, loading } = useResource(url);
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
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <ExternalLink className="size-4" aria-hidden="true" />
          Open original
        </a>
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
          <ResourceViewer resource={data} />
        )}
      </section>
    </div>
  );
}
