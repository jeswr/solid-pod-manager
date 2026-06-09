"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useCategorySummaries } from "@/components/use-pod-data";
import { categoryIcon } from "@/components/category-icon";
import { ErrorState } from "@/components/states";
import { commonCategories, otherCategories, type DataCategory } from "@/lib/categories";
import type { CategorySummary } from "@/lib/pod-data";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

export default function MyDataPage() {
  const { data: summaries, loading, error } = useCategorySummaries();

  const byId = new Map((summaries ?? []).map((s) => [s.category.id, s]));

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">My data</h1>
        <p className="measure mt-1 text-muted-foreground text-pretty">
          Everything in your pod, grouped into plain categories. Choose one to
          see what&apos;s inside.
        </p>
      </header>

      {error ? (
        <ErrorState error={error} />
      ) : (
        <>
          <CategoryTier
            title="Common"
            categories={commonCategories()}
            byId={byId}
            loading={loading}
          />
          <CategoryTier
            title="Other"
            categories={otherCategories()}
            byId={byId}
            loading={loading}
          />
        </>
      )}
    </div>
  );
}

function CategoryTier({
  title,
  categories,
  byId,
  loading,
}: {
  title: string;
  categories: DataCategory[];
  byId: Map<string, CategorySummary>;
  loading: boolean;
}) {
  return (
    <section aria-label={`${title} categories`} className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {categories.map((category) => {
          const summary = byId.get(category.id);
          const Icon = categoryIcon(category.icon);
          const count = summary?.locations.length ?? 0;
          const hasData = summary?.hasData ?? false;

          return (
            <li key={category.id}>
              <Link
                href={`/my-data/${category.id}`}
                className="group flex h-full flex-col gap-3 rounded-2xl border border-border bg-card p-5 transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <div className="flex items-center justify-between">
                  <span
                    aria-hidden="true"
                    className="grid size-11 place-items-center rounded-xl bg-accent text-accent-foreground"
                  >
                    <Icon className="size-5" />
                  </span>
                  {loading ? (
                    <Skeleton className="h-5 w-14 rounded-full" />
                  ) : hasData ? (
                    <Badge variant="secondary" className="tabular">
                      {count} {count === 1 ? "item" : "items"}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">
                      Empty
                    </Badge>
                  )}
                </div>
                <div>
                  <h3 className="flex items-center gap-1 font-medium">
                    {category.label}
                    <ArrowRight
                      className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                      aria-hidden="true"
                    />
                  </h3>
                  <p className="mt-0.5 text-sm text-muted-foreground text-pretty">
                    {category.description}
                  </p>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
