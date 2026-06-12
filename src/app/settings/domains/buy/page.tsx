"use client";

/**
 * Get a new domain — the purchase flow (server: BYOD Phase 3, optional via
 * `PSS_DOMAIN_PURCHASE_ENABLE`). Search a name → live quote (availability +
 * first-year/renewal price) → review (domain, price, the pod it attaches to)
 * → confirm → the purchase request queues server-side and the detail page
 * takes over (pending approval → registering → live — the server registers
 * the domain and authors its DNS itself; the owner never touches a
 * registrar). Where the server doesn't offer purchases the quote route is
 * absent and this page sends people to the connect-your-own flow instead.
 */
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  BadgeCheck,
  Globe,
  LoaderCircle,
  Search,
  ShieldCheck,
  ShoppingCart,
} from "lucide-react";
import { DomainsErrorState } from "@/components/domains-ui";
import { EmptyState } from "@/components/states";
import { useDomains, usePurchaseFeature } from "@/components/use-domains";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DomainPurchaseUnavailableError,
  DomainsAuthError,
  DomainsError,
  formatUsd,
  purchaseDomain,
  quotePurchase,
  validateDomainInput,
  type DomainQuote,
} from "@/lib/domains";

export default function BuyDomainPage() {
  // useSearchParams (the ?domain= retry prefill) needs a Suspense boundary
  // in a prerendered page.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <BuyDomain />
    </Suspense>
  );
}

