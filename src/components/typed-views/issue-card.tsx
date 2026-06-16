// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Issues renderer (design: `docs/typed-data-views.md` §4): a list of issue cards
 * — a state badge + title + created time + assignee + a body preview — with **no
 * raw triples**. Consumes the pure `IssueModel` (read via the SHARED
 * `@jeswr/solid-task-model`); all RDF stayed in `lib/`.
 *
 * The assignee is a WebID; it is shown as a compact, friendly handle (the IRI's
 * host/last path segment) — NOT auto-linked (a WebID IRI is an identifier, not a
 * navigable page). The pure layer keeps dates as raw ISO strings; this card
 * formats them for the user's locale via `Intl`.
 */
import { CircleDot, GitPullRequestClosed, Loader, UserRound } from "lucide-react";
import type { IssueItem, IssueModel } from "@/lib/typed-views/issue-view";
import type { IssueState } from "@/lib/issues";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

/** The issue-card list for an issues resource. */
export function IssueCardList({ model }: { model: IssueModel; url: string }) {
  if (model.items.length === 0) {
    return <p className="text-sm text-muted-foreground">No issues found in this resource.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {model.items.map((issue) => (
        <IssueRow key={issue.id} issue={issue} />
      ))}
    </div>
  );
}

function IssueRow({ issue }: { issue: IssueItem }) {
  const created = formatDate(issue.created);
  const assignee = friendlyWebId(issue.assignee);

  return (
    <Card>
      <CardContent className="flex items-start gap-4 py-4">
        <StateIcon state={issue.state} />

        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium leading-tight">{issue.title}</span>
            <Badge variant={badgeVariant(issue.state)}>{stateLabel(issue.state)}</Badge>
          </div>
          {issue.description && (
            <p className="mt-0.5 line-clamp-3 text-sm text-muted-foreground">
              {issue.description}
            </p>
          )}

          <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            {created && <span>Opened {created}</span>}
            {assignee && (
              <span className="inline-flex items-center gap-1">
                <UserRound className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate" title={issue.assignee}>
                  {assignee}
                </span>
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function StateIcon({ state }: { state: IssueState }) {
  const className = "flex size-12 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground";
  if (state === "closed") {
    return (
      <div className={className}>
        <GitPullRequestClosed className="size-5" aria-hidden="true" />
      </div>
    );
  }
  if (state === "in-progress") {
    return (
      <div className={className}>
        <Loader className="size-5" aria-hidden="true" />
      </div>
    );
  }
  return (
    <div className={className}>
      <CircleDot className="size-5" aria-hidden="true" />
    </div>
  );
}

/** Human label for an issue state. */
function stateLabel(state: IssueState): string {
  switch (state) {
    case "closed":
      return "Closed";
    case "in-progress":
      return "In progress";
    default:
      return "Open";
  }
}

/** Badge variant per state (closed = muted, in-progress = highlight, open = default). */
function badgeVariant(state: IssueState): "default" | "secondary" | "outline" {
  switch (state) {
    case "closed":
      return "outline";
    case "in-progress":
      return "secondary";
    default:
      return "default";
  }
}

/**
 * A friendly, compact handle for a WebID IRI: the last non-empty path segment
 * (often the username), else the host. Returns undefined for a non-IRI/absent
 * value. Display-only — never used as an href.
 */
function friendlyWebId(webId: string | undefined): string | undefined {
  if (!webId) return undefined;
  try {
    const u = new URL(webId);
    const segments = u.pathname.split("/").filter(Boolean);
    const last = segments.at(-1);
    return last && last !== "card" ? last : u.host;
  } catch {
    return webId;
  }
}

/** Locale-friendly date, e.g. "11 Jun 2026". Tolerates bad/absent input. */
function formatDate(iso?: string): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(t));
}
