// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * A snapshot of the platform-native, UNPATCHED `fetch`, captured at module-load
 * time — BEFORE Solid auth patches `globalThis.fetch`.
 *
 * Why this exists (a real security boundary): the session provider calls
 * `ReactiveFetchManager.registerGlobally()`, which reassigns
 * `globalThis.fetch = manager.fetch`. That patched fetch, on a 401, runs
 * `provider.upgrade()` and re-attaches the user's DPoP credentials to the
 * request before retrying. For requests to a THIRD-PARTY origin (the WebID
 * index), that is exactly what must NOT happen — a 401 from the index would
 * otherwise trigger an attempt to attach the user's DPoP token to that foreign
 * origin. `credentials:"omit"` alone does not prevent the patched wrapper's
 * upgrade/retry behaviour.
 *
 * Capturing `globalThis.fetch` at MODULE-EVALUATION time defeats the timing
 * hazard: ES module top-level code runs when the module is first imported, which
 * — because this module is imported by `session-provider.tsx` (in the eager root
 * chunk) — happens BEFORE the session provider's runtime effect calls
 * `registerGlobally()`. So this reference is the bare native fetch, never the
 * auth wrapper, regardless of when a lazy route chunk that uses it loads later.
 *
 * Use this for any request to an origin the app must NOT authenticate to (the
 * WebID index, other public third-party Linked-Data surfaces).
 */

/**
 * The native `fetch`, bound to the global object, snapshotted before any auth
 * patch. `undefined` only in a non-`fetch` environment (it never is in the
 * browser or Node 24); callers fall back to `globalThis.fetch` in that case.
 */
export const nativeFetch: typeof globalThis.fetch | undefined =
  typeof globalThis !== "undefined" && typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : undefined;
