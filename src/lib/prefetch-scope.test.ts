// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * HOOK-LEVEL guard for the `usePrefetch` SESSION-SCOPE KEY (PM #65 Phase 2).
 *
 * `usePrefetch` builds a session-scope key in TWO places — the once-per-scope
 * `warmedFor` guard AND the `isCurrent` session-race guard's `liveKeyRef`. The
 * `isCurrent` guard works ONLY if those two strings are built IDENTICALLY: it
 * holds (`true`) exactly when `liveKeyRef.current === warmKey`. A delimiter (or
 * any) drift between the two sites would make that comparison NEVER hold for the
 * current session, so `runPrefetch` would short-circuit and warm NOTHING — the
 * guard silently disabling all prefetching. (This regression actually happened:
 * a stray NUL delimiter in one site vs a space in the other — roborev caught it.)
 *
 * The fix routes BOTH sites through the single {@link scopeKey} builder, so they
 * cannot diverge. These tests pin that contract directly on the builder (the node
 * Vitest env has no React renderer — same approach as instant-nav*.test.ts):
 * for the SAME logged-in identity the two derivations are byte-identical and
 * non-empty (=> `isCurrent` is true on the happy path), and a session change
 * yields a DIFFERENT key (=> `isCurrent` flips false — the guard fires).
 */

import { describe, expect, it } from "vitest";
import { decidePrefetch, scopeKey } from "./prefetch-scope.js";

const WEBID = "https://alice.example/profile#me";
const STORAGE = "https://alice.example/storage/";
const OTHER_WEBID = "https://eve.example/profile#me";
const STORAGE_B = "https://alice.example/storage-b/";

describe("usePrefetch scopeKey: built ONE way (isCurrent never silently disables prefetch)", () => {
  it("HAPPY PATH: liveKey and warmKey are byte-identical + non-empty for the same logged-in session", () => {
    // The hook derives `liveKeyRef.current` (live) and `warmKey` (scheduled-for)
    // from the SAME inputs via THIS builder. They MUST be equal + non-empty, so
    // `isCurrent()` (liveKey === warmKey) is TRUE for the current session and
    // production prefetch actually warms (the bug roborev found was these two
    // diverging — a NUL vs a space — disabling prefetch entirely).
    const liveKey = scopeKey("logged-in", WEBID, STORAGE);
    const warmKey = scopeKey("logged-in", WEBID, STORAGE);
    expect(liveKey).toBe(warmKey);
    expect(liveKey).not.toBe("");
    // No control/NUL byte snuck into the delimiter (the EXACT regression roborev
    // caught — a NUL in one site, a space in the other): the only whitespace
    // is the single space delimiter between the WebID and the storage.
    expect(liveKey, "scope key must contain no control/NUL bytes").not.toMatch(
      /[\u0000-\u001f]/,
    );
    expect(liveKey.split(" "), "exactly one space delimiter").toHaveLength(2);
    // The key encodes BOTH the WebID and the active storage (scope is whole).
    expect(liveKey).toContain(WEBID);
    expect(liveKey).toContain(STORAGE);
  });

  it("a WebID change yields a DIFFERENT key → isCurrent flips false (account-switch race)", () => {
    const scheduledFor = scopeKey("logged-in", WEBID, STORAGE);
    expect(scopeKey("logged-in", OTHER_WEBID, STORAGE)).not.toBe(scheduledFor);
  });

  it("an active-storage change yields a DIFFERENT key → isCurrent flips false (storage-switch race)", () => {
    const scheduledFor = scopeKey("logged-in", WEBID, STORAGE);
    expect(scopeKey("logged-in", WEBID, STORAGE_B)).not.toBe(scheduledFor);
  });

  it("logging out yields the EMPTY key → never equals any scheduled scope (logout race)", () => {
    const scheduledFor = scopeKey("logged-in", WEBID, STORAGE);
    expect(scopeKey("logged-out", WEBID, STORAGE)).toBe("");
    expect(scopeKey("loading", WEBID, STORAGE)).toBe("");
    // A logged-out live key can never match the live-session scope it was
    // scheduled for, so a warm-up resolving after logout is suppressed.
    expect(scopeKey("logged-out", WEBID, STORAGE)).not.toBe(scheduledFor);
  });

  it("no-WebID (logged-in but identity not yet resolved) → EMPTY key", () => {
    expect(scopeKey("logged-in", undefined, STORAGE)).toBe("");
  });

  it("no-storage is a DISTINCT, stable scope (warms the WebID-scoped targets; re-warms once storage lands)", () => {
    const noStorage = scopeKey("logged-in", WEBID, undefined);
    expect(noStorage).not.toBe("");
    // Deterministic + idempotent: the same inputs always build the same key, so
    // the once-per-scope `warmedFor` guard does not re-fire on every render.
    expect(noStorage).toBe(scopeKey("logged-in", WEBID, undefined));
    // And it differs from the with-storage scope, so storage landing re-warms.
    expect(noStorage).not.toBe(scopeKey("logged-in", WEBID, STORAGE));
  });
});

