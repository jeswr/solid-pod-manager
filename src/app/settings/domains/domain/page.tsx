"use client";

/**
 * Domain detail — the DNS setup screen and the binding's home page
 * (BYOD Phase 1: claimed → verified → live, docs/design/byod.md §5).
 * While pending it shows the exact records to create (copy buttons on every
 * field), a "Check now" button driving POST verify, and polls politely while
 * on-screen. Addressed as `?name=<domain>` — a query parameter so the page
 * prerenders under `output: "export"` (domains are unknowable at build time).
 *
 * Purchased bindings (Phase 3) take a different path while still `claimed`:
 * pending approval → registering (progress strip; each poll advances the
 * server's registration) → registered → the same verified/live finish — and
 * NEVER show DNS instructions: the server registers the domain and authors
 * the zone itself.
 */
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowUpRight,
  Globe,
  Hourglass,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { CheckStatusLine, DnsRecordRow, DomainBindingBadge, DomainsErrorState } from "@/components/domains-ui";
import { EmptyState } from "@/components/states";
import { useDomain } from "@/components/use-domains";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  bindingBadge,
  DomainNotFoundError,
  DomainsError,
  formatUsd,
  isPollableState,
  needsManualDns,
  releaseDomain,
  routingInstructions,
  txtInstruction,
  type DomainBinding,
  type PurchaseStatus,
} from "@/lib/domains";

export default function DomainDetailPage() {
  // useSearchParams requires a Suspense boundary in a prerendered page.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <DomainDetail />
    </Suspense>
  );
}

