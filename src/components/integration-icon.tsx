import {
  Activity,
  Code,
  FolderOpen,
  Gamepad2,
  MessagesSquare,
  Music,
  NotebookPen,
  Tv,
  type LucideIcon,
} from "lucide-react";
import { categoryById, UNCATEGORISED } from "@/lib/categories";
import type { CatalogEntry } from "@/lib/integrations/registry";
import { categoryIcon } from "./category-icon";

/** Hand-picked icons for the Tier-A adapters (no brand assets shipped). */
const TIER_A_ICONS: Record<string, LucideIcon> = {
  spotify: Music,
  github: Code,
  strava: Activity,
  reddit: MessagesSquare,
  discord: Gamepad2,
  twitch: Tv,
  notion: NotebookPen,
  dropbox: FolderOpen,
};

/**
 * Resolve an integration's display icon: a hand-picked one for Tier A,
 * otherwise the icon of its first pod category.
 */
export function integrationIcon(entry: CatalogEntry): LucideIcon {
  const picked = TIER_A_ICONS[entry.id];
  if (picked) return picked;
  const category = categoryById(entry.categories[0] ?? "") ?? UNCATEGORISED;
  return categoryIcon(category.icon);
}
