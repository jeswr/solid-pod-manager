import type { LucideIcon } from "lucide-react";
import {
  Home,
  Database,
  Plug,
  AppWindow,
  Activity,
  Settings,
  NotebookPen,
  CalendarDays,
  Users,
  ListTodo,
  Bookmark,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Stubbed for a later phase — shown disabled with a "Soon" hint. */
  stub?: boolean;
  /** Show in the mobile bottom bar (kept to the most-used destinations). */
  primary?: boolean;
}

/** Primary navigation (DESIGN.md §3). */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Home", icon: Home, primary: true },
  { href: "/my-data", label: "My data", icon: Database, primary: true },
  { href: "/connect", label: "Connect", icon: Plug },
  { href: "/connected-apps", label: "Connected apps", icon: AppWindow, primary: true },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/settings", label: "Settings", icon: Settings, primary: true },
  // First-party productivity apps — each reads/writes standard RDF to the pod
  // and is registered in the Type Index, so its data also appears under "My data".
  { href: "/notes", label: "Notes", icon: NotebookPen },
  { href: "/tasks", label: "Tasks", icon: ListTodo },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/bookmarks", label: "Bookmarks", icon: Bookmark },
] as const;
