// AUTHORED-BY Claude Fable 5
"use client";

import { usePathname } from "next/navigation";
import { ErrorBoundary } from "@jeswr/app-shell";
import { ErrorState } from "@/components/states";

/**
 * Wraps the routed page content in the suite-shared <ErrorBoundary> (cross-app
 * parity #72/#73). A render/lifecycle error in any page is caught and replaced
 * with Pod Manager's themed <ErrorState> instead of white-screening the whole
 * app. `resetKey={pathname}` recovers on navigation: moving to another route
 * clears a caught error and re-renders the children — a broken page never traps
 * the user.
 *
 * Placed INSIDE <AppShell> around only `{children}`, so the app chrome
 * (sidebar / nav) stays outside the boundary and remains usable when a page
 * throws. We pass Pod Manager's own <ErrorState> as the fallback (rather than
 * app-shell's default) so the panel is themed by THIS app's design tokens —
 * app-shell's default ErrorState resolves against its private `--as-*` token
 * CSS, which we deliberately don't import (one token home).
 */
export function RoutedErrorBoundary({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <ErrorBoundary
      resetKey={pathname}
      fallback={({ error, reset }) => <ErrorState error={error} onRetry={reset} />}
    >
      {children}
    </ErrorBoundary>
  );
}
