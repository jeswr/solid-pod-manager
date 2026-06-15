// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Drive the "Assigned to me" federation view: gather the inputs `lib/`
 * `discoverAssignedTasks` needs (the user's profile dataset for `foaf:knows`,
 * and the WebIDs of saved contacts) and run discovery against the active
 * session. Production paths pass NO `fetch` — the auth-patched global runs
 * (AGENTS.md §Reading data); the trust model lives entirely in `lib/`.
 */
import { useCallback, useEffect, useState } from "react";
import { useSession } from "@/components/session-provider";
import { freshRdf } from "@/lib/rdf-read";
import { readProfile } from "@/lib/profile";
import { contactsStore } from "@/lib/contacts";
import { discoverAssignedTasks, type AssignedTask } from "@/lib/federation-tasks";
import type { AsyncState } from "@/components/use-pod-data";

/**
 * List the tasks assigned to the logged-in user across their own pods and the
 * pods of authorized agents (friends + contacts). Re-runs on login / storage
 * switch; `reload` re-fetches.
 */
export function useAssignedTasks(): AsyncState<AssignedTask[]> & { reload: () => void } {
  const { webId, activeStorage, status } = useSession();
  const [state, setState] = useState<AsyncState<AssignedTask[]>>({ loading: true });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (status !== "logged-in" || !webId || !activeStorage) {
      setState({ loading: true });
      return;
    }
    let cancelled = false;
    setState({ loading: true });

    (async () => {
      // The profile dataset carries `foaf:knows` (authorized friend assigners)
      // and the type-index links; fetch it fresh so a just-added friend counts.
      const { dataset } = await freshRdf(webId);
      const myProfile = readProfile(webId, dataset);

      // Saved contacts that carry a WebID are also authorized assigners.
      const contacts = await contactsStore({ podRoot: activeStorage, webId }).list();
      const contactWebIds = contacts
        .map((c) => c.data.webId)
        .filter((w): w is string => Boolean(w));

      const tasks = await discoverAssignedTasks({
        myWebId: webId,
        myProfile,
        myProfileDataset: dataset,
        contactWebIds,
      });
      if (!cancelled) setState({ loading: false, data: tasks });
    })().catch((e: unknown) => {
      if (!cancelled) {
        setState({ loading: false, error: e instanceof Error ? e : new Error(String(e)) });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [webId, activeStorage, status, nonce]);

  return { ...state, reload };
}