function BuyDomain() {
  // The list state doubles as the feature/session probe (same pattern as the
  // add page); the purchase probe runs once the list has answered.
  const { base, podRoot, data, loading, error, reload } = useDomains();
  const { available: purchasable } = usePurchaseFeature(base, data !== undefined);
  const router = useRouter();

  // ?domain= prefills the search after a failed purchase ("Try again").
  const prefill = useSearchParams().get("domain") ?? "";
  const [input, setInput] = useState(prefill);
  const [touched, setTouched] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [quote, setQuote] = useState<DomainQuote | null>(null);
  /** True once the user chose "Buy" — the review-and-confirm step. */
  const [reviewing, setReviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /** Server-side rejection copy (quota, conflict, rate limit) — honest, inline. */
  const [serverError, setServerError] = useState<string | null>(null);

  const protectedHosts = base ? [new URL(base).hostname] : [];
  const validation = validateDomainInput(input, protectedHosts);
  const showInlineError = touched && input.trim().length > 0 && !validation.ok;

  async function search(event: React.FormEvent) {
    event.preventDefault();
    setTouched(true);
    setServerError(null);
    setQuote(null);
    setReviewing(false);
    if (!validation.ok || !base) return;
    setQuoting(true);
    try {
      setQuote(await quotePurchase(base, validation.domain));
    } catch (e: unknown) {
      if (e instanceof DomainPurchaseUnavailableError) {
        setServerError("Buying a domain isn't offered on your pod server.");
      } else if (e instanceof DomainsAuthError) {
        setServerError("Your session has expired. Go back and sign in again.");
      } else if (e instanceof DomainsError) {
        setServerError(e.message);
      } else {
        setServerError("Something went wrong checking the domain. Try again in a moment.");
      }
    } finally {
      setQuoting(false);
    }
  }

  async function confirm() {
    if (!base || !podRoot || !quote) return;
    setConfirming(true);
    setServerError(null);
    try {
      const binding = await purchaseDomain(base, { domain: quote.domain, podRoot });
      // The detail page owns the rest of the journey (approval → registering → live).
      router.replace(`/settings/domains/domain?name=${encodeURIComponent(binding.domain)}`);
    } catch (e: unknown) {
      if (e instanceof DomainsAuthError) {
        setServerError("Your session has expired. Go back and sign in again.");
      } else if (e instanceof DomainsError) {
        // Quota (403) and conflict (409) reasons are the server's honest copy.
        setServerError(e.message);
      } else {
        setServerError("Something went wrong requesting the purchase. Try again in a moment.");
      }
      setConfirming(false);
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
        <h1 className="mt-2 text-2xl font-semibold tracking-tight md:text-3xl">
          Get a new domain
        </h1>
        <p className="measure mt-1 text-muted-foreground text-pretty">
          Search for a name and your pod provider registers it for you — no registrar account,
          no DNS records to copy. It just starts working.
        </p>
      </header>

      {error ? (
        <DomainsErrorState error={error} onRetry={reload} icon={ShoppingCart} />
      ) : loading || (purchasable === undefined && !error) ? (
        <Skeleton className="h-48 rounded-2xl" />
      ) : purchasable === false ? (
        <EmptyState
          icon={ShoppingCart}
          title="Buying isn't offered here"
          description="Your pod provider doesn't sell domains. You can still connect a domain you already own."
          action={
            <Button asChild>
              <Link href="/settings/domains/add">Connect a domain you own</Link>
            </Button>
          }
        />
      ) : reviewing && quote && quote.price ? (
        <ReviewCard
          quote={quote}
          price={quote.price}
          podRoot={podRoot}
          confirming={confirming}
          serverError={serverError}
          onBack={() => {
            setReviewing(false);
            setServerError(null);
          }}
          onConfirm={confirm}
        />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Globe className="size-4 text-muted-foreground" aria-hidden="true" />
                Find a domain
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={search} className="flex flex-col gap-4" noValidate>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="buy-domain-input">Domain name</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      id="buy-domain-input"
                      name="domain"
                      type="text"
                      inputMode="url"
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      placeholder="yourname.com"
                      value={input}
                      onChange={(e) => {
                        setInput(e.target.value);
                        setServerError(null);
                        setQuote(null);
                      }}
                      onBlur={() => setTouched(true)}
                      aria-invalid={showInlineError || serverError !== null || undefined}
                      aria-describedby="buy-domain-help"
                      className="max-w-xs font-mono"
                    />
                    <Button type="submit" disabled={quoting || input.trim().length === 0}>
                      {quoting ? (
                        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <Search className="size-4" aria-hidden="true" />
                      )}
                      {quoting ? "Checking…" : "Check availability"}
                    </Button>
                  </div>
                  <p id="buy-domain-help" className="text-sm text-muted-foreground">
                    Enter the full name you&apos;d like, like{" "}
                    <span className="font-mono text-xs">yourname.com</span>.
                  </p>
                  {showInlineError ? (
                    <p role="alert" className="text-sm text-destructive">
                      {validation.ok ? null : validation.reason}
                    </p>
                  ) : null}
                  {serverError ? (
                    <p role="alert" className="text-sm text-destructive">
                      {serverError}
                    </p>
                  ) : null}
                </div>
              </form>
            </CardContent>
          </Card>

          {quote ? (
            <QuoteResultCard quote={quote} onBuy={() => setReviewing(true)} />
          ) : null}

          <p className="text-sm text-muted-foreground">
            Already own a domain?{" "}
            <Link
              href="/settings/domains/add"
              className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Connect it instead
            </Link>
            .
          </p>
        </>
      )}
    </div>
  );
}

/** The quote verdict: a price card with Buy, or the server's honest refusal. */
function QuoteResultCard({ quote, onBuy }: { quote: DomainQuote; onBuy: () => void }) {
  if (!quote.purchasable || !quote.price) {
    return (
      <Card>
        <CardContent>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="break-all font-mono text-sm font-semibold">{quote.domain}</p>
              <p className="mt-1 text-sm text-muted-foreground text-pretty">
                {quote.reason ?? "This domain can't be purchased here."}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2">
              <span className="break-all font-mono text-sm font-semibold">{quote.domain}</span>
              <span className="inline-flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-400">
                <BadgeCheck className="size-4" aria-hidden="true" />
                Available
              </span>
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">
                {formatUsd(quote.price.registrationUsd)}
              </span>{" "}
              for the first year, then {formatUsd(quote.price.renewalUsd)}/yr — privacy
              protection and auto-renew included.
            </p>
          </div>
          <Button onClick={onBuy}>
            <ShoppingCart className="size-4" aria-hidden="true" />
            Buy
          </Button>
        </div>
        {quote.approvalRequired ? (
          <p className="text-sm text-muted-foreground text-pretty">
            Purchases are reviewed by the server operator — after you confirm, you&apos;ll see
            it as <span className="font-medium text-foreground">Pending approval</span> and
            nothing is charged until they approve.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The review-and-confirm step: domain, price, the pod it attaches to. */
function ReviewCard({
  quote,
  price,
  podRoot,
  confirming,
  serverError,
  onBack,
  onConfirm,
}: {
  quote: DomainQuote;
  price: NonNullable<DomainQuote["price"]>;
  podRoot: string | undefined;
  confirming: boolean;
  serverError: string | null;
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Review your purchase</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="flex flex-col gap-3 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">Domain</dt>
            <dd className="break-all font-mono font-semibold">{quote.domain}</dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">First year</dt>
            <dd className="font-semibold">{formatUsd(price.registrationUsd)}</dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">Renews at</dt>
            <dd>{formatUsd(price.renewalUsd)}/yr (auto-renew)</dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">Attaches to</dt>
            <dd className="break-all font-mono text-xs">{podRoot}</dd>
          </div>
        </dl>
        <Separator />
        <p className="flex items-start gap-1.5 text-sm text-muted-foreground text-pretty">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
          WHOIS privacy protection is always on, and your provider manages the DNS — you never
          touch a registrar.
        </p>
        {quote.approvalRequired ? (
          <p className="text-sm text-muted-foreground text-pretty">
            The server operator reviews purchases before anything is charged. Your request will
            show as <span className="font-medium text-foreground">Pending approval</span> until
            then.
          </p>
        ) : null}
        {serverError ? (
          <p role="alert" className="text-sm text-destructive">
            {serverError}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={onConfirm} disabled={confirming}>
            {confirming ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <ShoppingCart className="size-4" aria-hidden="true" />
            )}
            {confirming
              ? "Requesting…"
              : quote.approvalRequired
                ? "Request purchase"
                : `Buy for ${formatUsd(price.registrationUsd)}`}
          </Button>
          <Button variant="outline" onClick={onBack} disabled={confirming}>
            Back
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
