// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

import { useCallback } from "react";
import { useSession } from "@/components/session-provider";
import { useSwrRead } from "@/components/use-swr-read";
import { contactsStore } from "@/lib/contacts";
import { readKnows } from "@/lib/social";
import { freshRdf } from "@/lib/rdf-read";
import { profileDocUrl } from "@/lib/profile-edit";
import { buildPeopleOptions, type PersonOption } from "@/lib/people-search";
import type { RevalidatableState } from "@/components/use-pod-data";

/**
 * Load the user's pickable people — saved contacts (that carry a WebID) merged
 * with their `foaf:knows` friends — as a sorted, de-duplicated option list for
 * the people-picker. Production paths pass NO `fetch` (the auth-patched global
 * runs).
 *
 * Stale-while-revalidate: the option list goes through the shared
 * {@link useSwrRead} cache (keyed `people`), so navigating back to a picker
 * paints the last-known people INSTANTLY and revalidates in the background; the
 * profile doc is watched so a friend/contact change invalidates + refreshes it.
 */
export function usePeople(): RevalidatableState<PersonOption[]> & {
  reload: () => void;
} {
  const { webId, activeStorage } = useSession();

  // The fetcher captures `activeStorage` (the pod whose contacts we read) from
  // the closure — `useSwrRead` keeps the freshest fetcher each render, so a
  // storage switch re-runs against the new pod. `webId` arrives as the argument.
  const fetcher = useCallback(
    async (id: string): Promise<PersonOption[]> => {
      if (!activeStorage) return [];
      const store = contactsStore({ podRoot: activeStorage, webId: id });
      // Contacts with a WebID, and the profile-card friends, in parallel.
      const [items, friends] = await Promise.all([
        store.list().catch(() => []),
        (async () => {
          try {
            const { dataset } = await freshRdf(profileDocUrl(id));
            return readKnows(id, dataset);
          } catch {
            return [] as string[];
          }
        })(),
      ]);
      const contacts = items
        .map((i) => ({ webId: i.data.webId ?? "", name: i.data.fn, email: i.data.email }))
        .filter((c) => c.webId);
      return buildPeopleOptions({ contacts, friends });
    },
    [activeStorage],
  );

  const { data, error, loading, revalidating, reload } = useSwrRead<PersonOption[]>(
    "people",
    fetcher,
    // Watch the profile doc: a friend/contact change there invalidates this.
    { topicUrl: webId ? profileDocUrl(webId) : undefined },
  );

  return { data, error, loading, revalidating, reload };
}
