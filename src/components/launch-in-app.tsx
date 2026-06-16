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
 *
 * When the user is signed in, the href carries the WebID as an
 * `#autologin/<webId>` fragment so the target app can auto-authenticate without
 * re-prompting (`podAppLaunchUrl`). The fragment is client-side only (never
 * sent to the server); when signed out the link is the bare app URL.
 */
import { ExternalLink } from "lucide-react";
import { useSession } from "@/components/session-provider";
import { Button } from "@/components/ui/button";
import { POD_APP_LABEL, podAppLaunchUrl, type PodAppKey } from "@/lib/pod-apps";

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
  const { webId } = useSession();
  // Self-describing visible text — readable out of context, no aria-label needed.
  const text = label ?? `Open in ${POD_APP_LABEL[app]}`;
  // Signed in → carry the WebID so the target app auto-authenticates; signed
  // out → bare app URL. The WebID lives only in the href fragment (never logged).
  const href = podAppLaunchUrl(app, webId);

  return (
    <Button asChild variant={variant} size={size}>
      <a href={href} target="_blank" rel="noopener noreferrer">
        <ExternalLink aria-hidden="true" />
        {text}
      </a>
    </Button>
  );
}
