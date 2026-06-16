// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * The first-run welcome explainer copy (task #93, G8/P1-3).
 *
 * Three short, plain-language steps — what a pod is, what Pod Manager does, and
 * "add your first thing". DELIBERATELY NO jargon: no "WebID", "ACL", "RDF",
 * "triple", "container" (DESIGN.md §2). Kept as data (not JSX) so the wording is
 * easy to test/tweak and the dialog component stays purely structural.
 */
import type { LucideIcon } from "lucide-react";
import { Boxes, FolderOpen, Sparkles } from "lucide-react";

export interface OnboardingStep {
  /** A decorative icon for the step (aria-hidden in the UI). */
  icon: LucideIcon;
  /** The step heading. */
  title: string;
  /** A short, plain-language explanation (1–2 sentences). */
  body: string;
}

/**
 * The ordered welcome steps. The last one points at the first action a brand-new
 * user can take ("Browse my data") — wired to a real route by the dialog.
 */
export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    icon: Boxes,
    title: "Welcome — this is your pod",
    body: "A pod is your own private space for your data, like a personal storage box that only you control. Everything you keep here stays yours.",
  },
  {
    icon: Sparkles,
    title: "Pod Manager keeps you in charge",
    body: "See what's in your pod, organised into plain categories, and choose exactly which apps can read or change it — and change your mind any time.",
  },
  {
    icon: FolderOpen,
    title: "Add your first thing",
    body: "Start by browsing what's already here, or add a note, a bookmark, a task, or upload a file. Whatever you create is saved privately to your pod.",
  },
] as const;
