import { Badge } from "@/components/ui/badge";
import type { IntegrationStatus } from "@/lib/integrations/registry";

/** Tier-honest status chip copy (docs/integrations-catalog.md). */
export const STATUS_COPY: Record<IntegrationStatus, string> = {
  live: "Connect",
  demo: "Demo",
  "approval-needed": "Coming soon — needs platform approval",
  "export-file": "Import from export file",
};

/** The catalog/detail status chip. Honest by construction — never fake-live. */
export function StatusChip({ status }: { status: IntegrationStatus }) {
  if (status === "live") {
    return <Badge>{STATUS_COPY.live}</Badge>;
  }
  if (status === "demo") {
    return <Badge variant="secondary">{STATUS_COPY.demo}</Badge>;
  }
  return (
    <Badge variant="outline" className="whitespace-normal text-muted-foreground">
      {STATUS_COPY[status]}
    </Badge>
  );
}
