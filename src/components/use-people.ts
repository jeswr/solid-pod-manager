// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "@/components/session-provider";
import { contactsStore } from "@/lib/contacts";
import { readKnows } from "@/lib/social";
import { freshRdf } from "@/lib/rdf-read";
import { profileDocUrl } from "@/lib/profile-edit";
import {
  buildPeopleOptions,
  type PersonOption,
} from "@/lib/people-search";
import type { AsyncState } from "@/components/use-pod-data";

/**
 * Load the user's pickable people — saved contacts (that carry a WebID) merged
 * with their `foaf:knows` friends — as a sorted, de-duplicated option list for
 * the people-picker. Production paths pass NO `fetch` (the auth-patched global
 * runs). Re-loads on login / storage switch.
 */
export function usePeople(): AsyncState<PersonOption[]> & { reload: () => void } {
  const { webId, activeStorage, status } = useSession();
  const [state, setState] = useState<AsyncState<PersonOption[]>>({ loading: true });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const store = useMemo(() => {
    if (status !== "logged-in" || !webId || !activeStorage) return undefined;
    return contactsStore({ podRoot: activeStorage, webId });
  }, [status, webId, activeStorage]);

  useEffect(() => {
    if (!store || !webId) {
      setState({ loading: true });
      return;
    }
    let cancelled = false;
    setState({ loading: true });

    (async () => {
      // Contacts with a WebID, and the profile-card friends, in parallel.
      const [items, friends] = await Promise.all([
        store.list().catch(() => []),
        (async () => {
          try {
            const { dataset } = await freshRdf(profileDocUrl(webId));
            return readKnows(webId, dataset);
          } catch {
            return [] as string[];
          }
        })(),
      ]);
      if (cancelled) return;
      const contacts = items
        .map((i) => ({ webId: i.data.webId ?? "", name: i.data.fn, email: i.data.email }))
        .filter((c) => c.webId);
      setState({ loading: false, data: buildPeopleOptions({ contacts, friends }) });
    })().catch((e: unknown) => {
      if (!cancelled) {
        setState({ loading: false, error: e instanceof Error ? e : new Error(String(e)) });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [store, webId, nonce]);

  return { ...state, reload };
}
