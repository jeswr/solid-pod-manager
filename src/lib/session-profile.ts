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
 * Decide whether to CLEAR the currently-exposed `profile`/`activeStorage` as a
 * new profile load enters `"loading"`.
 *
 * This guards the interactive account switch. When the user switches from
 * WebID A (with A's `profile`/`activeStorage` exposed) to WebID B, the provider
 * marks the session `logged-in` for B *before* B's profile resolves. If A's
 * `profile`/`activeStorage` were left in place during B's load, children would
 * briefly observe `status: "logged-in"` for B's WebID paired with A's storage —
 * so a page that guards only on `activeStorage` could read or act on the wrong
 * pod. Clearing on an actual WebID change closes that window: B's loading state
 * exposes no storage/profile at all until B's own resolve.
 *
 * A SAME-WebID load (the `retryProfile()` path, or the very first load for a
 * WebID that has no exposed profile yet) must NOT blank an already-good profile
 * — that would flash the UI empty on a retry. So the rule is precisely "clear
 * iff the load is for a DIFFERENT WebID than the one whose profile is currently
 * exposed". When nothing is exposed yet (`exposedWebId` is undefined) there is
 * nothing to clear regardless.
 *
 * @param loadingWebId  the WebID whose profile load is now entering "loading".
 * @param exposedWebId  the WebID the currently-set `profile`/`activeStorage`
 *   belong to, or `undefined` when none is exposed (logged-out, or mid-load).
 */
export function shouldClearOnSwitch(
  loadingWebId: string,
  exposedWebId: string | undefined,
): boolean {
  return exposedWebId !== undefined && exposedWebId !== loadingWebId;
}

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
