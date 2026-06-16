// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Federations — a READ-ONLY discovery view of the registry-asserted memberships
 * in the configured federation Catalogue/Registry (pss task #90), via
 * `@jeswr/federation-client`'s `discoverFromRegistry`.
 *
 * Each row lists a member app (friendly name derived from its `client_id` IRI),
 * its lifecycle `status` (Active emphasised), and the `assertedBy` authority in
 * muted text with an HONEST tooltip: the registry ASSERTS this membership and
 * the SDK checks it is WELL-FORMED — it does NOT verify the signature binding
 * the assertion to that authority. So this view makes NO cryptographic-trust
 * claim.
 *
 * Failure modes (honest, distinct):
 *   - DOCUMENT-level `valid === false` (the registry could not be fetched /
 *     parsed / is not a single registry) → an {@link ErrorState} with reload,
 *     NOT an empty state — an unfetchable registry must never look like "no
 *     members".
 *   - valid but ZERO members → {@link EmptyState}.
 *   - per-member `valid === false` → a small "couldn't verify this listing" note
 *     (from the member's `issues`); the row still renders what is known.
 *
 * Instant-nav SWR: returning here paints the last result immediately and
 * revalidates in the background.
 *
 * TRUST BOUNDARY (load-bearing): registry membership is DISPLAY-ONLY. Nothing on
 * this page feeds the federation TASK trust model (`federation-tasks.ts`) — the
 * `/assigned` view is unchanged. Signature-verified trust is a later
 * `@jeswr/federation-trust` phase.
 */
import { useMemo } from "react";
import { Network, RefreshCw, ShieldQuestion } from "lucide-react";
import { useFederationMembers } from "@/components/use-federation-registry";
import type { DiscoveredMember } from "@/lib/federation-registry";
import {
  assertedByLabel,
  memberDisplayName,
  registryError,
  statusBadgeVariant,
  statusLabel,
} from "@/lib/federation-members";
import { EmptyState, ErrorState } from "@/components/states";
import { ItemRowSkeleton } from "@/components/item-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { safeLinkHref } from "@/lib/pod-scope";

export default function FederationsPage() {
  const { data, loading, error, revalidating, reload, enabled } = useFederationMembers();

  const members = useMemo(() => data?.members ?? [], [data]);
  // DOCUMENT-level validity: a fetch/parse/no-registry failure (valid:false)
  // must surface as an error, not an empty list. A document-level failure with
  // no thrown error still means "we could not read the registry".
  const documentInvalid = data !== undefined && data.valid === false;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"
          >
            <Network className="size-6" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Federations</h1>
            <p className="measure mt-1 text-sm text-muted-foreground text-pretty">
              Apps a federation registry lists as members. This is a read-only directory — the
              registry vouches for each listing; we check it is well-formed, not that its signature
              is genuine.
            </p>
          </div>
        </div>
        {enabled ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={reload}
            disabled={loading}
            aria-label="Refresh the federation directory"
          >
            <RefreshCw aria-hidden="true" className={revalidating ? "animate-spin" : undefined} />
          </Button>
        ) : null}
      </header>

      {!enabled ? (
        // The feature ships dark; with no registry configured the nav entry is
        // hidden too, but if a user reaches the route directly, say so plainly.
        <EmptyState
          icon={Network}
          title="Federation directory not configured"
          description="No federation registry has been set up for this Pod Manager, so there is nothing to show here yet."
        />
      ) : loading ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <ItemRowSkeleton />
          <ItemRowSkeleton />
          <ItemRowSkeleton />
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : documentInvalid ? (
        // Document-level invalid (couldn't fetch/parse the registry). Build an
        // honest Error from the registry's own issues so the user sees WHY.
        <ErrorState error={registryError(data?.issues)} onRetry={reload} />
      ) : members.length === 0 ? (
        <EmptyState
          icon={Network}
          title="No member apps listed"
          description="The federation registry is reachable but does not list any member apps right now."
        />
      ) : (
        <TooltipProvider>
          <ul className="flex flex-col gap-2">
            {members.map((member) => (
              <MemberRow key={member.id || member.source} member={member} />
            ))}
          </ul>
        </TooltipProvider>
      )}
    </div>
  );
}

function MemberRow({ member }: { member: DiscoveredMember }) {
  const name = memberDisplayName(member.id);
  const href = safeLinkHref(member.id);
  const variant = statusBadgeVariant(member.status);
  const authority = assertedByLabel(member.membership.assertedBy);

  return (
    <li className="rounded-2xl border border-border bg-card px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={variant} className="shrink-0">
              {statusLabel(member.status)}
            </Badge>
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="truncate font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                {name}
                <span className="sr-only"> (opens the app&rsquo;s identifier in a new tab)</span>
              </a>
            ) : (
              <span className="truncate font-medium">{name}</span>
            )}
          </div>

          <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Listed by {authority}</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="What does “listed by” mean?"
                  className="inline-flex items-center rounded focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <ShieldQuestion className="size-3.5" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                The registry asserts this membership; we check the listing is well-formed, but the
                signature is not verified.
              </TooltipContent>
            </Tooltip>
          </div>

          {member.valid === false ? (
            <p className="mt-1 text-xs text-destructive">
              We couldn&rsquo;t verify this listing, so treat it with caution.
            </p>
          ) : null}
        </div>
      </div>
    </li>
  );
}
