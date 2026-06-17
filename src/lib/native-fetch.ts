// AUTHORED-BY Claude Opus 4.8
/**
 * The PRISTINE native `fetch`, snapshotted at MODULE LOAD — before
 * `@solid/reactive-authentication` (or our own proactive-auth wrapper, see
 * `proactive-auth-fetch.ts`) patches `globalThis.fetch`.
 *
 * Two consumers rely on this being credential-free and out of the reactive-auth
 * loop (AGENTS.md §Foreign-origin fetch):
 *   - the proactive-auth wrapper uses it as the BASE fetch it attaches the DPoP
 *     token onto, so the authenticated path never chains through a
 *     possibly-already-patched global (a credential-boundary breach — this is the
 *     same reasoning the `@jeswr/solid-elements` auth seam documents for its own
 *     controller-owned fetch);
 *   - any THIRD-PARTY-origin read (a WebID index, a forum, Matrix) must use this
 *     with `credentials: "omit"` so the reactive global's 401→DPoP retry can never
 *     reach a foreign origin.
 *
 * The module-evaluation order guarantee: this module is imported (and so the
 * snapshot taken) at the top of `session-provider.tsx`, which is the single owner
 * of the global patch and only installs it AFTER the auth module is loaded. So the
 * captured reference is the browser's untouched `fetch`.
 *
 * Under SSR / a non-DOM environment with no `fetch`, the snapshot is a last-resort
 * rejecting fetch — it is never silently a patched global.
 */

/** The captured pristine fetch (bound to its realm), or a rejecting stub if none. */
export const nativeFetch: typeof fetch =
  typeof globalThis !== "undefined" && typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : (((() =>
        Promise.reject(
          new Error("No native fetch available in this environment"),
        )) as unknown) as typeof fetch);