function DomainDetail() {
  const name = useSearchParams().get("name") ?? undefined;
  const { data: binding, base, loading, error, checking, checkNow, reload } = useDomain(name);
  const router = useRouter();
  const [releasing, setReleasing] = useState(false);

  async function runCheck() {
    try {
      const updated = await checkNow();
      if (!updated) return;
      if (updated.state === "live") {
        toast.success(`${updated.domain} is live!`, {
          description: "The first visit may take a few seconds while the certificate is issued.",
        });
      }
    } catch (e: unknown) {
      // Honest server copy (expired challenge, conflicting live domain, …).
      toast.error(e instanceof DomainsError ? e.message : "The check failed. Try again.");
      reload();
    }
  }

  async function release(
    done: { title: string; description: string } = {
      title: binding ? `${binding.domain} was disconnected.` : "Disconnected.",
      description: "Your pod and its data are untouched.",
    },
  ) {
    if (!base || !binding) return;
    setReleasing(true);
    try {
      await releaseDomain(base, binding.domain);
      toast.success(done.title, { description: done.description });
      router.push("/settings/domains");
    } catch (e: unknown) {
      toast.error(
        e instanceof DomainsError ? e.message : "Couldn't disconnect the domain. Try again.",
      );
      setReleasing(false);
    }
  }

  /** Cancelling a not-yet-approved purchase is a release with honest copy. */
  function cancelPurchase() {
    void release({
      title: binding ? `The purchase of ${binding.domain} was cancelled.` : "Purchase cancelled.",
      description: "Nothing was charged.",
    });
  }

  // The purchase phase rules the screen while a purchased binding is still
  // `claimed`; from `verified` onward it converges with the normal flow.
  const purchasePhase: PurchaseStatus | undefined =
    binding?.purchase !== undefined && binding.state === "claimed"
      ? binding.purchase.status
      : undefined;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          href="/settings/domains"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Domains
        </Link>
        {binding ? (
          <>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h1 className="break-all text-2xl font-semibold tracking-tight md:text-3xl">
                {binding.domain}
              </h1>
              <DomainBindingBadge binding={binding} />
            </div>
            <p className="measure mt-1 text-muted-foreground text-pretty">
              {bindingBadge(binding).description}
            </p>
          </>
        ) : (
          <h1 className="mt-2 text-2xl font-semibold tracking-tight md:text-3xl">Domain</h1>
        )}
      </header>

      {!name ? (
        <EmptyState
          icon={Globe}
          title="No domain selected"
          description="Pick a domain from the list to see its setup and status."
          action={
            <Button asChild variant="outline">
              <Link href="/settings/domains">Back to domains</Link>
            </Button>
          }
        />
      ) : error ? (
        error instanceof DomainNotFoundError ? (
          <EmptyState
            icon={Globe}
            title="We couldn't find that domain"
            description="It isn't connected to your account — it may have been disconnected, or the link is stale."
            action={
              <Button asChild variant="outline">
                <Link href="/settings/domains">Back to domains</Link>
              </Button>
            }
          />
        ) : (
          <DomainsErrorState error={error} onRetry={reload} />
        )
      ) : loading || !binding ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading domain">
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-40 rounded-2xl" />
        </div>
      ) : (
        <>
          {binding.state === "live" ? <LiveCard binding={binding} /> : null}
          {binding.state === "suspended" ? <SuspendedNotice /> : null}

          {/* Purchase phases (the binding stays `claimed` until registered). */}
          {purchasePhase === "pending-approval" ? (
            <PendingApprovalCard
              binding={binding}
              cancelling={releasing}
              onCancel={cancelPurchase}
            />
          ) : null}
          {purchasePhase === "registering" ? (
            <RegisteringCard binding={binding} checking={checking} onCheck={runCheck} />
          ) : null}
          {purchasePhase === "denied" || purchasePhase === "failed" ? (
            <PurchaseDeadEndCard
              binding={binding}
              releasing={releasing}
              onRelease={() => void release()}
            />
          ) : null}
          {purchasePhase === "registered" ? <AutoDnsNotice /> : null}

          {/* DNS instructions — never for purchased bindings (the server
              registers the domain and authors the zone itself). */}
          {binding.state === "claimed" && needsManualDns(binding) ? (
            <TxtChallengeCard binding={binding} />
          ) : null}
          {binding.state !== "live" && binding.state !== "released" && needsManualDns(binding) ? (
            <RoutingCard binding={binding} />
          ) : null}

          {binding.state !== "released" &&
          purchasePhase !== "pending-approval" &&
          purchasePhase !== "registering" &&
          purchasePhase !== "denied" &&
          purchasePhase !== "failed" ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Status</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <CheckStatusLine label="Ownership (TXT)" result={binding.checks?.txt} />
                <CheckStatusLine label="Routing" result={binding.checks?.routing} />
                {!binding.checks && binding.state !== "live" ? (
                  needsManualDns(binding) ? (
                    <p className="text-sm text-muted-foreground">
                      Once your DNS records are in place, run a check. DNS changes can take up
                      to 48 hours to propagate, so don&apos;t worry if it takes a few tries.
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Your provider set up the DNS automatically — this usually completes
                      within minutes.
                    </p>
                  )
                ) : null}
                {binding.state === "live" ? (
                  <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <ShieldCheck className="size-4 shrink-0 text-primary" aria-hidden="true" />
                    We re-check the routing daily and will pause the domain if it stops
                    pointing at your pod.
                  </p>
                ) : (
                  <div className="flex flex-wrap items-center gap-3">
                    <Button onClick={runCheck} disabled={checking}>
                      {checking ? (
                        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <RefreshCw className="size-4" aria-hidden="true" />
                      )}
                      {checking ? "Checking…" : "Check now"}
                    </Button>
                    {isPollableState(binding.state) ? (
                      <span className="text-sm text-muted-foreground">
                        We also check automatically every 30 seconds while you&apos;re on this
                        page.
                      </span>
                    ) : null}
                  </div>
                )}
              </CardContent>
            </Card>
          ) : null}

          {purchasePhase === undefined ? (
          <Card className="border-destructive/30">
            <CardHeader>
              <CardTitle className="text-base">Disconnect</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="measure text-sm text-muted-foreground text-pretty">
                Disconnecting stops this domain from serving your pod
                {binding.state === "live" ? " — links using it will stop working" : ""}. Your
                pod and everything in it stay exactly where they are.
                {binding.purchase
                  ? " The domain itself stays registered with your provider."
                  : ""}
              </p>
              <div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      disabled={releasing}
                    >
                      {releasing ? (
                        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                      ) : null}
                      Disconnect domain
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Disconnect {binding.domain}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        The domain stops serving your pod
                        {binding.state === "live"
                          ? " and links using it will stop working"
                          : ""}
                        . Your data is untouched, and you can connect the domain again later.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep it connected</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-white hover:bg-destructive/90"
                        onClick={() => void release()}
                      >
                        Disconnect
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </CardContent>
          </Card>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The success surface once the domain serves the pod. */
function LiveCard({ binding }: { binding: DomainBinding }) {
  const alias = binding.aliasUrl ?? `https://${binding.domain}/`;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your pod&apos;s new address</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <a
          href={alias}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit items-center gap-1 break-all font-mono text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {alias}
          <ArrowUpRight className="size-3.5 shrink-0" aria-hidden="true" />
        </a>
        <p className="measure text-sm text-muted-foreground text-pretty">
          Your old address redirects here, so existing links and apps keep working.{" "}
          {binding.purchase
            ? "Your provider manages the domain's DNS and renewal — there's nothing to set up at a registrar."
            : "The TXT ownership record is no longer needed — you can delete it at your registrar."}
        </p>
      </CardContent>
    </Card>
  );
}

/** Purchase: waiting for the operator to approve (nothing charged yet). */
function PendingApprovalCard({
  binding,
  cancelling,
  onCancel,
}: {
  binding: DomainBinding;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const price = binding.purchase?.priceUsd;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Hourglass className="size-4 text-muted-foreground" aria-hidden="true" />
          Waiting for approval
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="measure text-sm text-muted-foreground text-pretty">
          Your purchase request{price !== undefined ? ` (${formatUsd(price)} first year)` : ""} is
          with the server operator. Nothing is charged until they approve, and registration
          starts automatically the moment they do — we check for you every minute while
          you&apos;re on this page.
        </p>
        <div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={cancelling}
              >
                {cancelling ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : null}
                Cancel purchase
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Cancel the purchase of {binding.domain}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The request is withdrawn before anything is charged. You can request the same
                  domain again later.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep waiting</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-white hover:bg-destructive/90"
                  onClick={onCancel}
                >
                  Cancel purchase
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Purchase: the registrar is registering the domain. The progress strip shows
 * the server's own progress sentence; each check (manual or the ~60 s poll)
 * advances the registration server-side by one registrar poll.
 */
function RegisteringCard({
  binding,
  checking,
  onCheck,
}: {
  binding: DomainBinding;
  checking: boolean;
  onCheck: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Registering your domain</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div
          role="status"
          className="flex items-start gap-3 rounded-xl border border-sky-500/30 bg-sky-500/10 p-3"
        >
          <LoaderCircle
            className="mt-0.5 size-4 shrink-0 animate-spin text-sky-700 dark:text-sky-400"
            aria-hidden="true"
          />
          <p className="measure text-sm text-pretty">
            {binding.progress ?? "Registration submitted — waiting for the registry."}
          </p>
        </div>
        <p className="measure text-sm text-muted-foreground text-pretty">
          This usually takes a few minutes, though some domain endings take hours or longer.
          Once it completes, the DNS is set up automatically and the domain goes live by
          itself — registrations can&apos;t be cancelled mid-flight.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={onCheck} disabled={checking}>
            {checking ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="size-4" aria-hidden="true" />
            )}
            {checking ? "Checking…" : "Check now"}
          </Button>
          <span className="text-sm text-muted-foreground">
            We also check automatically every minute while you&apos;re on this page.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/** Brief notice while a freshly registered purchase converges to live. */
function AutoDnsNotice() {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-2xl border border-sky-500/30 bg-sky-500/10 p-4"
    >
      <ShieldCheck
        className="mt-0.5 size-4 shrink-0 text-sky-700 dark:text-sky-400"
        aria-hidden="true"
      />
      <p className="measure text-sm text-pretty">
        The domain is yours and its DNS was set up automatically. We&apos;re waiting for the
        records to be visible everywhere — no action needed.
      </p>
    </div>
  );
}

/** Purchase: an honest dead-end (denied or failed) with retry/release paths. */
function PurchaseDeadEndCard({
  binding,
  releasing,
  onRelease,
}: {
  binding: DomainBinding;
  releasing: boolean;
  onRelease: () => void;
}) {
  const purchase = binding.purchase;
  const failed = purchase?.status === "failed";
  return (
    <Card className="border-destructive/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TriangleAlert className="size-4 text-destructive" aria-hidden="true" />
          {failed ? "The registration failed" : "The purchase wasn't approved"}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="measure text-sm text-pretty">
          {purchase?.failureReason ??
            (failed
              ? "The registration didn't complete."
              : "The server operator didn't approve this purchase.")}
        </p>
        <p className="measure text-sm text-muted-foreground text-pretty">
          Nothing more will be charged. You can try the purchase again, or release the domain
          to remove it from this list.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild>
            <Link href={`/settings/domains/buy?domain=${encodeURIComponent(binding.domain)}`}>
              <RefreshCw className="size-4" aria-hidden="true" />
              Try again
            </Link>
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={releasing}
              >
                {releasing ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : null}
                Release domain
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Release {binding.domain}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The binding is removed from your account. Your pod and its data are
                  untouched, and you can request the domain again later.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep it</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-white hover:bg-destructive/90"
                  onClick={onRelease}
                >
                  Release
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}

/** Honest copy when the server paused the domain (routing record went away). */
function SuspendedNotice() {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-4"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      <p className="measure text-sm text-pretty">
        This domain stopped pointing at your pod server, so it&apos;s paused and visitors see an
        error. Restore the routing record below and it recovers automatically — or check now
        once you&apos;ve fixed it.
      </p>
    </div>
  );
}

/** Step 1: the TXT ownership challenge (only while the challenge is open). */
function TxtChallengeCard({ binding }: { binding: DomainBinding }) {
  const txt = txtInstruction(binding);
  if (!txt) return null;
  const expires = binding.txtRecord?.expires;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Step 1 · Prove you own it</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="measure text-sm text-muted-foreground text-pretty">
          Add this TXT record where you manage the domain&apos;s DNS (your registrar or DNS
          host). It&apos;s a one-time proof — you can delete it once the domain is verified.
        </p>
        <DnsRecordRow record={txt} />
        {expires ? (
          <p className="text-xs text-muted-foreground">
            This challenge expires {formatDate(expires)}. If it lapses, just claim the domain
            again for a fresh one.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Step 2: the routing record (recommended option first; alternatives after). */
function RoutingCard({ binding }: { binding: DomainBinding }) {
  const records = routingInstructions(binding);
  const step = binding.state === "claimed" ? "Step 2 · " : "";
  if (records.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{step}Point it at your pod</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="measure text-sm text-muted-foreground text-pretty">
            Your pod server hasn&apos;t published routing targets yet — ask your provider what
            to point the domain at.
          </p>
        </CardContent>
      </Card>
    );
  }
  const [recommended, ...alternatives] = records;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{step}Point it at your pod</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="measure text-sm text-muted-foreground text-pretty">
          Add this record so the domain reaches your pod server.
          {alternatives.length > 0
            ? " If your DNS host doesn't support it, use the alternative below instead."
            : ""}
        </p>
        <DnsRecordRow record={recommended} />
        {alternatives.length > 0 ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground underline-offset-4 hover:underline">
              Alternative record{alternatives.length > 1 ? "s" : ""}
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              {alternatives.map((record) => (
                <DnsRecordRow key={`${record.type}-${record.value}`} record={record} />
              ))}
            </div>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Human date for the challenge expiry ("19 June 2026"). */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "soon";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(date);
}
