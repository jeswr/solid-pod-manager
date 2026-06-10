"use client";

/**
 * Per-app connect flow (DESIGN.md §4.5, benefit-framed and dark-pattern-free):
 * what you get + which categories, then — for Tier A — the OAuth popup (live)
 * or a clearly-labelled demo import. Progress is announced via a live region;
 * success points at the categories now populated. Tier B/C explain their
 * status honestly instead of pretending.
 */
import { use } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  CheckCircle2,
  ChevronRight,
  Clock,
  Download,
  FileUp,
  Loader2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { categoryIcon } from "@/components/category-icon";
import { integrationIcon } from "@/components/integration-icon";
import { StatusChip } from "@/components/integration-status";
import { EmptyState, ErrorState } from "@/components/states";
import { TierCImport } from "@/components/tier-c-import";
import { useConnect } from "@/components/use-connect";
import { fileAdapterById } from "@/lib/integrations/file-adapters";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { categoryById } from "@/lib/categories";
import type { ImportReport } from "@/lib/integrations/core/import-runner";
import {
  adapterById,
  allCatalogEntries,
  statusOf,
  type CatalogEntry,
} from "@/lib/integrations/registry";

export default function ConnectAppPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const entry = allCatalogEntries().find((e) => e.id === id);
  if (!entry) notFound();

  const Icon = integrationIcon(entry);
  const status = statusOf(entry);

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <ol className="flex items-center gap-1">
          <li>
            <Link href="/connect" className="hover:text-foreground hover:underline">
              Connect sources
            </Link>
          </li>
          <ChevronRight className="size-4" aria-hidden="true" />
          <li aria-current="page" className="font-medium text-foreground">
            {entry.name}
          </li>
        </ol>
      </nav>

      <header className="flex items-start gap-4">
        <span
          aria-hidden="true"
          className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"
        >
          <Icon className="size-6" />
        </span>
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
            {entry.name}
            <StatusChip status={status} />
          </h1>
          <p className="mt-1 text-muted-foreground text-pretty">{entry.whatYouGet}</p>
        </div>
      </header>

      <CategoryList entry={entry} />

      {entry.tier === "A" ? (
        <TierAFlow entry={entry} />
      ) : entry.tier === "B" ? (
        <EmptyState
          icon={Clock}
          title="Coming soon — needs platform approval"
          description={`${entry.blocker ?? "This platform reviews apps before users may connect."} We'll enable this the moment approval lands; nothing about your pod changes in the meantime.`}
        />
      ) : (
        <TierCFlow entry={entry} />
      )}
    </div>
  );
}

/** Tier C: import the platform's official export file into the pod. */
function TierCFlow({ entry }: { entry: CatalogEntry }) {
  const adapter = fileAdapterById(entry.id);
  if (!adapter) {
    return (
      <EmptyState
        icon={FileUp}
        title="Import from an export file"
        description={`${entry.name} has no user-level API, but you can request your data as ${entry.exportFormat ?? "an official export"}. File import for this source is coming soon.`}
      />
    );
  }
  return <TierCImport entry={entry} adapter={adapter} />;
}

function CategoryList({ entry }: { entry: CatalogEntry }) {
  return (
    <section aria-label="What you get" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Goes into
      </h2>
      <ul className="flex flex-wrap gap-2">
        {entry.categories.map((id) => {
          const category = categoryById(id);
          if (!category) return null;
          const Icon = categoryIcon(category.icon);
          return (
            <li key={id}>
              <Link
                href={`/my-data/${id}`}
                className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                {category.label}
              </Link>
            </li>
          );
        })}
      </ul>
      <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
        <ShieldCheck className="size-4 shrink-0 text-primary" aria-hidden="true" />
        Imported data lands in your pod. Only apps you approve can read it, and
        you can delete it any time.
      </p>
    </section>
  );
}

function TierAFlow({ entry }: { entry: CatalogEntry }) {
  const adapter = adapterById(entry.id);
  const { state, start, reset, live } = useConnect(adapter);

  const busy = state.phase === "authorizing" || state.phase === "importing";

  return (
    <section aria-label="Import" className="flex flex-col gap-4">
      {!live && state.phase !== "done" ? (
        <Alert>
          <Sparkles className="size-4" aria-hidden="true" />
          <AlertTitle>Demo mode</AlertTitle>
          <AlertDescription>
            This connection isn&apos;t registered with {entry.name} yet, so the
            import below writes clearly-labelled <strong>sample data</strong>{" "}
            into your pod — the full experience, honestly staged. To go live,
            the app&apos;s maintainer needs to:
            <ul className="mt-2 list-disc pl-5">
              {entry.requirements.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Progress + outcome are announced to screen readers as they change. */}
      <div aria-live="polite" className="flex flex-col gap-4">
        {state.phase === "authorizing" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Waiting for you to approve access in the {entry.name} window…
          </p>
        ) : null}

        {state.phase === "importing" ? (
          <ImportProgressBar
            label={state.progress?.label ?? "Importing…"}
            done={state.progress?.done ?? 0}
            total={state.progress?.total}
          />
        ) : null}

        {state.phase === "done" && state.report ? (
          <SuccessPanel entry={entry} report={state.report} demo={!live} />
        ) : null}

        {state.phase === "error" && state.error ? (
          <ErrorState error={state.error} onRetry={start} />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {state.phase === "done" ? (
          <Button variant="outline" onClick={reset}>
            Import again
          </Button>
        ) : (
          <Button onClick={start} disabled={busy}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="size-4" aria-hidden="true" />
            )}
            {live ? `Connect ${entry.name} & import` : "Import demo data"}
          </Button>
        )}
        {!live && state.phase !== "done" ? (
          <span className="text-xs text-muted-foreground">
            No {entry.name} account needed for the demo.
          </span>
        ) : null}
      </div>
    </section>
  );
}

function ImportProgressBar({
  label,
  done,
  total,
}: {
  label: string;
  done: number;
  total?: number;
}) {
  const pct = total && total > 0 ? Math.round((done / total) * 100) : undefined;
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {label}
      </p>
      <div
        role="progressbar"
        aria-label="Import progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-2 w-full max-w-md overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${pct ?? 33}%` }}
        />
      </div>
    </div>
  );
}

function SuccessPanel({
  entry,
  report,
  demo,
}: {
  entry: CatalogEntry;
  report: ImportReport;
  demo: boolean;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <h2 className="flex flex-wrap items-center gap-2 font-medium">
        <CheckCircle2 className="size-5 text-primary" aria-hidden="true" />
        {demo ? "Demo data imported" : `${entry.name} data imported`}
        {demo ? <Badge variant="secondary">Demo data</Badge> : null}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {report.written.length} {report.written.length === 1 ? "document" : "documents"} saved
        to your pod. Find {demo ? "the sample data" : "it"} under:
      </p>
      <ul className="mt-3 flex flex-wrap gap-2">
        {report.categories.map((id) => {
          const category = categoryById(id);
          if (!category) return null;
          const Icon = categoryIcon(category.icon);
          return (
            <li key={id}>
              <Link
                href={`/my-data/${id}`}
                className="flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-sm text-accent-foreground transition-colors hover:bg-accent/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <Icon className="size-4" aria-hidden="true" />
                {category.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
