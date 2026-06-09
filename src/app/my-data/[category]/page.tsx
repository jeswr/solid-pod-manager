"use client";

import { use } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, FolderOpen, Inbox, ShieldCheck } from "lucide-react";
import { categoryById } from "@/lib/categories";
import {
  useCategorySummary,
  useCategoryItems,
} from "@/components/use-pod-data";
import { categoryIcon } from "@/components/category-icon";
import { EmptyState, ErrorState } from "@/components/states";
import { ItemRow, ItemRowSkeleton } from "@/components/item-row";

export default function CategoryPage({
  params,
}: {
  params: Promise<{ category: string }>;
}) {
  const { category: categoryId } = use(params);
  const category = categoryById(categoryId);
  if (!category) notFound();

  const summaryState = useCategorySummary(categoryId);
  const itemsState = useCategoryItems(summaryState.data);
  const Icon = categoryIcon(category.icon);

  const loading = summaryState.loading || itemsState.loading;
  const error = summaryState.error ?? itemsState.error;
  const items = itemsState.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <ol className="flex items-center gap-1">
          <li>
            <Link href="/my-data" className="hover:text-foreground hover:underline">
              My data
            </Link>
          </li>
          <ChevronRight className="size-4" aria-hidden="true" />
          <li aria-current="page" className="font-medium text-foreground">
            {category.label}
          </li>
        </ol>
      </nav>

      <header className="flex items-start gap-4">
        <span
          aria-hidden="true"
          className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"
        >
          <Icon className="size-6" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{category.label}</h1>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
            <ShieldCheck className="size-4 shrink-0 text-primary" aria-hidden="true" />
            {category.assurance}
          </p>
        </div>
      </header>

      {error ? (
        <ErrorState error={error} onRetry={itemsState.reload} />
      ) : loading ? (
        <ul className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <ItemRowSkeleton key={i} />
          ))}
        </ul>
      ) : items.length === 0 ? (
        <EmptyState
          icon={summaryState.data?.hasData ? Inbox : FolderOpen}
          title={`No ${category.label.toLowerCase()} items yet`}
          description={
            summaryState.data?.hasData
              ? "This category is registered in your pod, but there's nothing inside it right now."
              : `Nothing here yet. When an app stores ${category.label.toLowerCase()} data, you'll see it listed here.`
          }
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground tabular">
            {items.length} {items.length === 1 ? "item" : "items"}
          </p>
          <ul className="flex flex-col gap-2" aria-label={`${category.label} items`}>
            {items.map((item) => (
              <li key={item.url}>
                <ItemRow item={item} categoryId={category.id} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
