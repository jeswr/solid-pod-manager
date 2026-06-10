"use client";

import Link from "next/link";
import {
  AppWindow,
  ArrowRight,
  Database,
  FolderOpen,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { useSession } from "@/components/session-provider";
import { useCategorySummaries } from "@/components/use-pod-data";
import { useConnectedApps } from "@/components/use-permissions";
import { categoriesWithDataCount } from "@/lib/pod-data";
import { categoryIcon } from "@/components/category-icon";
import { ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function HomePage() {
  const { profile } = useSession();
  const { data: summaries, loading, error } = useCategorySummaries();
  const apps = useConnectedApps();

  const firstName = profile?.displayName?.split(/\s+/)[0];
  const withData = summaries ? categoriesWithDataCount(summaries) : undefined;
  const topCategories = (summaries ?? []).filter((s) => s.hasData).slice(0, 4);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          {firstName ? `Welcome back, ${firstName}` : "Welcome back"}
        </h1>
        <p className="mt-1 text-muted-foreground text-pretty">
          Here&apos;s an overview of your pod and who can see it.
        </p>
      </header>

      {/* Headline stats — the top of the inverted pyramid (R7). */}
      <section aria-label="Overview" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          icon={AppWindow}
          label="Apps with access"
          value={apps.error ? "—" : apps.loading ? undefined : String(apps.data?.length ?? 0)}
          hint="Every grant is yours to review and revoke in Connected apps."
          tone="primary"
          href="/connected-apps"
        />
        <StatCard
          icon={Database}
          label="Categories with data"
          value={loading ? undefined : (withData ?? 0).toString()}
          hint="Across your pod, in plain categories."
          href="/my-data"
        />
        <StatCard
          icon={ShieldCheck}
          label="Who can read your data"
          value={
            apps.error
              ? "—"
              : apps.loading
                ? undefined
                : apps.data?.length
                  ? `You + ${apps.data.length} app${apps.data.length === 1 ? "" : "s"}`
                  : "Only you"
          }
          hint="Apps can only read what you've granted — change that anytime."
          tone="success"
          href="/connected-apps"
        />
      </section>

      {/* Quick actions */}
      <section aria-label="Quick actions" className="flex flex-wrap gap-3">
        <Button asChild>
          <Link href="/my-data">
            <FolderOpen className="size-4" aria-hidden="true" />
            Browse my data
          </Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/connected-apps">
            <AppWindow className="size-4" aria-hidden="true" />
            Review apps
          </Link>
        </Button>
      </section>

      {/* Categories with data — one drill-down to anything (R7). */}
      <section aria-label="Your data" className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Your data</h2>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/my-data">
              See all
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </Button>
        </div>

        {error ? (
          <ErrorState error={error} />
        ) : loading ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-2xl" />
            ))}
          </div>
        ) : topCategories.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-start gap-3 py-6">
              <p className="text-sm text-muted-foreground">
                No data categories found in your pod yet. As apps store data, it
                will show up here, neatly organised.
              </p>
              <Button variant="outline" size="sm" asChild>
                <Link href="/my-data">
                  <Plus className="size-4" aria-hidden="true" />
                  Explore categories
                </Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2">
            {topCategories.map((s) => {
              const Icon = categoryIcon(s.category.icon);
              return (
                <li key={s.category.id}>
                  <Link
                    href={`/my-data/${s.category.id}`}
                    className="group flex h-full items-center gap-4 rounded-2xl border border-border bg-card p-4 transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <span
                      aria-hidden="true"
                      className="grid size-11 place-items-center rounded-xl bg-accent text-accent-foreground"
                    >
                      <Icon className="size-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{s.category.label}</span>
                      <span className="block truncate text-sm text-muted-foreground">
                        {s.locations.length}{" "}
                        {s.locations.length === 1 ? "location" : "locations"}
                      </span>
                    </span>
                    <ArrowRight
                      className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                      aria-hidden="true"
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Recent activity strip — stubbed for P3. */}
      <section aria-label="Recent activity" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Recent activity</h2>
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium text-muted-foreground">
              Activity log coming soon
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            You&apos;ll see a plain-language record here of which app read or wrote
            which data, and when.
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  href,
  tone = "default",
}: {
  icon: typeof Database;
  label: string;
  value?: string;
  hint: string;
  href?: string;
  tone?: "default" | "primary" | "success";
}) {
  const toneClass =
    tone === "primary"
      ? "text-primary"
      : tone === "success"
        ? "text-success"
        : "text-foreground";

  const body = (
    <Card className="h-full transition-colors hover:bg-accent/30">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {label}
        </CardTitle>
        <Icon className={`size-5 ${toneClass}`} aria-hidden="true" />
      </CardHeader>
      <CardContent>
        {value === undefined ? (
          <Skeleton className="h-9 w-16" />
        ) : (
          <p className={`text-3xl font-semibold tabular ${toneClass}`}>{value}</p>
        )}
        <p className="mt-1 text-xs text-muted-foreground text-pretty">{hint}</p>
      </CardContent>
    </Card>
  );

  if (href) {
    return (
      <Link
        href={href}
        className="rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {body}
      </Link>
    );
  }
  return body;
}
