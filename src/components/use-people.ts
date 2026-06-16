// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

import { useCallback } from "react";
import { useSession } from "@/components/session-provider";
import { useSwrRead } from "@/components/use-swr-read";
import { CONTACTS_SLUG, contactsStore } from "@/lib/contacts";
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
 * {@link useSwrRead} cache, keyed PER ACTIVE STORAGE (`people:<activeStorage>`),
 * so navigating back to a picker paints the last-known people INSTANTLY and
 * revalidates in the background. The fetcher reads the contacts store from
 * `activeStorage`, so the key MUST carry it — keying the static `people` would
 * keep the same `(webId, key)` across a SAME-WebID storage switch and never
 * revalidate, painting the previous storage's contacts (roborev finding). The
 * profile doc AND the active storage's contacts container are watched so a
 * friend/contact change invalidates + refreshes it.
 */
export function usePeople(): RevalidatableState<PersonOption[]> & {
  reload: () => void;
} {
  // `webId` is supplied to the fetcher as its argument by `useSwrRead` (the
  // active WebID), so we only need `activeStorage` from the session here.
  const { activeStorage } = useSession();

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

  // The active storage's contacts container is the active-storage-dependent
  // resource the picker reads contacts from; watch it so a live contact
  // add/edit/remove invalidates + refreshes this view. (Friend changes on the
  // profile doc are still picked up on re-nav / reload, which re-reads both.)
  const contactsContainer = activeStorage
    ? new URL(CONTACTS_SLUG, activeStorage).toString()
    : undefined;

  const { data, error, loading, revalidating, reload } = useSwrRead<PersonOption[]>(
    activeStorage ? `people:${activeStorage}` : "people",
    fetcher,
    { topicUrl: contactsContainer },
  );

  return { data, error, loading, revalidating, reload };
}
