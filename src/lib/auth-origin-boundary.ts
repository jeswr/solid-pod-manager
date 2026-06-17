// AUTHORED-BY Claude Opus 4.8
/**
 * The CREDENTIAL-ORIGIN BOUNDARY — the pure, audited logic deciding which resource
 * origins a session's DPoP-bound token may be attached to, and classifying an RFC 9449
 * §8 `use_dpop_nonce` 401 challenge vs a genuinely-stale token.
 *
 * VENDORED (verbatim) from `@jeswr/solid-elements` `src/auth/index.ts` at pinned sha
 * `df0fbe4639e2cf79ad28bb0410483fb5ca3eb24c`
 * (https://github.com/jeswr/solid-elements/blob/df0fbe4/src/auth/index.ts) — the
 * `computeAllowedOrigins` / `isOriginAllowed` / `htuOf` / `isUseDpopNonceChallenge` /
 * `parseWwwAuthenticate` functions, copied byte-for-byte so the Pod Manager's
 * proactive-auth fetch wrapper (`proactive-auth-fetch.ts`) enforces the EXACT same,
 * already-roborev-reviewed origin boundary as the seam's own controller-owned fetch.
 *
 * WHY VENDOR INSTEAD OF IMPORT: `@jeswr/solid-elements/auth` is a SIDE-EFFECT-FREE
 * module, but it imports `@jeswr/solid-session-restore`, `@solid/object`, `dpop`,
 * `oauth4webapi` and `@solid/reactive-authentication` at the TOP LEVEL (peer deps), so
 * importing even one pure function loads (and would require us to install) all of them —
 * including a SECOND copy of `@solid/reactive-authentication` alongside our vendored
 * PR#11–14 tgz, which could re-patch `globalThis.fetch`. These five functions are
 * genuinely dependency-free, so the suite's "vendor a minimal typed client citing the
 * source" rule (AGENTS.md) applies.
 *
 * FOLLOW-UP (tracked): have `@jeswr/solid-elements` expose these from a
 * dependency-free subexport (e.g. `@jeswr/solid-elements/auth-boundary`) so consumers can
 * import the boundary without dragging the auth controller's transitive deps; then this
 * vendored copy is replaced by that import. Until then, keep this in sync with the source
 * sha above when the seam's boundary changes.
 *
 * GRANULARITY (deliberate, matching the seam): the boundary is ORIGIN-level, not
 * per-resource. On a SHARED-ORIGIN multi-pod server (e.g. CSS serving `https://pod.example/
 * alice/` and `…/bob/` from one origin) the session's token is attachable to the whole
 * origin, including another user's pod path. This is NOT a credential leak: it is the
 * USER'S OWN token going to their OWN pod server, which enforces Web Access Control per
 * request — sending a valid token to a resource the user may not access just yields 403,
 * exactly as a direct request would. It is also strictly TIGHTER than the prior
 * `ReactiveFetchManager`, which attached on ANY 401 to ANY URL with no origin gate at all.
 * Per-path/per-pod resource scoping would diverge from the audited seam for no security
 * gain on a WAC-enforcing server, so it is intentionally NOT added here. (Public discovery
 * / WebID-profile reads are kept out of this loop separately: the profile read uses the
 * provider's pristine fetch, and the wrapper's issuer-scoped OAuth bypass excludes the
 * OIDC endpoints — see `proactive-auth-fetch.ts`.)
 */

/** A loopback host (dev CSS over HTTP is the only `http:` we ever allow). */
const isLoopback = (host: string): boolean =>
  host === "localhost" || host === "127.0.0.1" || host === "[::1]";

/** How {@link computeAllowedOrigins} derives the default WebID/issuer origins. */
export interface AllowedOriginsInputs {
  /** Explicit allowed resource origins (any URL; compared by `origin`). */
  allowedOrigins?: string[];
  /** The authenticated WebID (its origin is included unless disabled). */
  webId?: string;
  /** The issuer URL (its origin is included unless disabled). */
  issuer?: string;
  /** Include the WebID's origin. Default true. */
  includeWebIdOrigin?: boolean;
  /** Include the issuer's origin. Default true. */
  includeIssuerOrigin?: boolean;
  /**
   * Allow `http:` origins for LOOPBACK hosts only (dev). Default false: every
   * non-`https:` origin is dropped, so the token is never attached over cleartext.
   */
  allowInsecureLoopback?: boolean;
}

