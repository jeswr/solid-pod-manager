// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Global pod search (task #97 / research G9) — "finding 'where is X' across
 * categories is core PIM UX." One search box that scans the user's OWN pod
 * across types (notes, contacts, bookmarks, tasks, events, issues, polls, files)
 * and shows the matches GROUPED by their human {@link DataCategory}, each linking
 * to its item-detail / editor page.
 *
 * The query lives in the URL (`?q=`) so a search is shareable + bookmarkable and
 * survives a reload; `useSearchParams` needs a Suspense boundary under the static
 * export, so the body is wrapped (mirroring the productivity editors). The actual
 * scan is a bounded, own-pod-only client search behind {@link usePodSearch} (SWR-
 * cached per storage+query), so re-running a recent query paints instantly.
 */
import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Bookmark as BookmarkIcon,
  CalendarDays,
  CircleDot,
  ClipboardCheck,
  Contact as ContactIcon,
  FileText,
  NotebookPen,
  Search,
  CalendarClock,
  File as FileIcon,
  type LucideIcon,
} from "lucide-react";
import { usePodSearch } from "@/components/use-pod-search";
import { groupResults, type SearchResult, type SearchResultType } from "@/lib/pod-search";
import { categoryIcon } from "@/components/category-icon";
import { EmptyState, ErrorState } from "@/components/states";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

/** Per-result-type icon + singular noun (for the result row + the type badge). */
const TYPE_META: Record<SearchResultType, { icon: LucideIcon; noun: string }> = {
  note: { icon: NotebookPen, noun: "Note" },
  contact: { icon: ContactIcon, noun: "Contact" },
  bookmark: { icon: BookmarkIcon, noun: "Bookmark" },
  task: { icon: ClipboardCheck, noun: "Task" },
  event: { icon: CalendarDays, noun: "Event" },
  issue: { icon: CircleDot, noun: "Issue" },
  poll: { icon: CalendarClock, noun: "Poll" },
  file: { icon: FileIcon, noun: "File" },
  item: { icon: FileText, noun: "Item" },
};

export default function SearchPage() {
  // useSearchParams requires a Suspense boundary in a prerendered (export) page.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <SearchView />
    </Suspense>
  );
}

function SearchView() {
  const router = useRouter();
  // The committed query is the URL `?q=` (shareable / reload-safe); the input is
  // a controlled draft that DEBOUNCES into the URL so we don't re-scan on every
  // keystroke. Reading `?q=` on mount also makes a deep-linked /search?q=… work.
  const urlQuery = useSearchParams().get("q") ?? "";
  const [draft, setDraft] = useState(urlQuery);

  // Keep the input in sync if the URL changes underneath (back/forward, a shared
  // link opened in-app). Only when it actually differs, so typing isn't clobbered.
  useEffect(() => {
    setDraft((prev) => (prev === urlQuery ? prev : urlQuery));
  }, [urlQuery]);

  // Debounce the draft → URL (250ms) so the scan (keyed on the URL query) runs on
  // a settled query, not mid-word. `router.replace` keeps history clean.
  useEffect(() => {
    const trimmed = draft.trim();
    if (trimmed === urlQuery) return;
    const id = setTimeout(() => {
      router.replace(trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : "/search");
    }, 250);
    return () => clearTimeout(id);
  }, [draft, urlQuery, router]);

  const { data, loading, revalidating, error, reload, active } = usePodSearch(urlQuery);
  const groups = useMemo(() => groupResults(data?.results ?? []), [data]);
  const total = data?.results.length ?? 0;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-start gap-4">
        <span
          aria-hidden="true"
          className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"
        >
          <Search className="size-6" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
          <p className="measure mt-1 text-sm text-muted-foreground text-pretty">
            Find anything across your pod — notes, contacts, bookmarks, tasks, events, and more.
            Only your own data is searched, right here in your browser.
          </p>
        </div>
      </header>

      <div className="flex flex-col gap-2">
        <label htmlFor="pod-search" className="sr-only">
          Search your pod
        </label>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id="pod-search"
            type="search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search by name, title, email, tag…"
            autoFocus
            autoComplete="off"
            className="pl-9"
            aria-describedby="search-status"
          />
        </div>
        <p id="search-status" className="text-xs text-muted-foreground" aria-live="polite">
          {!active
            ? "Type at least two characters to search."
            : loading
              ? "Searching your pod…"
              : `${total} ${total === 1 ? "match" : "matches"}${data?.capped ? " (showing the first results)" : ""}${revalidating ? " · refreshing…" : ""}`}
        </p>
      </div>

      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !active ? (
        <EmptyState
          icon={Search}
          title="Search across your whole pod"
          description="Look up a person, a note, a bookmark, a task — anything you keep here, all in one place."
        />
      ) : loading ? (
        <SearchSkeleton />
      ) : total === 0 ? (
        <EmptyState
          icon={Search}
          title="No matches"
          description={`Nothing in your pod matches “${urlQuery.trim()}”. Try a different word, or a shorter one.`}
        />
      ) : (
        <div className="flex flex-col gap-8">
          {data?.capped ? (
            <p className="text-sm text-muted-foreground">
              Showing the first {total} matches. Narrow your search to see more specific results.
            </p>
          ) : null}
          {groups.map((group) => {
            const CatIcon = categoryIcon(group.category.icon);
            return (
              <section key={group.category.id} aria-labelledby={`g-${group.category.id}`}>
                <h2
                  id={`g-${group.category.id}`}
                  className="mb-3 flex items-center gap-2 text-lg font-semibold"
                >
                  <CatIcon className="size-5 text-muted-foreground" aria-hidden="true" />
                  {group.category.label}
                  <Badge variant="secondary">{group.results.length}</Badge>
                </h2>
                <ul className="grid gap-2">
                  {group.results.map((r) => (
                    <ResultRow key={r.url} result={r} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ResultRow({ result }: { result: SearchResult }) {
  const meta = TYPE_META[result.type];
  const RowIcon = meta.icon;
  return (
    <li>
      <Link
        href={result.href}
        className="flex items-start gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          aria-hidden="true"
          className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground"
        >
          <RowIcon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 truncate text-sm font-medium">{result.label}</span>
            <Badge variant="outline" className="shrink-0 text-[10px]">
              {meta.noun}
            </Badge>
          </span>
          {result.snippet ? (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {result.snippet}
            </span>
          ) : null}
        </span>
      </Link>
    </li>
  );
}

function SearchSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      <Skeleton className="h-6 w-40" />
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}
