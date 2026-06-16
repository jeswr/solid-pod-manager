// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * The PRISTINE, never-authenticated `fetch`.
 *
 * `@solid/reactive-authentication`'s `ReactiveFetchManager.registerGlobally()`
 * REPLACES `globalThis.fetch` with a wrapper that, on a `401`, re-issues the
 * request with Solid DPoP/bearer credentials (when a token provider matches the
 * request's host). That is exactly right for pod requests — and exactly WRONG
 * for third-party public hosts (matrix.org, forum.solidproject.org): we must
 * never risk attaching a pod credential to a non-pod host, nor pay the extra
 * unauthenticated round-trip the wrapper makes.
 *
 * So community-feed requests must use a `fetch` captured BEFORE that patch. The
 * patch is installed at runtime inside a React `useEffect` in the session
 * provider (after an async dynamic import); the route module that needs the
 * native fetch (`community-feeds.ts`) loads lazily, AFTER the patch — so reading
 * `globalThis.fetch` at that point would get the PATCHED one.
 *
 * The fix: {@link captureNativeFetch} is called at the very top of `layout.tsx`
 * (the root, evaluated at app boot, before `SessionProvider`'s effect runs), so
 * it records the genuine native `fetch`. It is idempotent — the FIRST capture
 * wins, so a later accidental call after the patch cannot overwrite the pristine
 * reference. Callers read {@link getNativeFetch}.
 */

let captured: typeof fetch | undefined;
let didCapture = false;

/**
 * Record the current `globalThis.fetch` as the pristine native fetch. Idempotent
 * — only the FIRST call captures; later calls are no-ops (so a call that happens
 * to run after the auth patch can never replace the good reference). Call this
 * once, as early as possible (top of the root layout), before any auth patch.
 */
export function captureNativeFetch(): void {
  if (didCapture) return;
  didCapture = true;
  if (typeof globalThis !== "undefined" && typeof globalThis.fetch === "function") {
    captured = globalThis.fetch.bind(globalThis);
  }
}

/**
 * The pristine native `fetch` captured at boot, or `undefined` if capture never
 * ran (e.g. SSR / non-browser). Callers fall back to the package default when
 * undefined — harmless on the server, where there is no global patch.
 */
export function getNativeFetch(): typeof fetch | undefined {
  return captured;
}
