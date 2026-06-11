/**
 * Server shell for the per-app connect flow. The integration catalog is fixed
 * at build time, so under `output: "export"` every `/connect/<id>` page is
 * prerendered via {@link generateStaticParams}; the flow itself is fully
 * client-side (ConnectView). `dynamicParams = false`: unknown ids 404.
 */
import { allCatalogEntries } from "@/lib/integrations/registry";
import { ConnectView } from "./connect-view";

export const dynamicParams = false;

export function generateStaticParams(): { id: string }[] {
  return allCatalogEntries().map((e) => ({ id: e.id }));
}

export default async function ConnectAppPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ConnectView id={id} />;
}
