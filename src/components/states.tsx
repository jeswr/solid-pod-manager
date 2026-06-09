import type { LucideIcon } from "lucide-react";
import { TriangleAlert } from "lucide-react";
import { RdfFetchError } from "@jeswr/fetch-rdf";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A friendly, jargon-free empty state with an optional call to action. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-muted/30 px-6 py-12 text-center",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="mb-4 grid size-12 place-items-center rounded-full bg-accent text-accent-foreground"
      >
        <Icon className="size-6" />
      </span>
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="measure mt-1 text-sm text-muted-foreground text-pretty">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/** Plain-language error copy for a thrown data-layer error. */
export function errorMessage(error: Error): string {
  if (error instanceof RdfFetchError) {
    if (error.status === 401 || error.status === 403) {
      return "You don't have permission to read this right now. Try signing in again.";
    }
    if (error.status === 404) return "We couldn't find this in your pod.";
    return "We couldn't read this from your pod. Check your connection and try again.";
  }
  return error.message || "Something went wrong. Please try again.";
}

/** A consistent error surface, with an optional retry. */
export function ErrorState({
  error,
  onRetry,
}: {
  error: Error;
  onRetry?: () => void;
}) {
  return (
    <Alert variant="destructive">
      <TriangleAlert className="size-4" aria-hidden="true" />
      <AlertTitle>Something went wrong</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <span>{errorMessage(error)}</span>
        {onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
