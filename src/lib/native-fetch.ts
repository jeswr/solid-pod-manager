// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * The PRISTINE, never-authenticated `fetch` — a single source of truth for the
 * foreign-origin (third-party) fetch boundary used by BOTH consumers: the
 * WebID-index people-search (`webid-index.ts`) and the Solid Community feeds
 * (`community-feeds.ts`).
 *
 * Why this exists (a real security boundary): `@solid/reactive-authentication`'s
 * `ReactiveFetchManager.registerGlobally()` REPLACES `globalThis.fetch` with a
 * wrapper that, on a `401`, runs `provider.upgrade()` and RE-ISSUES the request
 * with the user's Solid DPoP/bearer credentials (when a token provider matches
 * the request's host). That is exactly right for pod requests — and exactly
 * WRONG for THIRD-PARTY public hosts (matrix.org, forum.solidproject.org, the
 * WebID index): a 401 from such a host would otherwise trigger an attempt to
 * attach the user's pod credential to that foreign origin (and pay an extra
 * unauthenticated round-trip). `credentials:"omit"` ALONE does NOT prevent the
 * patched wrapper's upgrade/retry behaviour — only a fetch reference captured
 * BEFORE the patch does.
 *
 * The patch is installed at RUNTIME inside a React `useEffect` in the session
 * provider (after an async dynamic import). A route chunk that needs the native
 * fetch (`community-feeds.ts`) loads lazily, AFTER the patch — so reading
 * `globalThis.fetch` at that point would get the PATCHED one. The fix is to
 * snapshot `globalThis.fetch` EARLY, before the patch, and hand that pristine
 * reference to every foreign-origin caller.
 *
 * How capture is timed (defeats the timing hazard two ways, belt-and-braces):
 *   1. This module's TOP-LEVEL code captures at module-evaluation time. ES module
 *      top-level runs when the module is first imported; `session-provider.tsx`
 *      imports it (in the eager root chunk) BEFORE its runtime effect calls
 *      `registerGlobally()`. So `nativeFetch` is the bare native fetch.
 *   2. `captureNativeFetch()` lets the boot path capture EXPLICITLY and is
 *      IDEMPOTENT — the FIRST capture wins, so a later accidental call (e.g. one
 *      that happens to run after the auth patch) can NEVER overwrite the good
 *      reference.
 *
 * Both the `nativeFetch` const and `getNativeFetch()` resolve to the SAME backing
 * `captured` reference — there is never a second, uncoordinated snapshot.
 *
 * Use this for any request to an origin the app must NOT authenticate to.
 */

let captured: typeof globalThis.fetch | undefined;
let didCapture = false;

/**
 * Record the current `globalThis.fetch` as the pristine native fetch. Idempotent
 * — only the FIRST call captures; later calls are no-ops (so a call that happens
 * to run after the auth patch can never replace the good reference). Safe to call
 * eagerly at app boot (top of the root layout / session-provider module eval),
 * before any auth patch. Returns the captured reference (or `undefined` in a
 * non-`fetch` environment, e.g. SSR).
 */
export function captureNativeFetch(): typeof globalThis.fetch | undefined {
  if (didCapture) return captured;
  didCapture = true;
  if (
    typeof globalThis !== "undefined" &&
    typeof globalThis.fetch === "function"
  ) {
    captured = globalThis.fetch.bind(globalThis);
  }
  return captured;
}

/**
 * The pristine native `fetch` captured at boot, or `undefined` if capture never
 * ran (e.g. SSR / non-browser). Callers fall back to the package default when
 * undefined — harmless on the server, where there is no global patch. This is the
 * SAME reference as {@link nativeFetch} (both read the single `captured` backing).
 */
export function getNativeFetch(): typeof globalThis.fetch | undefined {
  return captured;
}

/**
 * The native `fetch`, bound to the global object, snapshotted before any auth
 * patch — a named-export alias of the captured reference for call sites that read
 * it directly (the WebID-index client factory). Resolves to the SAME `captured`
 * reference as {@link getNativeFetch}, never a second uncoordinated snapshot.
 * `undefined` only in a non-`fetch` environment (it never is in the browser or
 * Node 24); callers fall back to `globalThis.fetch` in that case.
 *
 * Captured here at MODULE-EVALUATION time: importing this module is itself
 * sufficient to take the snapshot, which is why an eager `import "./native-fetch"`
 * (or any consumer's static import) captures the pre-patch fetch.
 */
export const nativeFetch: typeof globalThis.fetch | undefined =
  captureNativeFetch();
