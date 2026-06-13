// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * People-search — the pure matching + WebID-resolution logic behind the shared
 * people-picker component. Kept UI-free so it is unit-testable and reusable by
 * any feature that needs to pick an agent (Sharing, chat, group membership).
 *
 * An agent is one of: a saved contact (with a WebID), a friend
 * (`foaf:knows`), or a raw WebID the user typed. The picker filters the known
 * agents by a query, and — when the query looks like a WebID URL — offers it as
 * a direct pick, optionally resolving the public profile for a friendly name.
 */
import { fetchProfile, type PodProfile } from "./profile.js";

/** A pickable agent surfaced in the people-picker. */
export interface PersonOption {
  /** The agent's WebID (the value a caller acts on). */
  webId: string;
  /** Friendly label (contact name / profile name / the WebID itself). */
  label: string;
  /** Where this option came from, for grouping + a subtle badge. */
  source: "contact" | "friend" | "webid";
  /** Optional secondary line (email, or the WebID when the label is a name). */
  detail?: string;
}

/**
 * Does this string look like a usable WebID? An absolute http(s) URL — we do
 * not require a fragment (some WebIDs are document-rooted), but we reject
 * obvious non-URLs so a name query does not masquerade as a WebID.
 */
export function looksLikeWebId(query: string): boolean {
  const q = query.trim();
  if (!/^https?:\/\//i.test(q)) return false;
  try {
    const u = new URL(q);
    return Boolean(u.hostname) && u.hostname.includes(".");
  } catch {
    return false;
  }
}

/**
 * Filter known options by a free-text query (case-insensitive, matches label,
 * detail or WebID). Empty query returns everything. Pure.
 */
export function filterPeople(options: PersonOption[], query: string): PersonOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter(
    (o) =>
      o.label.toLowerCase().includes(q) ||
      o.webId.toLowerCase().includes(q) ||
      (o.detail?.toLowerCase().includes(q) ?? false),
  );
}

/**
 * Merge contacts + friends into a de-duplicated, sorted option list. A WebID
 * present in both a contact and the friend list keeps the contact entry (it
 * carries the richer label). Pure.
 */
export function buildPeopleOptions(opts: {
  contacts: { webId: string; name?: string; email?: string }[];
  friends: string[];
}): PersonOption[] {
  const byWebId = new Map<string, PersonOption>();

  for (const c of opts.contacts) {
    if (!c.webId) continue;
    byWebId.set(c.webId, {
      webId: c.webId,
      label: c.name?.trim() || c.webId,
      source: "contact",
      detail: c.email,
    });
  }
  for (const f of opts.friends) {
    if (byWebId.has(f)) continue; // a contact entry wins
    byWebId.set(f, { webId: f, label: f, source: "friend" });
  }

  return [...byWebId.values()].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
}

/**
 * Resolve a typed WebID into a {@link PersonOption} by fetching its public
 * profile for a friendly name. Falls back to a bare-WebID option when the
 * profile is unreadable (a valid choice — the WebID is still actionable).
 *
 * @param fetchImpl - test-only override; **omit in production** so the
 *   auth-patched global fetch runs.
 */
export async function resolveWebIdOption(
  webId: string,
  fetchImpl?: typeof fetch,
): Promise<PersonOption> {
  const bare: PersonOption = { webId, label: webId, source: "webid" };
  try {
    const profile: PodProfile = await fetchProfile(webId, fetchImpl);
    const name = profile.displayName;
    // displayName falls back to the WebID; only use it as a label if it differs.
    if (name && name !== webId) {
      return { webId, label: name, source: "webid", detail: webId };
    }
    return bare;
  } catch {
    return bare;
  }
}
