import type { LucideIcon } from "lucide-react";
import {
  Home,
  Search,
  Database,
  FolderOpen,
  Plug,
  AppWindow,
  Activity,
  Settings,
  NotebookPen,
  CalendarDays,
  Users,
  ListTodo,
  Bookmark,
  IdCard,
  UsersRound,
  CircleDot,
  ClipboardCheck,
  Inbox,
  MessagesSquare,
  CalendarClock,
  Globe,
  Network,
} from "lucide-react";
// Import the flag from the SDK-FREE config module (NOT federation-registry.ts,
// which pulls @jeswr/federation-client) so the nav — in the primary app bundle —
// never bundles the federation SDK when the feature is dark (roborev finding).
import { isFederationRegistryEnabled } from "@/lib/federation-registry-config";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Stubbed for a later phase — shown disabled with a "Soon" hint. */
  stub?: boolean;
  /** Show in the mobile bottom bar (kept to the most-used destinations). */
  primary?: boolean;
  /**
   * Optional render gate. When present and it returns `false`, the item is
   * hidden from the nav entirely (used to feature-gate an integration on a
   * build-time `NEXT_PUBLIC_*` env). Items WITHOUT a gate always show. Filter on
   * this via {@link visibleNavItems} at render — never mutate the static array.
   */
  gate?: () => boolean;
}

/** Primary navigation (DESIGN.md §3). */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Home", icon: Home, primary: true },
  // Global pod search (task #97) — find anything across categories from one box.
  { href: "/search", label: "Search", icon: Search, primary: true },
  { href: "/my-data", label: "My data", icon: Database, primary: true },
  { href: "/files", label: "Files", icon: FolderOpen },
  { href: "/connect", label: "Connect", icon: Plug },
  { href: "/connected-apps", label: "Connected apps", icon: AppWindow, primary: true },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/settings", label: "Settings", icon: Settings, primary: true },
  // First-party productivity apps — each reads/writes standard RDF to the pod
  // and is registered in the Type Index, so its data also appears under "My data".
  { href: "/profile", label: "Profile", icon: IdCard },
  { href: "/notes", label: "Notes", icon: NotebookPen },
  { href: "/tasks", label: "Tasks", icon: ListTodo },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/bookmarks", label: "Bookmarks", icon: Bookmark },
  { href: "/issues", label: "Issues", icon: CircleDot },
  // Federation consumption: tasks assigned to me across my pods + people I trust.
  { href: "/assigned", label: "Assigned to me", icon: ClipboardCheck },
  { href: "/people", label: "People", icon: UsersRound },
  // Wave 6 cross-pod collaboration — receive notifications, chat, and schedule.
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/chat", label: "Chat", icon: MessagesSquare },
  { href: "/schedule", label: "Schedule", icon: CalendarClock },
  // The Solid community's forum + chat rooms, unified (read-first) via
  // @jeswr/solid-community-feeds. The forum works without any credentials.
  { href: "/community", label: "Solid Community", icon: Globe },
  // Federation discovery (read-only): apps a federation registry lists as
  // members. GATED on NEXT_PUBLIC_FEDERATION_REGISTRY — hidden until configured,
  // so the integration ships dark. Display-only; does NOT affect task trust.
  {
    href: "/federations",
    label: "Federations",
    icon: Network,
    gate: () => isFederationRegistryEnabled,
  },
] as const;

/**
 * The nav items visible right now — every ungated item, plus each gated item
 * whose `gate()` currently returns `true`. The static {@link NAV_ITEMS} array is
 * never mutated (so it stays a stable build-time constant); render sites
 * (`SidebarNav` / `BottomNav`) map over THIS instead. Pure.
 */
export function visibleNavItems(): readonly NavItem[] {
  return NAV_ITEMS.filter((item) => item.gate === undefined || item.gate());
}
