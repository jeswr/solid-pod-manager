// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Drive the "Assigned to me" federation view: gather the inputs `lib/`
 * `discoverAssignedTasks` needs (the user's profile dataset for `foaf:knows`,
 * and the WebIDs of saved contacts) and run discovery against the active
 * session. Production paths pass NO `fetch` — the auth-patched global runs
 * (AGENTS.md §Reading data); the trust model lives entirely in `lib/`.
 *
 * Stale-while-revalidate (offline-first first-paint): this goes through the
 * shared {@link useSwrRead} cache (keyed {@link ASSIGNED_TASKS_KEY}), so
 * navigating away and back — or a COLD OPEN / app reopen (the durable snapshot)
 * — paints the last-known assigned list INSTANTLY and revalidates in the
 * background, instead of re-running the full profile→contacts→cross-pod
 * discovery chain behind a spinner every time. The cache is WebID-scoped and the
 * pod root is watched so a change anywhere invalidates + refreshes.
 *
 * The model carries a real `Date` (`AssignedTask.task.created`), so its durable
 * key registers the {@link file://../lib/durable-cache.ts dateRevivingCodec} —
 * the cached snapshot hydrates type-faithfully (Dates, not ISO strings) on a
 * cold open. The TRUST/verification model is NOT touched: the cache stores only
 * what `discoverAssignedTasks` already verified and returned, so a hydrated
 * snapshot can never surface a task the backend would not have surfaced fresh.
 */
import { useCallback } from "react";
import { useSession } from "@/components/session-provider";
import { useSwrRead } from "@/components/use-swr-read";
import { freshRdf } from "@/lib/rdf-read";
import { readProfile } from "@/lib/profile";
import { contactsStore } from "@/lib/contacts";
import { discoverAssignedTasks, type AssignedTask } from "@/lib/federation-tasks";
import type { RevalidatableState } from "@/components/use-pod-data";

/**
 * The SWR / durable cache key for the assigned-tasks model. MUST stay in sync
 * with the `assigned-tasks` codec entry in {@link file://../lib/durable-cache.ts}
 * — they are two ends of the same persisted snapshot.
 */
export const ASSIGNED_TASKS_KEY = "assigned-tasks";

/**
 * List the tasks assigned to the logged-in user across their own pods and the
 * pods of authorized agents (friends + contacts), with stale-while-revalidate
 * caching. Re-runs on login / storage switch and on a pod-root notification;
 * `reload` forces a fresh revalidation.
 */
export function useAssignedTasks(): RevalidatableState<AssignedTask[]> & { reload: () => void } {
  const { activeStorage } = useSession();

  // The fetcher captures `activeStorage` (the pod whose contacts we read) from
  // the closure — `useSwrRead` keeps the freshest fetcher each render, so a
  // storage switch re-runs against the new pod. `webId` arrives as the argument.
  const fetcher = useCallback(
    async (webId: string): Promise<AssignedTask[]> => {
      if (!activeStorage) return [];
      // The profile dataset carries `foaf:knows` (authorized friend assigners)
      // and the type-index links; fetch it fresh so a just-added friend counts.
      const { dataset } = await freshRdf(webId);
      const myProfile = readProfile(webId, dataset);

      // Saved contacts that carry a WebID are also authorized assigners.
      const contacts = await contactsStore({ podRoot: activeStorage, webId }).list();
      const contactWebIds = contacts
        .map((c) => c.data.webId)
        .filter((w): w is string => Boolean(w));

      // The trust gating lives entirely in `discoverAssignedTasks`: only verified,
      // owner-write-only-sourced tasks come back. We do not filter here — and we
      // must not — so the cache never weakens the security model.
      return discoverAssignedTasks({
        myWebId: webId,
        myProfile,
        myProfileDataset: dataset,
        contactWebIds,
      });
    },
    [activeStorage],
  );

  // Until a storage is known, read nothing (an empty key is a no-op in useSwrRead)
  // so we never cache an empty list under a half-initialised session.
  const key = activeStorage ? ASSIGNED_TASKS_KEY : "";
  const { data, error, loading, revalidating, reload } = useSwrRead<AssignedTask[]>(key, fetcher, {
    // Watch the pod root so an edit/add/delete anywhere invalidates + refreshes.
    topicUrl: activeStorage,
  });

  return { data, error, loading, revalidating, reload };
}
