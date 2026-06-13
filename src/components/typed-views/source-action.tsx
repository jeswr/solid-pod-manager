// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Renders a resolved {@link SourceMatch} as an "Open in <source>" button
 * (design: `docs/typed-data-views.md` §5). This is the *only* place the source
 * URL surfaces — as an action, never as a data row — which is how typed cards
 * suppress the raw URL. Icon names (strings) from the pure layer are resolved
 * to Lucide components here (same pattern as `category-icon.tsx`), keeping
 * `lib/` DOM-free. The `href` was already gated by `safeLinkHref` upstream.
 */
import { CalendarDays, ExternalLink, type LucideIcon } from "lucide-react";
import type { SourceMatch } from "@/lib/typed-views/sources";
import { Button } from "@/components/ui/button";

/** Map an icon name (from the pure layer) to a Lucide component. */
const ICONS: Record<string, LucideIcon> = {
  "external-link": ExternalLink,
  calendar: CalendarDays,
};

/** A button/link that opens the resource on its source platform, in a new tab. */
export function SourceActionButton({ source }: { source: SourceMatch }) {
  const Icon = ICONS[source.icon] ?? ExternalLink;
  return (
    <Button variant="outline" size="sm" asChild>
      <a href={source.href} target="_blank" rel="noopener noreferrer">
        <Icon className="size-4" aria-hidden="true" />
        {source.label}
      </a>
    </Button>
  );
}
