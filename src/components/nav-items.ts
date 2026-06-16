import type { LucideIcon } from "lucide-react";
import {
  Home,
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
] as const;
