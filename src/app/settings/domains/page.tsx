"use client";

/**
 * Domains — the connected custom domains list (BYOD Phase 1 app side, plus
 * the Phase 3 buy path when the server offers it). Each row links to the
 * detail/setup screen; "Connect a domain" starts the connect-your-own flow
 * and — only where the quote endpoint feature-detects — "Get a new domain"
 * starts the purchase flow. Feature-disabled servers get an honest empty
 * state, not an error (the routes simply don't exist there).
 */
import Link from "next/link";
import { ChevronRight, Globe, Plus, ShieldCheck, ShoppingCart } from "lucide-react";
import { DomainBindingBadge, DomainsErrorState } from "@/components/domains-ui";
import { EmptyState } from "@/components/states";
import { useDomains, usePurchaseFeature } from "@/components/use-domains";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { bindingBadge, DomainsUnavailableError } from "@/lib/domains";

export default function DomainsPage() {
  const { data, base, loading, error, reload } = useDomains();
  // Probe the buy path only once the list answered (feature + session known).
  const { available: purchasable } = usePurchaseFeature(base, data !== undefined);

  // Released bindings are tombstones — not "connected", so not listed.
  const domains = (data ?? []).filter((d) => d.state !== "released");
  const featureAvailable = !(error instanceof DomainsUnavailableError);

  const actions = (
    <>
      {purchasable === true ? (
        <Button asChild>
          <Link href="/settings/domains/buy">
            <ShoppingCart className="size-4" aria-hidden="true" />
            Get a new domain
          </Link>
        </Button>
      ) : null}
      <Button asChild variant={purchasable === true ? "outline" : "default"}>
        <Link href="/settings/domains/add">
          <Plus className="size-4" aria-hidden="true" />
          Connect a domain
        </Link>
      </Button>
    </>
  );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Domains</h1>
          <p className="measure mt-1 text-muted-foreground text-pretty">
            Use your own web address for your pod — like{" "}
            <span className="font-mono text-sm">pod.yourname.com</span> — instead of one on
            your provider&apos;s.
          </p>
        </div>
        {featureAvailable && !loading ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </header>

      {error ? (
        <DomainsErrorState error={error} onRetry={reload} />
      ) : loading ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading domains">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-2xl" />
          ))}
        </div>
      ) : domains.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="No domains connected yet"
          description={
            purchasable === true
              ? "Connect a domain you already own, or get a new one right here — either way your pod gets its own address and we take care of the certificate."
              : "Connect a domain you own and your pod gets its own address. You'll add two DNS records and we take care of the rest, including the certificate."
          }
          action={<div className="flex flex-wrap items-center justify-center gap-2">{actions}</div>}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {domains.map((binding) => (
            <li key={binding.domain}>
              <Link
                href={`/settings/domains/domain?name=${encodeURIComponent(binding.domain)}`}
                className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4 transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="break-all font-medium">{binding.domain}</span>
                    <DomainBindingBadge binding={binding} />
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground text-pretty">
                    {bindingBadge(binding).description}
                  </p>
                </div>
                <ChevronRight
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <ShieldCheck className="size-4 shrink-0 text-primary" aria-hidden="true" />
        You stay in control: disconnecting a domain never touches the data in your pod.
      </p>
    </div>
  );
}
