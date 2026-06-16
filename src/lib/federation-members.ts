// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Pure presentation helpers for the `/federations` discovery view — kept in
 * `src/lib` (NOT the page file) because a Next.js App Router page module may only
 * export a `default` plus a fixed set of framework names (metadata, etc.), never
 * arbitrary named helpers. Extracting them here also makes them directly
 * unit-testable in the no-DOM `node` env (vitest scans `src/lib/**`).
 *
 * Every helper is total + fail-soft (never throws on registry data): it renders
 * SOMETHING sensible for any input, since the registry is a third-party document.
 */
import type { DiscoveredMember } from "@/lib/federation-registry";

/** The shadcn Badge variants this view uses. */
export type FederationBadgeVariant = "default" | "secondary" | "destructive";

/**
 * A friendly display name for a member from its `client_id` IRI.
 *
 * Prefers the host (plus a meaningful trailing path segment for multi-app
 * origins) for an http(s) IRI; for a non-http(s) URL (urn:, did:, …) or a
 * non-URL value the raw id is shown verbatim. Empty → a placeholder.
 */
export function memberDisplayName(id: string): string {
  const raw = id.trim();
  if (!raw) return "Unnamed app";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw; // not a URL — show the id verbatim
  }
  // Only derive a host/path label for http(s) client_id IRIs (those have a real
  // host). A non-http(s) scheme parses as a URL but has an empty host, so show it
  // verbatim rather than producing a hostless `/segment`.
  if (url.protocol !== "http:" && url.protocol !== "https:") return raw;
  // A meaningful last path segment (not just "/", and not a doc filename like
  // clientid.jsonld) reads better than the bare host for multi-app origins.
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (last && !/\.(jsonld|ttl|json)$/i.test(last)) {
    return `${url.host}/${last}`;
  }
  return url.host;
}

/**
 * The Badge variant for a membership status. `Active` is the only LIVE status
 * (emphasised, default/primary); `Suspended`/`Revoked` are withdrawn (muted
 * destructive, so they read as inactive — NOT trusted); `Proposed`/unknown are
 * neutral.
 */
export function statusBadgeVariant(
  status: DiscoveredMember["status"],
): FederationBadgeVariant {
  switch (status) {
    case "Active":
      return "default";
    case "Suspended":
    case "Revoked":
      return "destructive";
    default:
      return "secondary";
  }
}

/** A human label for a status (or "Unknown status" when absent). */
export function statusLabel(status: DiscoveredMember["status"]): string {
  return status ?? "Unknown status";
}

/**
 * A compact label for the asserting authorities (`membership.assertedBy`, an
 * array of authority IRIs): the first's host (a "+N more" suffix when several),
 * or "an unnamed authority" when absent.
 */
export function assertedByLabel(assertedBy: readonly string[] | undefined): string {
  const list = (assertedBy ?? []).map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return "an unnamed authority";
  const first = hostOrRaw(list[0]);
  return list.length > 1 ? `${first} +${list.length - 1} more` : first;
}

/** The host of a URL, or the raw value when it is not parseable. */
function hostOrRaw(value: string): string {
  try {
    return new URL(value).host || value;
  } catch {
    return value;
  }
}

/**
 * Build a plain-language Error from the registry's document-level issues — used
 * when the whole registry document is invalid (couldn't fetch/parse), so the user
 * sees WHY rather than a bare empty list.
 */
export function registryError(
  issues: DiscoveredMember["issues"] | undefined,
): Error {
  const detail = (issues ?? [])
    .map((i) => i.message)
    .filter(Boolean)
    .join(" ");
  return new Error(
    detail
      ? `We couldn't read the federation registry. ${detail}`
      : "We couldn't read the federation registry. Check the address and try again.",
  );
}
