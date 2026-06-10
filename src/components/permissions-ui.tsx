"use client";

/**
 * Small shared pieces for the Connected-apps surfaces: plain-language mode
 * badges and category phrasing (DESIGN.md §6 — no jargon, ever).
 */
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { safeLinkHref } from "@/lib/pod-scope";
import type { AccessMode } from "@/lib/permissions";
import type { ConnectedApp } from "@/components/use-permissions";

/** Plain-language label per WAC mode — "ACL" never reaches the UI. */
export const MODE_LABEL: Record<AccessMode, string> = {
  read: "Can view",
  append: "Can add",
  write: "Can edit",
  control: "Can manage sharing",
};

/** Badges for a set of modes, in canonical order. */
export function ModeBadges({ modes }: { modes: AccessMode[] }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {modes.map((mode) => (
        <Badge key={mode} variant={mode === "control" ? "destructive" : "secondary"}>
          {MODE_LABEL[mode]}
        </Badge>
      ))}
    </span>
  );
}

/** "Health, Finance and 2 more" — the categories an app can touch. */
export function categoriesPhrase(app: ConnectedApp): string {
  const labels = app.categories.map((c) => c.category.label);
  if (labels.length === 0) return "nothing";
  if (labels.length <= 3) {
    return labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  }
  return `${labels.slice(0, 2).join(", ")} and ${labels.length - 2} more`;
}

/** A native external link to the app's homepage (never a logo). */
export function AppHomepageLink({ app }: { app: ConnectedApp }) {
  if (!app.homepage) return null;
  // The homepage comes from an untrusted source (the app's Client ID Document /
  // the agent's foaf:homepage). An empty-host check is NOT enough — it lets
  // `javascript://%0aalert(1)//x` through (host = "%0aalert(1)"). Gate on the
  // scheme allowlist (http/https/mailto) via safeLinkHref, the same control
  // resource-viewer.tsx uses for pod IRIs. Render inert text if it's unsafe.
  const safeHref = safeLinkHref(app.homepage);
  let host: string;
  try {
    host = new URL(app.homepage).host;
  } catch {
    return null;
  }
  if (!safeHref || !host) {
    return <span className="text-sm text-muted-foreground">{host || "homepage"}</span>;
  }
  return (
    <a
      href={safeHref}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {host}
      <ExternalLink className="size-3.5" aria-hidden="true" />
      <span className="sr-only">(opens {host} in a new tab)</span>
    </a>
  );
}
