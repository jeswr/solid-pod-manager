"use client";

/**
 * Connected apps — the permission manager list (DESIGN.md §4 screen 6, R3/R4).
 * Each row: app name, homepage, the categories it can touch in plain language,
 * its modes, and a one-click "Revoke all" (optimistic, with rollback + a
 * reassuring toast — §6).
 */
import { useState } from "react";
import Link from "next/link";
import { AppWindow, ChevronRight, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, ErrorState } from "@/components/states";
import {
  AppHomepageLink,
  ModeBadges,
  categoriesPhrase,
} from "@/components/permissions-ui";
import {
  permissionsBackend,
  useConnectedApps,
  type ConnectedApp,
} from "@/components/use-permissions";
import { allGrants, describeModes } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export default function ConnectedAppsPage() {
  const { data: apps, loading, error, reload } = useConnectedApps();
  // Optimistic removals: hide immediately, restore on failure.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  const visible = (apps ?? []).filter((a) => !removed.has(a.agentId));

  async function revokeAll(app: ConnectedApp) {
    setBusy((b) => new Set(b).add(app.agentId));
    setRemoved((r) => new Set(r).add(app.agentId));
    try {
      await permissionsBackend.revokeGrants(app.agentId, allGrants(app));
      toast.success(`${app.name} can no longer access your data.`, {
        description: "You can grant access again anytime.",
      });
      reload();
    } catch {
      // Rollback: the app still has access — never pretend otherwise.
      setRemoved((r) => {
        const next = new Set(r);
        next.delete(app.agentId);
        return next;
      });
      toast.error(`Couldn't revoke ${app.name}'s access.`, {
        description: "Nothing was changed. Check your connection and try again.",
      });
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(app.agentId);
        return next;
      });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          Connected apps
        </h1>
        <p className="measure mt-1 text-muted-foreground text-pretty">
          The apps that can read or write your data — and exactly which
          categories each one can touch. One-click revoke, any time.
        </p>
      </header>

      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading connected apps">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-2xl" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={AppWindow}
          title="No apps connected yet"
          description="When you approve an app — on its consent screen or from here — it appears in this list, with exactly what it can see and a one-click way to take that back."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {visible.map((app) => (
            <li
              key={app.agentId}
              className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Link
                    href={`/connected-apps/${encodeURIComponent(app.agentId)}`}
                    className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {app.name}
                    <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
                  </Link>
                  <AppHomepageLink app={app} />
                </div>
                <p className="mt-1 text-sm text-muted-foreground text-pretty">
                  Can {describeModes(app.modes)} your{" "}
                  <span className="font-medium text-foreground">
                    {categoriesPhrase(app).toLowerCase()}
                  </span>
                  .
                </p>
                <div className="mt-2">
                  <ModeBadges modes={app.modes} />
                </div>
              </div>
              <Button
                variant="outline"
                className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={busy.has(app.agentId)}
                onClick={() => revokeAll(app)}
              >
                Revoke all
              </Button>
            </li>
          ))}
        </ul>
      )}

      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <ShieldCheck className="size-4 shrink-0 text-primary" aria-hidden="true" />
        Your own access to your data never depends on any of these grants.
      </p>
    </div>
  );
}
