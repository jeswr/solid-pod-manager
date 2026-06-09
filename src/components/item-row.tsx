import Link from "next/link";
import { ChevronRight, Folder, FileText } from "lucide-react";
import type { PodItem } from "@/lib/pod-data";
import { chooseViewer, viewerKindLabel } from "@/lib/viewers";
import { formatBytes, formatModified } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";

/** One item row in a category list — links to the item detail view. */
export function ItemRow({ item, categoryId }: { item: PodItem; categoryId: string }) {
  const viewer = chooseViewer(item.mimeType, item.url);
  const Icon = item.isContainer ? Folder : FileText;
  const kindLabel = item.isContainer ? "Folder" : viewerKindLabel(viewer.kind);
  const size = formatBytes(item.size);
  const modified = formatModified(item.modified);

  const href = `/my-data/${categoryId}/item?url=${encodeURIComponent(item.url)}`;

  return (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
      <ChevronRight
        className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
        aria-hidden="true"
      />
    </Link>
  );
}

export function ItemRowSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-3">
      <Skeleton className="size-10 rounded-lg" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-3 w-1/4" />
      </div>
    </div>
  );
}