/**
 * The set of resource origins a session token may be attached to — the credential
 * boundary the token provider enforces. PURE + exported so the boundary is
 * unit-tested. CLEARTEXT GUARD: a non-`https:` origin is DROPPED (so a configured
 * `http:` allowedOrigin can't make the DPoP token ride over cleartext), EXCEPT a
 * loopback `http:` origin when `allowInsecureLoopback` is set (dev). Fail-closed: an
 * unparseable entry is skipped; an empty result means the token is attached to NOTHING.
 */
export function computeAllowedOrigins(inputs: AllowedOriginsInputs): ReadonlySet<string> {
  const origins = new Set<string>();
  const add = (value: string | undefined): void => {
    if (!value) return;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return; // unparseable → not allowed (fail-closed)
    }
    if (url.protocol === "https:") {
      origins.add(url.origin);
    } else if (
      url.protocol === "http:" &&
      inputs.allowInsecureLoopback &&
      isLoopback(url.hostname)
    ) {
      origins.add(url.origin); // dev loopback only, under the explicit opt-in
    }
    // every other scheme (incl. non-loopback http) is dropped — no cleartext token
  };
  for (const o of inputs.allowedOrigins ?? []) add(o);
  if (inputs.includeWebIdOrigin !== false) add(inputs.webId);
  if (inputs.includeIssuerOrigin !== false) add(inputs.issuer);
  return origins;
}

/**
 * Whether a request URL targets an allowed origin (the per-request credential
 * gate). PURE + exported. Fail-closed: an unparseable URL is never allowed.
 */
export function isOriginAllowed(allowed: ReadonlySet<string>, requestUrl: string): boolean {
  try {
    return allowed.has(new URL(requestUrl).origin);
  } catch {
    return false;
  }
}

/**
 * The DPoP `htu` claim for a request URL — the request URI WITHOUT its query and
 * fragment (RFC 9449 §4.2). PURE + exported. If the URL is unparseable it is
 * returned unchanged (the proof generator then sees the raw string).
 */
export function htuOf(requestUrl: string): string {
  try {
    const u = new URL(requestUrl);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return requestUrl;
  }
}

/**
 * Whether a 401 response is a PURE DPoP-nonce challenge — i.e. its `WWW-Authenticate`
 * carries the DPoP scheme with `error="use_dpop_nonce"` (RFC 9449 §8). PURE + exported
 * for testing.
 *
 * This is deliberately CONSERVATIVE: it returns true ONLY when the server explicitly
 * says the token was fine and only the nonce was missing. Any OTHER error (e.g.
 * `invalid_token`, expired/revoked) — or no DPoP `error` token at all — returns false,
 * so the caller force-refreshes the access token instead of looping on a stale one even
 * when the server ALSO rotated the `DPoP-Nonce`. We match the `DPoP` auth-scheme
 * challenge specifically; a `Bearer …` challenge that happens to mention the string is
 * not treated as a DPoP nonce challenge.
 */
export function isUseDpopNonceChallenge(response: Response): boolean {
  const header = response.headers.get("WWW-Authenticate");
  if (!header) return false;
  // A `WWW-Authenticate` value can carry MULTIPLE challenges (RFC 9110 §11.6.1), e.g.
  // `Bearer error="invalid_token", DPoP error="use_dpop_nonce"`, and even MULTIPLE DPoP
  // challenges. We inspect ONLY the TOP-LEVEL `error` auth-param of the `DPoP` challenges —
  // reading `error=` from another scheme's challenge, or from INSIDE a quoted value, would
  // wrongly classify a DPoP `invalid_token` as a pure nonce challenge.
  //
  // UNAMBIGUOUS-NONCE rule (the roborev finding): return true only when the DPoP challenge
  // set is nonce-ONLY — at least one DPoP challenge says `use_dpop_nonce` AND no DPoP
  // challenge reports a DIFFERENT error. If ANY DPoP challenge carries a non-nonce error
  // (invalid_token / expired / revoked), the token may be stale, so we must NOT skip the
  // forced refresh — return false (force-refresh) even if another DPoP challenge mentions a
  // nonce.
  let sawNonce = false;
  for (const challenge of parseWwwAuthenticate(header)) {
    if (challenge.scheme.toLowerCase() !== "dpop") continue;
    const error = challenge.params.get("error")?.toLowerCase();
    if (error === undefined) continue; // a DPoP challenge with no error is not a signal
    if (error === "use_dpop_nonce") sawNonce = true;
    else return false; // a DPoP challenge with a DIFFERENT error → ambiguous → force refresh
  }
  return sawNonce;
}

