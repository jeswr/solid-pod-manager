import type { LucideIcon } from "lucide-react";
import { Home, Database, Plug, AppWindow, Activity, Settings } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Stubbed for a later phase — shown disabled with a "Soon" hint. */
  stub?: boolean;
  /** Show in the mobile bottom bar (kept to the most-used destinations). */
  primary?: boolean;
}

/** Primary navigation (DESIGN.md §3). Connected apps + Activity are P2/P3 stubs. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Home", icon: Home, primary: true },
  { href: "/my-data", label: "My data", icon: Database, primary: true },
  { href: "/connect", label: "Connect", icon: Plug },
  { href: "/connected-apps", label: "Connected apps", icon: AppWindow, stub: true, primary: true },
  { href: "/activity", label: "Activity", icon: Activity, stub: true },
  { href: "/settings", label: "Settings", icon: Settings, primary: true },
] as const;