/**
 * `decidePrefetch` — the once-per-scope guard logic, including the logout-RESET
 * roborev flagged (Medium): `usePrefetch` stays MOUNTED on the logged-out screen,
 * so a logout that clears the cache must also clear `warmedFor`, or a re-login to
 * the SAME account reproduces the same scope key and the "already warmed" check
 * skips the warm-up — leaving the freshly-cleared session COLD. We drive the
 * decision as a pure reducer over `(prevWarmedFor, warmKey)` to pin the full
 * lifecycle without a React renderer.
 */
describe("usePrefetch decidePrefetch: once-per-scope, but RESET across logout (re-login re-warms)", () => {
  const scopeA = scopeKey("logged-in", WEBID, STORAGE);
  const scopeB = scopeKey("logged-in", OTHER_WEBID, STORAGE);

  it("first login (no prior scope) → WARMS and records the scope", () => {
    expect(decidePrefetch(undefined, scopeA)).toEqual({ shouldWarm: true, nextWarmedFor: scopeA });
  });

  it("re-render within the SAME session → does NOT re-warm (idempotent)", () => {
    expect(decidePrefetch(scopeA, scopeA)).toEqual({ shouldWarm: false, nextWarmedFor: scopeA });
  });

  it("account / storage switch (a NEW non-empty scope) → re-WARMS for the new scope", () => {
    expect(decidePrefetch(scopeA, scopeB)).toEqual({ shouldWarm: true, nextWarmedFor: scopeB });
  });

  it("logout (empty scope) → never warms AND RESETS warmedFor to undefined", () => {
    // The hook stays mounted; an empty live scope must clear the guard so the
    // next login re-warms (logout cleared the cache).
    expect(decidePrefetch(scopeA, "")).toEqual({ shouldWarm: false, nextWarmedFor: undefined });
  });

  it("THE ROBOREV SCENARIO: login(A) → logout → login(A) again RE-WARMS the cleared cache", () => {
    // 1. Login to A: warms, records scope(A).
    const afterLogin = decidePrefetch(undefined, scopeA);
    expect(afterLogin.shouldWarm).toBe(true);
    expect(afterLogin.nextWarmedFor).toBe(scopeA);

    // 2. Logout (cache cleared): the hook is still mounted; the guard must reset.
    const afterLogout = decidePrefetch(afterLogin.nextWarmedFor, "");
    expect(afterLogout.shouldWarm).toBe(false);
    expect(afterLogout.nextWarmedFor, "logout must reset the once-per-scope guard").toBeUndefined();

    // 3. Log back into the SAME account: must WARM again (the cache is cold). With
    //    the old (buggy) `warmKey===prev` skip this returned false — the bug.
    const afterRelogin = decidePrefetch(afterLogout.nextWarmedFor, scopeA);
    expect(
      afterRelogin.shouldWarm,
      "re-login to the same account after logout must re-warm the cleared cache",
    ).toBe(true);
    expect(afterRelogin.nextWarmedFor).toBe(scopeA);
  });
});
