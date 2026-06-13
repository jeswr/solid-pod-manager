// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Source-aware actions (design: `docs/typed-data-views.md` §5).
 *
 * Every integration records provenance as the item's canonical page on the
 * source platform — `PodThing.sourceUrl` → `schema:url`, with a recognizable
 * host (`open.spotify.com`, `youtube.com`, …). This module turns that host into
 * an action descriptor: instead of *displaying* the Spotify URL as a data row,
 * a viewer renders an **"Open in Spotify"** button and suppresses the raw URL.
 *
 * Pure + DOM-free: the action carries an icon *name* (string), resolved to a
 * Lucide component only in the UI layer (same pattern as `category-icon.tsx`),
 * which keeps the models serialisable for offline/SSR.
 *
 * Safety: the outbound `href` is always passed through `safeLinkHref`
 * (`pod-scope.ts`, SEC-2) so only `http(s)`/`mailto` IRIs ever become links;
 * `javascript:`/`data:` IRIs from pod data resolve to `undefined` → no match.
 */
import { safeLinkHref } from "../pod-scope.js";

/** A recognisable source platform and how to present a link to it. */
export interface SourceAction {
  /** Stable id, e.g. "spotify". */
  id: string;
  /** Button label, e.g. "Open in Spotify". */
  label: string;
  /** Lucide icon name — resolved to a component in the UI layer only. */
  icon: string;
  /** Brand hint for styling, optional. */
  brand?: string;
}

/** A resolved source action: the descriptor plus the safe outbound href. */
export interface SourceMatch extends SourceAction {
  /** The safe outbound href derived from the resource's `schema:url`. */
  href: string;
}

interface SourceMatcher {
  /** Does this matcher own the given source URL? (host check) */
  test: (host: string, url: URL) => boolean;
  action: SourceAction;
  /** Derive the outbound link (usually identity; lets a source rewrite if needed). */
  hrefFromResource: (sourceUrl: string, url: URL) => string;
}

/**
 * The matcher table. Spotify first (§5); YouTube/Pinterest/GitHub/Strava/… are
 * added one entry at a time as their viewers land — because every integration
 * writes `schema:url` with a recognizable host, one table covers them all, for
 * free, across every viewer.
 */
const MATCHERS: readonly SourceMatcher[] = [
  {
    test: (h) => h === "open.spotify.com" || h.endsWith(".spotify.com"),
    action: { id: "spotify", label: "Open in Spotify", icon: "external-link", brand: "spotify" },
    hrefFromResource: (u) => u,
  },
];

/**
 * Resolve the source action for a resource's `schema:url`, if recognised and
 * safe. Returns `undefined` when the URL is absent, unparsable, not http(s), or
 * its host matches no known source — the caller then shows a neutral "Open
 * original page" link (still via `safeLinkHref`) or nothing, never a raw IRI as
 * a data row (§5 rule 2).
 */
export function sourceActionFor(sourceUrl: string | undefined): SourceMatch | undefined {
  if (!sourceUrl) return undefined;
  // Safety gate first: rejects non-http(s) schemes and anything unparsable.
  const safe = safeLinkHref(sourceUrl);
  if (!safe) return undefined;
  let url: URL;
  try {
    url = new URL(safe);
  } catch {
    return undefined;
  }
  // mailto: passes safeLinkHref but is not a navigable source page.
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const host = url.host.toLowerCase();
  for (const m of MATCHERS) {
    if (m.test(host, url)) {
      const href = safeLinkHref(m.hrefFromResource(safe, url));
      // The derived href must itself be safe (a matcher could rewrite to a
      // non-http scheme); if it isn't, treat the source as unrecognised.
      if (!href) return undefined;
      return { ...m.action, href };
    }
  }
  return undefined;
}
