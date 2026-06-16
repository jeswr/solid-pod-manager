"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Loader2, Menu, TriangleAlert } from "lucide-react";
import { useSession } from "@/components/session-provider";
import { usePrefetch } from "@/components/use-prefetch";
import { LoginScreen } from "@/components/login-screen";
import { SidebarNav, BottomNav } from "@/components/sidebar-nav";
import { FeedbackButton } from "@jeswr/app-shell";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { AccountMenu } from "@/components/account-menu";
import { APP_VERSION } from "@/lib/app-version";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/**
 * The authenticated app frame: persistent sidebar on desktop, a slide-in
 * drawer + bottom bar on mobile (responsive at 375/768/1280). Gates the whole
 * app on the Solid session — the user's own data is never behind a wall, so the
 * gate is purely "are you signed in", nothing more (DESIGN.md §2/§5).
 */
/**
 * Public legal pages: never behind the sign-in gate (platform reviews and
 * signed-out users must reach them), and prerendered with their real content
 * under `output: "export"` — they carry their own minimal chrome.
 */
const PUBLIC_ROUTES = new Set(["/privacy", "/terms"]);

export function AppShell({ children }: { children: React.ReactNode }) {
  const { status, profileStatus, retryProfile, webId } = useSession();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  // PROACTIVE PREFETCH (PM #65 Phase 2): once logged in, warm the SWR read cache
  // for the likely-next pages during browser idle time, so the user's FIRST
  // navigation to any read page is instant. Self-gates on `status:"logged-in"`
  // and runs once per (webId, activeStorage); it is a side-effect scheduled off
  // the render path, so it never delays this shell's paint. Mounted here — once,
  // in the authenticated frame — so it covers the whole app, not just Home.
  usePrefetch();

  if (pathname !== null && PUBLIC_ROUTES.has(pathname)) {
    return <>{children}</>;
  }

  // While we silently restore a returning user's session (refresh-token grant,
  // no popup), hold this brief loading state — never flash or route to the
  // login screen. Login is shown ONLY once the restore decision lands as
  // "logged-out" (no/expired/revoked token).
  if (status === "loading") {
    return (
      <div className="grid min-h-dvh place-items-center" role="status" aria-live="polite">
        <span className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" aria-hidden="true" />
          Restoring your session…
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
            {/* Shared suite feedback control (@jeswr/app-shell): report an issue /
                give feedback / get help. Files to THIS app's repo
                (jeswr/solid-pod-manager) in GitHub prefill mode (`submit` unset —
                the suite-wide feedback-proxy hook is wired in later). The signed-in
                WebID is passed but only attached to the issue if the reporter ticks
                the consent box in the dialog. Sits alongside PM's own theme toggle
                + account menu — those are unchanged. */}
            <FeedbackButton
              repo="jeswr/solid-pod-manager"
              appName="Pod Manager"
              appVersion={APP_VERSION}
              webId={webId}
            />
            <ThemeToggle />
            <AccountMenu />
          </div>
        </header>

        {/* Page content. Bottom padding clears the mobile bottom bar. */}
        <main className="flex-1 px-4 pb-24 pt-6 md:px-8 md:pb-10">
          <div className="mx-auto w-full max-w-6xl">
            {/* Logged in, but the profile/storage read failed: the session is
                real, so we DON'T bounce to login — we degrade with a single,
                non-blocking, retryable banner at the shell level. Feature pages
                guard on `activeStorage`/`profile` being set (showing their idle
                state), so this banner is the one place that explains why and
                offers a retry, instead of each page handling undefined storage. */}
            {profileStatus === "error" && (
              <Alert variant="destructive" className="mb-6">
                <TriangleAlert className="size-4" aria-hidden="true" />
                <AlertTitle>Couldn&apos;t load your profile</AlertTitle>
                <AlertDescription className="flex flex-col items-start gap-3">
                  <span>
                    You&apos;re signed in, but we couldn&apos;t read your profile and
                    storage from your pod. Your data is safe — this is usually a
                    temporary connection issue.
                  </span>
                  <Button size="sm" variant="outline" onClick={retryProfile}>
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {children}
          </div>
        </main>
      </div>

      <BottomNav />
    </div>
  );
}
