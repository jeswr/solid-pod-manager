// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * `<LaunchInApp app="drive" />` — a deep-link from a Pod Manager data page to
 * the matching deployed pod-app subdomain ("Open in Pod Drive"). The Pod Manager
 * is the hub; this is the jump into a focused app over the same pod.
 *
 * It is a real NATIVE anchor (`<a href target="_blank" rel="noopener noreferrer">`)
 * styled with the existing `Button asChild` pattern — navigation is an `<a>`, not
 * a button-with-onclick (accessible-html-links: the First Rule of ARIA). The
 * visible text is self-describing ("Open in Pod Drive"), so it reads correctly
 * out of context (WCAG 2.4.4/2.4.9) without leaning on `aria-label`. The
 * external-link icon is decorative (`aria-hidden`).
 */
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { podApp, type PodAppKey } from "@/lib/pod-apps";

export function LaunchInApp({
  app,
  label,
  variant = "outline",
  size,
}: {
  /** Which deployed pod app to open. */
  app: PodAppKey;
  /** Override the visible text. Defaults to `Open in <app name>`. */
  label?: string;
  /** Button variant — defaults to a quiet `outline` so it sits beside primaries. */
  variant?: React.ComponentProps<typeof Button>["variant"];
  /** Button size, passed through to the underlying Button. */
  size?: React.ComponentProps<typeof Button>["size"];
}) {
  const { label: appName, url } = podApp(app);
  // Self-describing visible text — readable out of context, no aria-label needed.
  const text = label ?? `Open in ${appName}`;

  return (
    <Button asChild variant={variant} size={size}>
      <a href={url} target="_blank" rel="noopener noreferrer">
        <ExternalLink aria-hidden="true" />
        {text}
      </a>
    </Button>
  );
}
