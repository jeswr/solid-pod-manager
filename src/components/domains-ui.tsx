"use client";

/**
 * Shared presentational pieces for the custom-domains screens: the state
 * badge, copyable DNS-record rows, per-check status lines, and the
 * domains-specific error surface (feature-disabled and session-expired get
 * their own honest affordances instead of a generic error).
 */
import { CheckCircle2, Copy, Globe, LoaderCircle, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/components/session-provider";
import { EmptyState, ErrorState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  describeState,
  DomainsAuthError,
  DomainsUnavailableError,
  type CheckResult,
  type DnsInstruction,
  type DomainState,
  type StateTone,
} from "@/lib/domains";
import { cn } from "@/lib/utils";

/** Badge styling per state tone (light + dark are both covered by the tokens). */
const TONE_CLASSES: Record<StateTone, string> = {
  pending:
    "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  progress: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  live: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  warning: "border-destructive/30 bg-destructive/10 text-destructive",
  muted: "border-border bg-muted text-muted-foreground",
};

/** The state badge ("Pending DNS" / "Verifying" / "Live" / "Suspended"). */
export function DomainStateBadge({ state }: { state: DomainState }) {
  const badge = describeState(state);
  return (
    <Badge variant="outline" className={cn("border", TONE_CLASSES[badge.tone])}>
      {badge.label}
    </Badge>
  );
}

/** Copy a value to the clipboard with a confirming toast. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="shrink-0"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          toast.success("Copied", { description: label });
        } catch {
          toast.error("Couldn't copy — select and copy the value by hand.");
        }
      }}
    >
      <Copy className="size-3.5" aria-hidden="true" />
      <span className="sr-only">Copy {label}</span>
    </Button>
  );
}

/** One labelled, copyable DNS field (name or value). */
function RecordField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 flex items-center gap-1">
        <code className="min-w-0 break-all rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">
          {value}
        </code>
        <CopyButton value={value} label={label} />
      </div>
    </div>
  );
}

/** A DNS record the user must create, every field copyable. */
export function DnsRecordRow({ record }: { record: DnsInstruction }) {
  return (
    <div className="grid gap-3 rounded-xl border border-border bg-muted/30 p-3 sm:grid-cols-[4rem_1fr_1fr]">
      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Type
        </div>
        <div className="mt-0.5 font-mono text-xs font-semibold">{record.type}</div>
      </div>
      <RecordField label="Name" value={record.name} />
      <RecordField label="Value" value={record.value} />
    </div>
  );
}

/** One DNS-check outcome ("TXT found ✓ / routing not seen yet — we'll keep checking"). */
export function CheckStatusLine({
  label,
  result,
}: {
  label: string;
  result: CheckResult | undefined;
}) {
  if (!result) return null;
  return (
    <p className="flex items-start gap-2 text-sm">
      {result.ok ? (
        <CheckCircle2
          className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-hidden="true"
        />
      ) : (
        <LoaderCircle
          className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground"
          aria-hidden="true"
        />
      )}
      <span className={result.ok ? "" : "text-muted-foreground"}>
        <span className="font-medium text-foreground">{label}:</span> {result.detail}
      </span>
    </p>
  );
}

/**
 * The domains error surface. Feature-disabled is an *empty state* (the server
 * simply doesn't offer this), and an expired session reuses the app's login
 * affordance (sign out → the login screen) — everything else is a retryable
 * error with the server's honest copy.
 */
export function DomainsErrorState({
  error,
  onRetry,
  icon = Globe,
}: {
  error: Error;
  onRetry?: () => void;
  icon?: LucideIcon;
}) {
  const { logout } = useSession();
  if (error instanceof DomainsUnavailableError) {
    return (
      <EmptyState
        icon={icon}
        title="Not enabled on your server"
        description="Your pod provider hasn't switched on custom domains. There's nothing wrong — this server just doesn't offer the feature yet."
      />
    );
  }
  if (error instanceof DomainsAuthError) {
    return (
      <EmptyState
        icon={icon}
        title="Your session has expired"
        description="Sign in again to manage the domains connected to your pod."
        action={
          <Button onClick={() => logout()}>Sign in again</Button>
        }
      />
    );
  }
  return <ErrorState error={error} onRetry={onRetry} />;
}
