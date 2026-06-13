// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * View-switcher tray (SolidOS-parity A3). A small segmented control above the
 * viewer that toggles the rendering of a resource between the typed card, the
 * raw-triples table, and (when present) the source platform. Mirrors SolidOS's
 * pane icon tray while preserving our no-raw-RDF-by-default thesis: the tray's
 * initial selection is always the typed card (see `view-modes.ts`), and the tray
 * only appears when there is more than one rendering to choose between.
 *
 * Pure presentation — the available modes + initial mode are decided by the pure
 * `view-modes.ts` logic; this only renders the buttons and reports the choice.
 */
import {
  ExternalLink,
  LayoutGrid,
  Rows3,
  Table as TableIcon,
  type LucideIcon,
} from "lucide-react";
import type { ViewMode, ViewModeOption } from "@/lib/typed-views/view-modes";
import { cn } from "@/lib/utils";

/** Map the pure layer's icon names to Lucide components (UI-layer only). */
const ICONS: Record<string, LucideIcon> = {
  "layout-grid": LayoutGrid,
  table: TableIcon,
  "table-rows": Rows3,
  "external-link": ExternalLink,
};

/** A segmented tray of view modes; calls `onChange` when the user picks one. */
export function ViewSwitcher({
  options,
  active,
  onChange,
}: {
  options: ViewModeOption[];
  active: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  if (options.length < 2) return null;
  return (
    <div
      role="group"
      aria-label="Choose how to view this resource"
      className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5"
    >
      {options.map((opt) => {
        const Icon = ICONS[opt.icon] ?? LayoutGrid;
        const isActive = opt.mode === active;
        return (
          <button
            key={opt.mode}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange(opt.mode)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              isActive
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
