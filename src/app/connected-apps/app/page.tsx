"use client";

/**
 * App detail — per-category access with per-category revoke, plus a clear
 * danger-zone "Remove all access" (DESIGN.md §4 screen 6, R4). Revokes are
 * optimistic with rollback; confirmations reassure, not scare (§6), and
 * per-category revokes offer an Undo (re-grant with the same modes).
 *
 * Addressed as `/connected-apps/app?id=<agent id URL>` — a query parameter
 * rather than a path segment so the page prerenders under `output: "export"`
 * (agent ids are arbitrary URLs, unknowable at build time).
 */
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AppWindow, ChevronRight, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { categoryIcon } from "@/components/category-icon";
import { EmptyState, ErrorState } from "@/components/states";
import { AppHomepageLink, ModeBadges } from "@/components/permissions-ui";
import {
  permissionsBackend,
  useConnectedApp,
} from "@/components/use-permissions";
import {
  allGrants,
  describeModes,
  type CategoryAccess,
} from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function ConnectedAppPage() {
  // useSearchParams requires a Suspense boundary in a prerendered page.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <ConnectedAppDetail />
    </Suspense>
  );
}

function ConnectedAppDetail() {
  // `?id=` is the app's agent id URL (URLSearchParams decodes it). A missing
  // id falls through to the "no access" empty state below.
  const agentId = useSearchParams().get("id") ?? "";
  const { app, ctx, loading, error, reload } = useConnectedApp(agentId);
  const router = useRouter();

  // Optimistic per-category removals (rolled back on failure).
  const [removedCategories, setRemovedCategories] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const categories = (app?.categories ?? []).filter(
    (c) => !removedCategories.has(c.category.id),
  );

  async function revokeCategory(access: CategoryAccess) {
    if (!app) return;
    const categoryId = access.category.id;
    const label = access.category.label.toLowerCase();
    setRemovedCategories((r) => new Set(r).add(categoryId));
    try {
      await permissionsBackend.revokeGrants(app.agentId, access.grants);
      toast.success(
        `${app.name} can no longer ${describeModes(access.modes)} your ${label}.`,
        {
          description: "You can grant access again anytime.",
          action: ctx
            ? {
                label: "Undo",
                onClick: () => {
                  permissionsBackend
                    .grant(ctx, app.agentId, categoryId, access.modes)
                    .then(() => {
                      // Un-hide the optimistically removed row before reloading.
                      setRemovedCategories((r) => {
                        const next = new Set(r);
                        next.delete(categoryId);
                        return next;
                      });
                      toast.success(`${app.name} can access your ${label} again.`);
                      reload();
                    })
                    .catch(() => {
                      toast.error(`Couldn't restore access to your ${label}.`);
                    });
                },
              }
            : undefined,
        },
      );
      reload();
    } catch {
      setRemovedCategories((r) => {
        const next = new Set(r);
        next.delete(categoryId);
        return next;
      });
      toast.error(`Couldn't revoke access to your ${label}.`, {
        description: "Nothing was changed. Check your connection and try again.",
      });
    }
  }

  async function removeAllAccess() {
    if (!app) return;
    setBusy(true);
    try {
      await permissionsBackend.revokeGrants(app.agentId, allGrants(app));
      toast.success(`${app.name} can no longer access anything in your pod.`, {
        description: "You can grant access again anytime.",
      });
      router.push("/connected-apps");
    } catch {
      toast.error(`Couldn't remove ${app.name}'s access.`, {
        description: "Nothing was changed. Check your connection and try again.",
      });
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <ol className="flex items-center gap-1">
          <li>
            <Link
              href="/connected-apps"
              className="hover:text-foreground hover:underline"
            >
              Connected apps
            </Link>
          </li>
          <ChevronRight className="size-4" aria-hidden="true" />
          <li aria-current="page" className="truncate font-medium text-foreground">
            {app?.name ?? "App"}
          </li>
        </ol>
      </nav>

      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading app access">
          <Skeleton className="h-16 w-72 rounded-xl" />
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-2xl" />
          ))}
        </div>
      ) : !app || categories.length === 0 ? (
        <EmptyState
          icon={AppWindow}
          title="This app has no access"
          description="It can't see or change anything in your pod. If you expected it here, it may have been revoked already."
          action={
            <Button variant="outline" asChild>
              <Link href="/connected-apps">Back to Connected apps</Link>
            </Button>
          }
        />
      ) : (
        <>
          <header>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
                {app.name}
              </h1>
              <AppHomepageLink app={app} />
            </div>
            <p className="measure mt-1 text-muted-foreground text-pretty">
              Everything {app.name} can currently reach in your pod, category by
              category. Revoking takes effect immediately.
            </p>
          </header>

          <section aria-label="Access by category">
            <ul className="flex flex-col gap-3">
              {categories.map((access) => {
                const Icon = categoryIcon(access.category.icon);
                return (
                  <li
                    key={access.category.id}
                    className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <span
                        aria-hidden="true"
                        className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"
                      >
                        <Icon className="size-5" />
                      </span>
                      <div className="min-w-0">
                        <p className="font-medium">{access.category.label}</p>
                        <p className="text-sm text-muted-foreground text-pretty">
                          {app.name} can {describeModes(access.modes)} your{" "}
                          {access.category.label.toLowerCase()}.
                        </p>
                        <div className="mt-2">
                          <ModeBadges modes={access.modes} />
                        </div>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => revokeCategory(access)}
                    >
                      Revoke
                      <span className="sr-only">
                        {" "}
                        {app.name}&apos;s access to {access.category.label}
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>

          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="text-base">Remove all access</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground text-pretty">
                {app.name} will no longer be able to see or change anything in
                your pod. Your data stays exactly where it is.
              </p>
              <Button variant="destructive" disabled={busy} onClick={removeAllAccess}>
                Remove all access
              </Button>
            </CardContent>
          </Card>

          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <ShieldCheck className="size-4 shrink-0 text-primary" aria-hidden="true" />
            You can grant access again anytime from the consent screen or here.
          </p>
        </>
      )}
    </div>
  );
}
