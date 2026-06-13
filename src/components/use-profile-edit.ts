// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "@/components/session-provider";
import {
  fetchEditableProfile,
  saveProfile,
  type EditableProfile,
} from "@/lib/profile-edit";
import type { AsyncState } from "@/components/use-pod-data";

/**
 * Load the signed-in user's editable profile fields + the card's ETag.
 * Production paths pass NO `fetch` (the auth-patched global runs). Re-loads on
 * login. The returned `etag` is fed back into {@link saveProfile} for the
 * conditional write.
 */
export function useEditableProfile(): AsyncState<{
  profile: EditableProfile;
  etag: string | null;
}> & { reload: () => void } {
  const { webId, status } = useSession();
  const [state, setState] = useState<
    AsyncState<{ profile: EditableProfile; etag: string | null }>
  >({ loading: true });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (status !== "logged-in" || !webId) {
      setState({ loading: true });
      return;
    }
    let cancelled = false;
    setState({ loading: true });
    fetchEditableProfile(webId)
      .then(({ profile, etag }) => {
        if (!cancelled) setState({ loading: false, data: { profile, etag } });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState({ loading: false, error: e instanceof Error ? e : new Error(String(e)) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [webId, status, nonce]);

  return { ...state, reload };
}

export { saveProfile };
