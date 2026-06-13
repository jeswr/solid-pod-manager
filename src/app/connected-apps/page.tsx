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
  freshGrantsForAgent,
  permissionsBackend,
  useConnectedApps,
  type ConnectedApp,
} from "@/components/use-permissions";
import { describeModes } from "@/lib/permissions";
import { TrustedAppsSection } from "@/components/trusted-apps-section";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/** Stable empty fallback so the section's `apps` identity never churns. */
const EMPTY_APPS: ConnectedApp[] = [];

export default function ConnectedAppsPage() {
  const { data: apps, loading, error, revalidating, reload, getFreshModel } =
    useConnectedApps();
  // Optimistic removals: hide immediately, restore on failure.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  const visible = (apps ?? []).filter((a) => !removed.has(a.agentId));

  async function revokeAll(app: ConnectedApp) {
    setBusy((b) => new Set(b).add(app.agentId));
    setRemoved((r) => new Set(r).add(app.agentId));
    try {
      // SECURITY: revoke against FRESH grants, never the (possibly cached)
      // rendered snapshot. getFreshModel re-discovers live before we act.
      const fresh = await getFreshModel();
      const grants = freshGrantsForAgent(fresh, app.agentId);
      await permissionsBackend.revokeGrants(app.agentId, grants);
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
        {/* SWR affordance: this list may briefly show a cached snapshot while
            it re-checks who has access. Security-sensitive, so say so. */}
        {revalidating && !loading ? (
          <p
            className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <span
              aria-hidden="true"
              className="size-1.5 animate-pulse rounded-full bg-muted-foreground"
            />
            Refreshing access…
          </p>
        ) : null}
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
                    href={`/connected-apps/app?id=${encodeURIComponent(app.agentId)}`}
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

      {/* Trusted-apps reconciliation: the live `acl:origin` trust, with revoke
          through the same backend. The section renders its own leading divider
          and returns null (no dangling divider) when no origins are present. */}
      {!loading && !error ? (
        // Pass the STABLE apps snapshot (so the section's own optimistic-hide
        // state clears only on a real reload, not every parent re-render) PLUS
        // the parent's `removed` set, so an app hidden by "Revoke all" up here
        // is also hidden in the trusted-apps section until the reload completes
        // (roborev).
        <TrustedAppsSection
          apps={apps ?? EMPTY_APPS}
          parentRemoved={removed}
          reload={reload}
          getFreshModel={getFreshModel}
        />
      ) : null}
    </div>
  );
}
