// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Bookmarks — a first-party app. Lists the user's bookmarks (`bookmark:Bookmark`
 * under `bookmarks/`) alphabetically by title, with a favicon + host, an
 * **Open** action, tag chips, and create / edit / delete via `/bookmarks/edit`.
 * Renders the same shape the read-only typed-view card (#61) does. Mirrors the
 * Contacts patterns.
 */
import { useMemo } from "react";
import Link from "next/link";
import { Bookmark as BookmarkIcon, ExternalLink, Plus, Tag } from "lucide-react";
import { bookmarksStore, bookmarkHost, type Bookmark } from "@/lib/bookmarks";
import { useStore, useItems } from "@/components/use-productivity";
import { EmptyState, ErrorState } from "@/components/states";
import { ItemRowSkeleton } from "@/components/item-row";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { safeLinkHref } from "@/lib/pod-scope";
import type { StoredItem } from "@/lib/productivity-store";

/** True for an absolute http(s) URL — the only schemes the Open action allows. */
function isHttpHref(href: string): boolean {
  try {
    const proto = new URL(href).protocol;
    return proto === "http:" || proto === "https:";
  } catch {
    return false;
  }
}

export default function BookmarksPage() {
  const store = useStore<Bookmark>(bookmarksStore);
  const { data, loading, error, reload } = useItems(store);

  const bookmarks = useMemo(
    () =>
      [...(data ?? [])].sort((a, b) =>
        (a.data.title || a.data.url || "").localeCompare(
          b.data.title || b.data.url || "",
          undefined,
          { sensitivity: "base" },
        ),
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
            <BookmarkIcon className="size-6" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Bookmarks</h1>
            <p className="measure mt-1 text-sm text-muted-foreground text-pretty">
              The links you want to keep, stored privately in your pod.
            </p>
          </div>
        </div>
        <Button asChild>
          <Link href="/bookmarks/edit">
            <Plus aria-hidden="true" />
            New bookmark
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
      ) : bookmarks.length === 0 ? (
        <EmptyState
          icon={BookmarkIcon}
          title="No bookmarks yet"
          description="Save a link to come back to. It is kept privately in your pod."
          action={
            <Button asChild>
              <Link href="/bookmarks/edit">
                <Plus aria-hidden="true" />
                New bookmark
              </Link>
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2" aria-label="Your bookmarks">
          {bookmarks.map((bookmark) => (
            <li key={bookmark.url}>
              <BookmarkRow bookmark={bookmark} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BookmarkRow({ bookmark }: { bookmark: StoredItem<Bookmark> }) {
  const b = bookmark.data;
  const editHref = `/bookmarks/edit?id=${encodeURIComponent(bookmark.url)}`;
  const host = bookmarkHost(b.url);
  // Only ever surface a safe http(s) outbound link (no raw URI as a data row).
  // The editor enforces http(s)-only, but externally-authored data in the
  // container might carry a mailto:/other scheme, so re-filter here.
  const safe = safeLinkHref(b.url);
  const safeOutbound = safe && isHttpHref(safe) ? safe : undefined;
  const title = b.title.trim() || host || "Untitled bookmark";

  return (
    <div className="group flex items-center gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:bg-accent/40">
      {/* A local icon, not a remote favicon: fetching a third-party favicon would
          leak every private bookmark host to that service on render. */}
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
      >
        <BookmarkIcon className="size-5" />
      </span>
      <Link
        href={editHref}
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="truncate font-medium leading-tight" title={title}>
          {title}
        </span>
        {host && <span className="truncate text-xs text-muted-foreground">{host}</span>}
        {b.tags.length > 0 && (
          <span className="mt-1 flex flex-wrap items-center gap-1">
            {b.tags.slice(0, 4).map((tag) => (
              <Badge key={tag} variant="secondary">
                <Tag className="size-3" aria-hidden="true" />
                {tag}
              </Badge>
            ))}
          </span>
        )}
      </Link>
      {safeOutbound && (
        <Button variant="outline" size="sm" asChild className="shrink-0">
          <a href={safeOutbound} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="size-4" aria-hidden="true" />
            Open
          </a>
        </Button>
      )}
    </div>
  );
}
