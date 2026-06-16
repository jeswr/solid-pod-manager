// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * Pure inbox-discovery state + cache-key derivation for {@link useInbox}.
 *
 * Lives in `lib/` (not the hook module) so it carries NO React/JSX in its import
 * graph and can be unit-tested directly under Vitest's `node` env (no DOM/React
 * renderer — see vitest.config.ts), the same way the rest of the SWR first-paint
 * logic is tested.
 */
import type { Inbox } from "@/lib/inbox";

/**
 * The result of inbox discovery, TAGGED with the active storage it was run for.
 * Tagging is load-bearing: discovery runs in an effect AFTER paint, so on a
 * storage switch this state still describes the PREVIOUS storage for one render.
 * Carrying `storage` lets the render gate on `storage === activeStorage` before
 * trusting `inbox`/`inboxUrl`/`discovered`, so the previous storage's inbox can
 * never flash (the discovered URL is used as the cache key only when it belongs
 * to the CURRENT storage). See {@link inboxDiscoveryReady}/{@link inboxCacheKey}.
 */
export interface InboxDiscovery {
  /** The active storage this discovery was run for. */
  storage?: string;
  inbox?: Inbox;
  inboxUrl?: string;
  /** Has discovery settled? Distinguishes "still discovering" from "no inbox". */
  discovered: boolean;
}

/** The initial (logged-out / pre-discovery) discovery state. */
export const NO_DISCOVERY: InboxDiscovery = { discovered: false };

/**
 * Discovery is usable only once it has SETTLED *and* belongs to the CURRENT
 * active storage — until both hold, the inbox listing must stay cold (it would
 * otherwise show the previous storage's inbox for the render between a storage
 * switch and the discovery effect re-running). Pure so it is directly testable.
 */
export function inboxDiscoveryReady(
  discovery: InboxDiscovery,
  status: string,
  webId: string | undefined,
  activeStorage: string | undefined,
): boolean {
  return (
    status === "logged-in" &&
    Boolean(webId) &&
    Boolean(activeStorage) &&
    discovery.discovered &&
    discovery.storage === activeStorage
  );
}

/**
 * The SWR cache key for the inbox listing. EMPTY (cold, no cache touch) until
 * discovery has settled FOR THE CURRENT STORAGE; then keyed per discovered inbox
 * URL (active-storage-dependent, so a storage switch changes the key and
 * revalidates against the new storage rather than painting the previous one). On
 * a settled-but-no-inbox storage, a storage-scoped sentinel caches the empty
 * list without colliding across storages. Pure so it is directly testable.
 */
export function inboxCacheKey(
  discovery: InboxDiscovery,
  status: string,
  webId: string | undefined,
  activeStorage: string | undefined,
): string {
  if (!inboxDiscoveryReady(discovery, status, webId, activeStorage)) return "";
  return discovery.inboxUrl ? `inbox:${discovery.inboxUrl}` : `inbox:none:${activeStorage}`;
}
