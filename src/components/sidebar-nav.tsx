"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { visibleNavItems } from "@/components/nav-items";
import { cn } from "@/lib/utils";

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The primary nav link list, shared by the desktop sidebar and the mobile
 * drawer. Native `<a href>` via next/link (accessible-html-links skill); the
 * active item is marked with `aria-current="page"`.
 */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary" className="flex flex-col gap-1">
      {visibleNavItems().map(({ href, label, icon: Icon, stub }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
            )}
          >
            <Icon
              className={cn("size-5 shrink-0", active && "text-sidebar-primary")}
              aria-hidden="true"
            />
            <span className="flex-1">{label}</span>
            {stub && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wide text-muted-foreground">
                Soon
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

/** The compact bottom bar shown on mobile (primary destinations only). */
export function BottomNav() {
  const pathname = usePathname();
  const items = visibleNavItems().filter((i) => i.primary);

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-sidebar-border bg-sidebar/95 backdrop-blur md:hidden"
    >
      {items.map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex flex-1 flex-col items-center gap-1 py-2 text-[0.6875rem] font-medium",
              "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              active ? "text-sidebar-primary" : "text-sidebar-foreground/70",
            )}
          >
            <Icon className="size-5" aria-hidden="true" />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
