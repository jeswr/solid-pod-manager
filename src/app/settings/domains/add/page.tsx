"use client";

/**
 * Add a domain — step 1 of the connect flow (docs/design/byod.md §5 in
 * prod-solid-server). The input validates locally with the same
 * deny-by-default rules the server applies (IDNA shape, no IPs, no
 * special-use TLDs, not the provider's own namespace), then POSTs the claim;
 * success lands on the detail page, which is the DNS setup screen.
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Globe, LoaderCircle } from "lucide-react";
import { DomainsErrorState } from "@/components/domains-ui";
import { useDomains, usePurchaseFeature } from "@/components/use-domains";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  claimDomain,
  DomainConflictError,
  DomainQuotaError,
  DomainsAuthError,
  DomainsError,
  DomainsUnavailableError,
  DomainValidationError,
  validateDomainInput,
} from "@/lib/domains";

export default function AddDomainPage() {
  // The list state doubles as the feature/session probe: a disabled server or
  // an expired session surfaces here before the user types anything.
  const { base, podRoot, data, loading, error, reload } = useDomains();
  // Only to offer the buy path as the alternative where the server sells domains.
  const { available: purchasable } = usePurchaseFeature(base, data !== undefined);
  const router = useRouter();

  const [input, setInput] = useState("");
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** Server-side rejection copy (quota, conflict, validation) — honest, inline. */
  const [serverError, setServerError] = useState<string | null>(null);

  const protectedHosts = base ? [new URL(base).hostname] : [];
  const validation = validateDomainInput(input, protectedHosts);
  const showInlineError = touched && input.trim().length > 0 && !validation.ok;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setTouched(true);
    setServerError(null);
    if (!validation.ok || !base || !podRoot) return;
    setSubmitting(true);
    try {
      const binding = await claimDomain(base, { domain: validation.domain, podRoot });
      // The detail page is the setup screen (TXT + routing records, Check now).
      router.replace(`/settings/domains/domain?name=${encodeURIComponent(binding.domain)}`);
    } catch (e: unknown) {
      if (
        e instanceof DomainQuotaError ||
        e instanceof DomainConflictError ||
        e instanceof DomainValidationError
      ) {
        setServerError(e.message);
      } else if (e instanceof DomainsUnavailableError) {
        setServerError("Custom domains are not enabled on your pod server.");
      } else if (e instanceof DomainsAuthError) {
        setServerError("Your session has expired. Go back and sign in again.");
      } else if (e instanceof DomainsError) {
        setServerError(e.message);
      } else {
        setServerError("Something went wrong claiming the domain. Check your connection and try again.");
      }
      setSubmitting(false);
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
          Connect a domain
        </h1>
        <p className="measure mt-1 text-muted-foreground text-pretty">
          Enter a domain you own. Next you&apos;ll add two DNS records at your registrar to
          prove it&apos;s yours and point it at your pod.
        </p>
      </header>

      {error ? (
        <DomainsErrorState error={error} onRetry={reload} />
      ) : loading ? (
        <Skeleton className="h-48 rounded-2xl" />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe className="size-4 text-muted-foreground" aria-hidden="true" />
              Your domain
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="domain-input">Domain name</Label>
                <Input
                  id="domain-input"
                  name="domain"
                  type="text"
                  inputMode="url"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder="pod.yourname.com"
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    setServerError(null);
                  }}
                  onBlur={() => setTouched(true)}
                  aria-invalid={showInlineError || serverError !== null || undefined}
                  aria-describedby="domain-help"
                  className="font-mono"
                />
                <p id="domain-help" className="text-sm text-muted-foreground">
                  Works with a subdomain (<span className="font-mono text-xs">pod.yourname.com</span>)
                  or a whole domain (<span className="font-mono text-xs">yourname.com</span>).
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
              <div>
                <Button type="submit" disabled={submitting || input.trim().length === 0}>
                  {submitting ? (
                    <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                  ) : null}
                  {submitting ? "Claiming…" : "Continue"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {!error && !loading && purchasable === true ? (
        <p className="text-sm text-muted-foreground">
          Don&apos;t have a domain yet?{" "}
          <Link
            href="/settings/domains/buy"
            className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Get a new one here
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}