/**
 * Parse a `WWW-Authenticate` header into its individual challenges, each with its scheme
 * and a QUOTE-AWARE map of its top-level auth-params. PURE + exported for testing.
 *
 * The grammar (RFC 9110 §11.6.1) is comma-ambiguous: commas separate BOTH auth-params
 * within a challenge AND challenges from each other; auth-params allow optional whitespace
 * around `=` (BWS); and a quoted value may itself contain commas/`=`/scheme-like words. We
 * scan character-by-character into ATOMS (a bare word, a quoted string, or a standalone
 * `=`), tracking quoted strings (with `\`-escapes), then walk the atoms: a `word [=] value`
 * triple (tolerating BWS) is an auth-param attributed to the current challenge; a lone word
 * NOT followed by `=` starts a NEW challenge (a scheme / token68). Param VALUES are unquoted
 * (quotes stripped, escapes resolved). Odd input degrades safely (the caller is
 * conservative — only an UNAMBIGUOUS DPoP `error="use_dpop_nonce"` is acted on).
 */
export function parseWwwAuthenticate(
  header: string,
): { scheme: string; params: Map<string, string> }[] {
  // ── Tokenise into atoms ──────────────────────────────────────────────────────────
  // Each atom is { kind: "word" | "quoted" | "eq", text }. Whitespace + commas separate
  // atoms (commas are not otherwise significant — challenge boundaries are inferred from
  // the word-not-followed-by-`=` rule, which is robust to the comma ambiguity). `=` OUTSIDE
  // quotes is its own atom so BWS around it (`error = "x"`) parses correctly.
  type Atom = { kind: "word" | "quoted"; text: string } | { kind: "eq" };
  const atoms: Atom[] = [];
  let buf = "";
  let bufIsQuoted = false;
  let inQuotes = false;
  const flush = () => {
    if (buf || bufIsQuoted) {
      atoms.push({ kind: bufIsQuoted ? "quoted" : "word", text: buf });
      buf = "";
      bufIsQuoted = false;
    }
  };
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (inQuotes) {
      if (c === "\\" && i + 1 < header.length) {
        buf += header[i + 1];
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        buf += c;
      }
      continue;
    }
    if (c === '"') {
      // A quoted string is ALWAYS a value atom (even if it abuts a preceding word with no
      // space). Flush any pending bare word first.
      flush();
      inQuotes = true;
      bufIsQuoted = true;
    } else if (c === "=") {
      flush();
      atoms.push({ kind: "eq" });
    } else if (c === "," || c === " " || c === "\t") {
      flush();
    } else {
      buf += c;
    }
  }
  flush();

  // ── Walk atoms into challenges ───────────────────────────────────────────────────
  const challenges: { scheme: string; params: Map<string, string> }[] = [];
  for (let i = 0; i < atoms.length; i++) {
    const atom = atoms[i];
    if (atom.kind === "eq") continue; // a stray `=` with no preceding key — ignore
    if (atom.kind === "quoted") {
      // A bare quoted string with no `key =` before it — not a valid challenge/param; skip.
      continue;
    }
    // A WORD: it is an auth-param key iff the NEXT non-trivial atom is `=`.
    if (atoms[i + 1]?.kind === "eq") {
      const valueAtom = atoms[i + 2];
      const value = valueAtom && valueAtom.kind !== "eq" ? valueAtom.text : "";
      if (challenges.length > 0) {
        challenges[challenges.length - 1].params.set(atom.text.toLowerCase(), value);
      }
      i += 2; // consume `= value`
    } else {
      // A lone word NOT followed by `=` → a scheme (or token68) starting a NEW challenge.
      challenges.push({ scheme: atom.text, params: new Map() });
    }
  }
  return challenges;
}
