/**
 * Server shell for the item detail view. Same export story as the category
 * page one level up: the category segment is enumerable at build time
 * (generateStaticParams), the actual resource is addressed by the `?url=`
 * query parameter and loaded entirely client-side (ItemView).
 */
import { CATEGORIES, UNCATEGORISED } from "@/lib/categories";
import { ItemView } from "./item-view";

export const dynamicParams = false;

export function generateStaticParams(): { category: string }[] {
  return [...CATEGORIES, UNCATEGORISED].map((c) => ({ category: c.id }));
}

export default async function ItemDetailPage({
  params,
}: {
  params: Promise<{ category: string }>;
}) {
  const { category } = await params;
  return <ItemView categoryId={category} />;
}
