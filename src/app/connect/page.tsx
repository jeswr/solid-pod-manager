"use client";

/**
 * Connect sources — the full 30-app catalog (docs/integrations-catalog.md),
 * every entry visible with a tier-honest status chip. Tier A connects (live)
 * or demos today; Tier B is approval-gated; Tier C waits on export-file
 * import. No consent walls, no fake-live anything.
 */
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { integrationIcon } from "@/components/integration-icon";
import { StatusChip } from "@/components/integration-status";
import { categoryById } from "@/lib/categories";
import {
  allCatalogEntries,
  statusOf,
  type CatalogEntry,
} from "@/lib/integrations/registry";

export default function ConnectPage() {
  const entries = allCatalogEntries();
  const tierA = entries.filter((e) => e.tier === "A");
  const tierB = entries.filter((e) => e.tier === "B");
  const tierC = entries.filter((e) => e.tier === "C");

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Connect sources</h1>
        <p className="measure mt-1 text-muted-foreground text-pretty">
          Pull copies of your data out of the services you use and into your
          pod — where you decide who sees it. Connections labelled
          &ldquo;Demo&rdquo; import sample data until this app is registered
          with that platform.
        </p>
      </header>

      <CatalogSection
        title="Connect now"
        description="Sign in with the service and import — or try the demo."
        entries={tierA}
      />
      <CatalogSection
        title="Coming soon"
        description="These platforms require an app-approval process before anyone can connect. We say so rather than pretend."
        entries={tierB}
      />
      <CatalogSection
        title="From an export file"
        description="No user API exists — but every one of these offers an official data export, and importing those files is on the roadmap."
        entries={tierC}
      />
    </div>
  );
}

function CatalogSection({
  title,
  description,
  entries,
}: {
  title: string;
  description: string;
  entries: CatalogEntry[];
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      </div>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((entry) => (
          <li key={entry.id}>
            <IntegrationCard entry={entry} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function IntegrationCard({ entry }: { entry: CatalogEntry }) {
  const Icon = integrationIcon(entry);
  const status = statusOf(entry);
  const categories = entry.categories
    .map((id) => categoryById(id)?.label)
    .filter(Boolean)
    .join(", ");

  return (
    <Link
      href={`/connect/${entry.id}`}
      className="group flex h-full flex-col gap-3 rounded-2xl border border-border bg-card p-5 transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <div className="flex items-start justify-between gap-2">
        <span
          aria-hidden="true"
          className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"
        >
          <Icon className="size-5" />
        </span>
        <StatusChip status={status} />
      </div>
      <div>
        <h3 className="flex items-center gap-1 font-medium">
          {entry.name}
          <ArrowRight
            className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
            aria-hidden="true"
          />
        </h3>
        <p className="mt-0.5 text-sm text-muted-foreground text-pretty">{entry.whatYouGet}</p>
        <p className="mt-2 text-xs text-muted-foreground">Goes into: {categories}</p>
      </div>
    </Link>
  );
}
