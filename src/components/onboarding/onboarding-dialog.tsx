// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * The first-run welcome explainer dialog (task #93, G8/P1-3).
 *
 * A 3-step, dismissible intro shown ONCE to a brand-new logged-in user (what a
 * pod is, what Pod Manager does, "add your first thing"). It is a controlled
 * Radix Dialog, which gives WCAG 2.2 AA for free + by construction:
 *   - role="dialog" + aria-modal, labelled by the step title and described by
 *     its body (`aria-labelledby`/`aria-describedby` via DialogTitle/Description);
 *   - a focus TRAP while open and focus RESTORE to the trigger on close;
 *   - dismissible WITHOUT a mouse — Escape closes it, and every control (Back /
 *     Next / Skip / Get started / the ✕) is a real, keyboard-reachable <button>
 *     with a visible focus ring (the shared Button focus styles);
 *   - the step indicator is decorative (aria-hidden) with a polite live region
 *     announcing "Step N of M" for screen-reader users.
 *
 * ALL dismissal paths — finishing, Skip, Escape, the ✕, an overlay click —
 * funnel through `onDismiss`, so the pod first-run flag is persisted exactly once
 * however the user leaves (see {@link file://./use-onboarding.ts}). Plain
 * language only; no WebID/ACL/RDF jargon (DESIGN.md §2).
 */
import { useState } from "react";
import Link from "next/link";
import { Dialog } from "radix-ui";
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ONBOARDING_STEPS } from "./onboarding-steps";

export interface OnboardingDialogProps {
  /** Whether the explainer is open (controlled by the onboarding hook). */
  open: boolean;
  /**
   * Called whenever the user leaves the explainer (Finish / Skip / Escape / ✕ /
   * overlay click). The caller persists the pod first-run flag here.
   */
  onDismiss: () => void;
}

/**
 * The controlled first-run welcome dialog. `open` is owned by the caller; the
 * STEP index is local (it resets the next time `open` flips to true via `key`).
 */
export function OnboardingDialog({ open, onDismiss }: OnboardingDialogProps) {
  return (
    // Remount on each open so the step index always starts at 0 — cheaper and
    // more robust than syncing a reset effect to `open`.
    <Dialog.Root
      key={open ? "open" : "closed"}
      open={open}
      onOpenChange={(next) => {
        // Radix calls this with `false` for Escape, overlay click, and the
        // close control — every dismissal path lands here.
        if (!next) onDismiss();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-50 bg-black/20 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-5 rounded-2xl border border-border bg-card p-6 shadow-lg duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 sm:max-w-md"
          aria-label="Welcome to Pod Manager"
        >
          <OnboardingBody onDismiss={onDismiss} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function OnboardingBody({ onDismiss }: { onDismiss: () => void }) {
  const [stepIndex, setStepIndex] = useState(0);
  const total = ONBOARDING_STEPS.length;
  const step = ONBOARDING_STEPS[stepIndex];
  const Icon = step.icon;
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === total - 1;

  return (
    <>
      {/* Top row: a polite live "Step N of M" + a keyboard-reachable close. */}
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground" role="status" aria-live="polite">
          Step {stepIndex + 1} of {total}
        </p>
        <Dialog.Close asChild>
          {/* aria-label so the ✕ has an accessible name; closing persists the flag. */}
          <Button variant="ghost" size="icon-sm" aria-label="Close welcome">
            <X aria-hidden="true" />
          </Button>
        </Dialog.Close>
      </div>

      <div className="flex flex-col items-center gap-4 text-center">
        <span
          aria-hidden="true"
          className="grid size-14 place-items-center rounded-2xl bg-accent text-accent-foreground"
        >
          <Icon className="size-7" />
        </span>
        <div className="flex flex-col gap-1.5">
          <Dialog.Title className="text-xl font-semibold tracking-tight">
            {step.title}
          </Dialog.Title>
          <Dialog.Description className="measure text-sm text-muted-foreground text-pretty">
            {step.body}
          </Dialog.Description>
        </div>
      </div>

      {/* Decorative progress dots (the live region above carries the real info). */}
      <div className="flex justify-center gap-1.5" aria-hidden="true">
        {ONBOARDING_STEPS.map((s, i) => (
          <span
            key={s.title}
            className={cn(
              "size-1.5 rounded-full transition-colors",
              i === stepIndex ? "bg-primary" : "bg-muted-foreground/30",
            )}
          />
        ))}
      </div>

      <div className="flex items-center justify-between gap-2">
        {isFirst ? (
          // Skip the whole intro — still a real, keyboard-reachable dismissal.
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Skip
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
          >
            <ArrowLeft aria-hidden="true" />
            Back
          </Button>
        )}

        {isLast ? (
          // Primary action: dismiss + go take the first action (browse the pod).
          <Button asChild onClick={onDismiss}>
            <Link href="/my-data">Get started</Link>
          </Button>
        ) : (
          <Button onClick={() => setStepIndex((i) => Math.min(total - 1, i + 1))}>
            Next
            <ArrowRight aria-hidden="true" />
          </Button>
        )}
      </div>
    </>
  );
}
