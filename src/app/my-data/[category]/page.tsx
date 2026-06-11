/**
 * Server shell for the category browser. The category taxonomy is a fixed,
 * build-time list, so under `output: "export"` every category page is
 * prerendered via {@link generateStaticParams}; all data loading is client-side
 * (CategoryView). `dynamicParams = false`: an unknown category is a 404, and
 * static export could not serve it anyway.
 */
import { CATEGORIES, UNCATEGORISED } from "@/lib/categories";
import { CategoryView } from "./category-view";

export const dynamicParams = false;

export function generateStaticParams(): { category: string }[] {
  return [...CATEGORIES, UNCATEGORISED].map((c) => ({ category: c.id }));
}

export default async function CategoryPage({
  params,
}: {
  params: Promise<{ category: string }>;
}) {
  const { category } = await params;
  return <CategoryView categoryId={category} />;
}
