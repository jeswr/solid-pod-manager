"use client";

/**
 * Domain detail — the DNS setup screen and the binding's home page
 * (BYOD Phase 1: claimed → verified → live, docs/design/byod.md §5).
 * While pending it shows the exact records to create (copy buttons on every
 * field), a "Check now" button driving POST verify, and polls politely while
 * on-screen. Addressed as `?name=<domain>` — a query parameter so the page
 * prerenders under `output: "export"` (domains are unknowable at build time).
 */
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowUpRight,
  Globe,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { CheckStatusLine, DnsRecordRow, DomainsErrorState, DomainStateBadge } from "@/components/domains-ui";
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
  describeState,
  DomainNotFoundError,
  DomainsError,
  isPollableState,
  releaseDomain,
  routingInstructions,
  txtInstruction,
  type DomainBinding,
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

  async function release() {
    if (!base || !binding) return;
    setReleasing(true);
    try {
      await releaseDomain(base, binding.domain);
      toast.success(`${binding.domain} was disconnected.`, {
        description: "Your pod and its data are untouched.",
      });
      router.push("/settings/domains");
    } catch (e: unknown) {
      toast.error(
        e instanceof DomainsError ? e.message : "Couldn't disconnect the domain. Try again.",
      );
      setReleasing(false);
    }
  }

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
              <DomainStateBadge state={binding.state} />
            </div>
            <p className="measure mt-1 text-muted-foreground text-pretty">
              {describeState(binding.state).description}
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
          {binding.state === "claimed" ? <TxtChallengeCard binding={binding} /> : null}
          {binding.state !== "live" && binding.state !== "released" ? (
            <RoutingCard binding={binding} />
          ) : null}

          {binding.state !== "released" ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Status</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <CheckStatusLine label="Ownership (TXT)" result={binding.checks?.txt} />
                <CheckStatusLine label="Routing" result={binding.checks?.routing} />
                {!binding.checks && binding.state !== "live" ? (
                  <p className="text-sm text-muted-foreground">
                    Once your DNS records are in place, run a check. DNS changes can take up to
                    48 hours to propagate, so don&apos;t worry if it takes a few tries.
                  </p>
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

          <Card className="border-destructive/30">
            <CardHeader>
              <CardTitle className="text-base">Disconnect</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="measure text-sm text-muted-foreground text-pretty">
                Disconnecting stops this domain from serving your pod
                {binding.state === "live" ? " — links using it will stop working" : ""}. Your
                pod and everything in it stay exactly where they are.
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
                        onClick={release}
                      >
                        Disconnect
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </CardContent>
          </Card>
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
          Your old address redirects here, so existing links and apps keep working. The TXT
          ownership record is no longer needed — you can delete it at your registrar.
        </p>
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
