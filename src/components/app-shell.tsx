"use client";

import { useState } from "react";
import { Loader2, Menu } from "lucide-react";
import { useSession } from "@/components/session-provider";
import { LoginScreen } from "@/components/login-screen";
import { SidebarNav, BottomNav } from "@/components/sidebar-nav";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { AccountMenu } from "@/components/account-menu";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/**
 * The authenticated app frame: persistent sidebar on desktop, a slide-in
 * drawer + bottom bar on mobile (responsive at 375/768/1280). Gates the whole
 * app on the Solid session — the user's own data is never behind a wall, so the
 * gate is purely "are you signed in", nothing more (DESIGN.md §2/§5).
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  const [drawerOpen, setDrawerOpen] = useState(false);

  if (status === "loading") {
    return (
      <div className="grid min-h-dvh place-items-center" role="status" aria-live="polite">
        <span className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" aria-hidden="true" />
          Loading your pod…
        </span>
      </div>
    );
  }

  if (status !== "logged-in") {
    return <LoginScreen />;
  }

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <div className="flex h-16 items-center px-5">
          <Brand />
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-2">
          <SidebarNav />
        </div>
        <div className="border-t border-sidebar-border p-3 text-xs text-muted-foreground">
          Your data stays in your pod.
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-border bg-background/90 px-4 backdrop-blur">
          {/* Mobile menu trigger */}
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu">
                <Menu className="size-5" aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 p-0">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <div className="flex h-16 items-center px-5">
                <Brand />
              </div>
              <div className="px-3 py-2">
                <SidebarNav onNavigate={() => setDrawerOpen(false)} />
              </div>
            </SheetContent>
          </Sheet>

          <div className="md:hidden">
            <Brand />
          </div>

          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <AccountMenu />
          </div>
        </header>

        {/* Page content. Bottom padding clears the mobile bottom bar. */}
        <main className="flex-1 px-4 pb-24 pt-6 md:px-8 md:pb-10">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>

      <BottomNav />
    </div>
  );
}
