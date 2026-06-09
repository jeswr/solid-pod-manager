import { ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

/** The Pod Manager wordmark — a shield (privacy/trust) + the product name. */
export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <span
        aria-hidden="true"
        className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground"
      >
        <ShieldCheck className="size-5" />
      </span>
      <span className="text-base font-semibold tracking-tight">Pod Manager</span>
    </span>
  );
}
