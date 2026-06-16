// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

import { useSession } from "@/components/session-provider";
import { useSwrRead } from "@/components/use-swr-read";
import { freshRdf } from "@/lib/rdf-read";
import { profileDocUrl } from "@/lib/profile-edit";
import {
  listAllRegistrations,
  type ManagedTypeIndex,
} from "@/lib/type-index-manage";
import type { RevalidatableState } from "@/components/use-pod-data";

/**
 * Load the signed-in user's full type-index management view (public + private
 * registrations). Production paths pass NO `fetch` (auth-patched global runs).
 *
 * Stale-while-revalidate: the view goes through the shared {@link useSwrRead}
 * cache (keyed `type-index`), so navigating back to the page paints the
 * last-known registrations INSTANTLY and revalidates in the background; the
 * profile doc is watched so a type-index change there invalidates + refreshes.
 */
export function useTypeIndex(): RevalidatableState<ManagedTypeIndex> & {
  reload: () => void;
} {
  const { webId } = useSession();
  const { data, error, loading, revalidating, reload } =
    useSwrRead<ManagedTypeIndex>(
      "type-index",
      async (id) => {
        const { dataset } = await freshRdf(profileDocUrl(id));
        return listAllRegistrations(id, dataset);
      },
      // Watch the profile doc: a type-index registration change invalidates this.
      { topicUrl: webId ? profileDocUrl(webId) : undefined },
    );

  return { data, error, loading, revalidating, reload };
}
