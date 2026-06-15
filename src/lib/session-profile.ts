// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * session-profile.ts — the PURE, testable profile-load lifecycle that sits
 * BEHIND a logged-in session.
 *
 * The session-restore fix (see {@link ./session-restore.ts}) correctly stopped
 * gating "logged in" on the cosmetic profile read: a returning user with a valid
 * refresh-token grant is logged-in regardless of a transient profile blip, and
 * must NOT be bounced to the login screen. But the previous code then *swallowed*
 * a profile failure into a silent incomplete state — `logged-in` with `profile`
 * and `activeStorage` undefined and no error/retry — so storage/profile-dependent
 * surfaces rendered against `undefined` with no recourse.
 *
 * This module makes the profile load an EXPLICIT three-state outcome so the shell
 * can render a degraded, retryable state instead of crashing or silently showing
 * empty data:
 *
 *   • "loading" — the load is in flight (transient; not represented here, owned
 *      by the caller before it awaits {@link loadProfileState}).
 *   • "ready"   — the profile loaded; `profile` + the chosen `activeStorage` set.
 *   • "error"   — the load failed; `profile`/`activeStorage` stay null, an `error`
 *      is exposed, and the caller offers a retry. The session itself STAYS
 *      logged-in throughout (a profile failure never drops to login).
 *
 * Pure except for the injected `loadProfile` (the one fetch), so the lifecycle is
 * unit-testable without a browser — mirroring {@link ./session-restore.ts}.
 */
import type { PodProfile } from "./profile.js";

/** The explicit, observable state of the post-login profile load. */
export type ProfileStatus = "loading" | "ready" | "error";

/** A resolved profile-load outcome (the terminal `ready`/`error` states). */
export type ProfileLoadResult =
  | {
      readonly status: "ready";
      readonly profile: PodProfile;
      /** The storage to browse (the first advertised; the UI may re-pick). */
      readonly activeStorage: string | undefined;
    }
  | {
      readonly status: "error";
      /** Why the profile load failed — surfaced to the user with a retry. */
      readonly error: Error;
    };

/** The injected profile fetch (production wires {@link ./profile.fetchProfile}). */
export type LoadProfile = (webId: string) => Promise<PodProfile>;

/**
 * Run the (cosmetic) profile load for an already-authenticated WebID and report
 * an EXPLICIT terminal state. Never throws: a failed load resolves to
 * `{ status: "error" }` (with the cause) rather than propagating — the caller
 * keeps the session `logged-in` and offers a retry. The session is real
 * regardless of this outcome; only `profile`/`activeStorage` depend on it.
 *
 * `activeStorage` is the first `pim:storage` the profile advertises (the UI lets
 * the user re-pick when there are several). When the profile advertises none it
 * stays `undefined`, exactly as before — the difference from the bug is that this
 * is now a `ready` profile with no storage, not a silent `undefined` with no
 * status.
 */
export async function loadProfileState(
  webId: string,
  loadProfile: LoadProfile,
): Promise<ProfileLoadResult> {
  try {
    const profile = await loadProfile(webId);
    return { status: "ready", profile, activeStorage: profile.storages[0] };
  } catch (e) {
    return {
      status: "error",
      error: e instanceof Error ? e : new Error(String(e)),
    };
  }
}
