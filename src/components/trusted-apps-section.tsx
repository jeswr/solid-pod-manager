// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Trusted applications — the origin-reconciliation lens on Connected apps
 * (feature-completeness plan Wave 3, Cluster B). Lists the web *origins*
 * (`acl:origin`) that actually hold access in the pod's live ACLs, so the user
 * can reconcile what's really granted against what they expect, and revoke any
 * origin in one click through the SAME `PermissionsBackend.revokeGrants` path
 * the by-app list uses (no new write code). The ACLs are the ground truth.
 */
import { useEffect, useState } from "react";
import { Globe, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  permissionsBackend,
  type ConnectedApp,
  type ConnectedAppsModel,
} from "@/components/use-permissions";
import { reconcileTrustedApps, originLabel } from "@/lib/trusted-apps";

export function TrustedAppsSection({
  apps,
  parentRemoved,
  reload,
  getFreshModel,
}: {
  /** The STABLE apps snapshot from the data source (not a per-render filter). */
  apps: ConnectedApp[];
  /** Apps optimistically revoked by the parent's "Revoke all" — also hidden. */
  parentRemoved: ReadonlySet<string>;
  reload: () => void;
  /**
   * Re-discover the Connected-apps model FRESH (uncached). Revokes source their
   * grants from here, never the cached `apps` prop, so an origin's access is
   * removed against current ACL state.
   */
  getFreshModel: () => Promise<ConnectedAppsModel>;
}) {
  const origins = reconcileTrustedApps(apps);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  // Clear the optimistic-hide set on EVERY confirmed data snapshot (identity of
  // the stable `apps` reference, which changes only when the source actually
  // reloads — never on an incidental parent re-render). This both avoids a
  // flicker where a just-removed origin reappears from a stale array, and never
  // leaves a row hidden when a reload returns the same origin set (a re-grant or
  // remaining grants) — the live ACLs are always ground truth (roborev).
  useEffect(() => {
    setRemoved(new Set());
  }, [apps]);

  const visible = origins.filter(
    (o) => !removed.has(o.origin) && !parentRemoved.has(o.origin),
  );
  if (origins.length === 0) return null;

  async function revoke(origin: (typeof origins)[number]) {
    setBusy((b) => new Set(b).add(origin.origin));
    setRemoved((r) => new Set(r).add(origin.origin));
    try {
      // SECURITY: revoke against FRESH ACL state, never the cached `apps` snapshot
      // this row was rendered from — re-discover the live model and take this
      // origin's CURRENT grants. The origin IS the agentId for an `acl:origin`
      // subject; the backend write is atomic per ACL doc and fail-closed.
      const fresh = await getFreshModel();
      const freshOrigin = reconcileTrustedApps(fresh.apps).find(
        (o) => o.origin === origin.origin,
      );
      await permissionsBackend.revokeGrants(origin.origin, freshOrigin?.grants ?? []);
      toast.success(`${originLabel(origin.origin)} can no longer access your data.`);
      reload();
    } catch {
      // revokeGrants writes each affected ACL document in turn, so a late
      // failure can leave EARLIER documents already changed — we can't claim
      // "nothing changed". Un-hide the row and re-read the live model so the UI
      // shows the true post-failure state rather than guessing (roborev).
      setRemoved((r) => {
        const next = new Set(r);
        next.delete(origin.origin);
        return next;
      });
      toast.error(`Couldn't fully remove ${originLabel(origin.origin)}.`, {
        description:
          "Some access may have been removed. We've refreshed the list to show what's left — try again if needed.",
      });
      reload();
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(origin.origin);
        return next;
      });
    }
  }

  return (
    <>
      <Separator />
      <section className="flex flex-col gap-3" aria-labelledby="trusted-apps-heading">
        <div>
        <h2 id="trusted-apps-heading" className="text-lg font-semibold tracking-tight">
          Trusted browser apps
        </h2>
        <p className="measure mt-1 text-sm text-muted-foreground text-pretty">
          Web apps trusted by their address (origin) to act in your pod. This is
          what your access-control rules actually allow — reconcile it with what
          you expect, and remove anything you don&apos;t recognise.
        </p>
      </div>
      {visible.length === 0 ? (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <ShieldCheck className="size-4 shrink-0 text-primary" aria-hidden="true" />
          No browser-app origins have access right now.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map((o) => (
            <li
              key={o.origin}
              className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-medium">
                  <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate" title={o.origin}>
                    {originLabel(o.origin)}
                  </span>
                  {o.wholePod ? <Badge variant="destructive">All data</Badge> : null}
                </p>
                <p className="mt-1 text-sm text-muted-foreground text-pretty">
                  {o.wholePod
                    ? "Can reach everything in your pod."
                    : `Can reach your ${o.categoryLabels.join(", ").toLowerCase() || "data"}.`}
                </p>
              </div>
              <Button
                variant="outline"
                className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={busy.has(o.origin)}
                onClick={() => revoke(o)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      </section>
    </>
  );
}
