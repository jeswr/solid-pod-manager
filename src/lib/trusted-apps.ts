// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Trusted-applications reconciliation — Wave 3, Cluster B
 * ("Trusted-app (`acl:trustedApp`) origin list reconciled with Connected-apps").
 *
 * The Connected-apps view ({@link ./permissions.ts}) already lists every
 * non-owner subject that appears in the pod's `.acl` documents, tagging each as
 * an `agent` (named by WebID, `acl:agent`) or an `origin` (named by web
 * origin, `acl:origin`). This module turns that read model into the **trusted
 * applications** lens the Sharing surface wants: which *origins* (browser apps,
 * identified by their `acl:origin`) actually have access in the ACLs, so the
 * user can reconcile what's really granted against what they think they
 * trust — and revoke any origin in one click through the EXISTING
 * `PermissionsBackend.revokeGrants` path (no new write code).
 *
 * "Reconciliation" here means: the ACLs are the ground truth. We do not read a
 * separate `acl:trustedApp` registry from the profile (CSS does not maintain
 * one, and a profile claim that diverges from the ACLs would be misleading);
 * instead we report exactly what the ACL `acl:origin` rules say, which IS the
 * enforced trust. An origin present in the ACLs but not expected by the user is
 * surfaced for revoke; this is the honest, fail-closed reconciliation.
 */
import { allGrants, type AccessGrant, type AppAccess } from "./permissions.js";

/** One application origin that actually holds access, per the live ACLs. */
export interface TrustedAppOrigin {
  /** The web origin (`acl:origin` object), e.g. `https://app.example`. */
  origin: string;
  /** Whether a storage-root default rule grants it the whole pod. */
  wholePod: boolean;
  /** The grants backing it (passed straight to `revokeGrants`). */
  grants: AccessGrant[];
  /** Plain-language category labels it can touch, taxonomy order. */
  categoryLabels: string[];
}

/**
 * Project the Connected-apps read model onto the trusted-origins lens: keep
 * only the `origin`-kind subjects (browser apps trusted by their web origin),
 * each with the grants needed to revoke it.
 *
 * Named-WebID agents are deliberately excluded — those are people/services,
 * managed in the by-app and per-resource surfaces; this lens is specifically
 * the `acl:origin` trust the user might not remember granting.
 */
export function reconcileTrustedApps(apps: AppAccess[]): TrustedAppOrigin[] {
  return apps
    .filter((a) => a.kind === "origin")
    .map((a) => ({
      origin: a.agentId,
      wholePod: a.wholePod,
      grants: allGrants(a),
      categoryLabels: a.categories.map((c) => c.category.label),
    }))
    .sort((a, b) => a.origin.localeCompare(b.origin));
}

/**
 * A human label for an origin. Shows the FULL origin (scheme + host) so that
 * distinct grants like `http://app.example` and `https://app.example` are never
 * conflated in an access-control UI (roborev). The exact origin IRI remains the
 * key used for revocation.
 */
export function originLabel(origin: string): string {
  try {
    return new URL(origin).origin || origin;
  } catch {
    return origin;
  }
}
