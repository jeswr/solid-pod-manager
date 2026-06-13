// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Cross-pod target validation — THE SECURITY HEART of Wave 6 collaboration.
 *
 * Every prior wave was SAME-POD: reads/writes stayed inside the user's own
 * storage, guarded by `pod-scope.ts` (`isWithinPod` / `isInOwnPods`). Wave 6 is
 * the first time the app POSTs to ANOTHER agent's pod (an LDN inbox), so a brand
 * new attack surface opens: SSRF / confused-deputy / token-leak.
 *
 * WHY THIS IS DANGEROUS. The app's global `fetch` is auth-patched: a 401 from a
 * request triggers an `upgrade()` that attaches the user's DPoP-bound access
 * token AND a fresh DPoP proof minted for the *requested URL*, then retries. So
 * if we ever POST to an attacker-chosen origin (a loopback admin port, a cloud
 * metadata endpoint, a private-range host on the user's LAN, or any host that
 * answers 401), we hand that origin the user's bearer token + a matching proof —
 * a classic confused-deputy. `pod-scope.ts` prevents this for same-pod reads by
 * requiring same-origin; cross-pod sends are *legitimately* off-origin, so we
 * CANNOT reuse `sameOrigin`/`isWithinPod`. This module is the substitute
 * defence: a strict allow-by-shape / deny-by-host validator applied to the
 * DISCOVERED inbox URL BEFORE any POST.
 *
 * TWO INVARIANTS, both enforced here:
 *   1. The inbox is DISCOVERED FROM THE RECIPIENT'S PROFILE (`ldp:inbox` read
 *      through a typed `@rdfjs/wrapper` accessor), never taken from user
 *      free-text. A user can pick a *person* (a WebID); they can never type the
 *      POST target directly.
 *   2. The discovered URL is STRICTLY VALIDATED ({@link assertValidTargetUrl})
 *      before any authenticated request touches it. Fail closed.
 *
 * All RDF/IO lives here in `src/lib` (house rule); discovery reads RDF via
 * typed accessors only (never regex on RDF).
 *
 * RESIDUAL GAPS (documented so reviewers don't over-trust the validator):
 *   - **DNS rebinding.** The validator inspects the host *string* only. A public
 *     DNS name in a recipient profile (e.g. `https://evil.example/inbox/`) that
 *     RESOLVES to `127.0.0.1` / `169.254.169.254` passes the name check, and the
 *     browser `fetch` then connects to the private address. There is no DNS
 *     pinning available to `fetch` in a browser, so this cannot be closed
 *     client-side; it is an accepted residual risk. (A server-side relay with
 *     DNS-pinning — see the prod-solid-server `solid-auth` skill's webidResolver
 *     — would be the place to close it.)
 *   - **Redirects.** A validated public inbox host could answer a POST with a
 *     3xx to a private host. That is handled in `notify-send.ts` by issuing the
 *     POST with `redirect: "manual"` and refusing to follow cross-target 3xx
 *     (the auth-patched fetch must never be transparently bounced to a blocked
 *     origin). This module validates the *initial* target only.
 */
import { TermWrapper, SetFrom, NamedNodeAs, NamedNodeFrom } from "@rdfjs/wrapper";
import { DataFactory } from "n3";
import { freshRdf } from "./rdf-read.js";
import { profileDocUrl } from "./profile-edit.js";
import { InvalidTargetError, NoInboxError, type InvalidTargetReason } from "./errors.js";

/** The LDP inbox predicate. `@solid/object`'s `Agent` does not expose it. */
const LDP_INBOX = "http://www.w3.org/ns/ldp#inbox";

/**
 * A typed view of an agent's profile subject that exposes `ldp:inbox`.
 *
 * `@solid/object`'s `Agent` deliberately does not surface `ldp:inbox` (it is a
 * power-user pointer, see `profile-edit.ts`), so we read it ourselves through a
 * typed `@rdfjs/wrapper` accessor on the WebID subject — never a regex/string
 * match on the serialised RDF (house rule).
 */
class InboxAgent extends TermWrapper {
  /**
   * All `ldp:inbox` values advertised by this subject. A `Set` (not an
   * `Optional`) so a malformed profile that advertises MULTIPLE inboxes does
   * NOT throw — discovery must fail gracefully into the documented
   * `NoInboxError` contract, never leak a raw cardinality error to the UI.
   */
  get inboxes(): Set<string> {
    return SetFrom.subjectPredicate(this, LDP_INBOX, NamedNodeAs.string, NamedNodeFrom.string);
  }
}

/**
 * Wrap a fetch (the injected one, or the auth-patched global when omitted) so
 * every request forces `redirect: "manual"`. This preserves the auth patching
 * (we still call the same underlying fetch) while ensuring a 3xx is never
 * transparently followed to a new — possibly private — origin. A caller-supplied
 * `redirect` is overridden (manual wins) on purpose: this is a security guard.
 *
 * Used by BOTH the discovery GET and the notification POST so the redirect guard
 * is enforced at the OUTERMOST layer — independent of whether the auth layer's
 * internal 401-retry reconstructs `init` and preserves the `redirect` option.
 */
export function noFollowFetch(fetchImpl?: typeof fetch): typeof fetch {
  const base = fetchImpl ?? fetch;
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    base(input, { ...init, redirect: "manual" })) as typeof fetch;
}

/**
 * Discover a recipient's LDN inbox from THEIR PROFILE.
 *
 * Fetches the WebID profile document (revalidated, via `freshRdf` like
 * `profile.ts`) and reads `ldp:inbox` off the WebID subject through a typed
 * accessor. The value is resolved relative to the WebID document URL (the RDF
 * may carry a relative IRI). Returns `undefined` when the profile is unreadable
 * or advertises no inbox — the caller treats `undefined` as "no inbox".
 *
 * SECURITY: the inbox comes ONLY from the profile graph, never from any
 * caller-supplied string. TWO token-leak guards apply here:
 *   - The PROFILE FETCH itself is guarded: the auth-patched global `fetch`
 *     attaches the user's DPoP token on a 401 retry, so GETting a profile whose
 *     WebID host is loopback/private/metadata would leak the token on the GET
 *     side. We therefore run the profile DOCUMENT URL through the same strict
 *     validator BEFORE fetching, and skip discovery (return `undefined`) if the
 *     WebID host is unsafe. (Local-dev loopback WebIDs are pickable but cannot
 *     be cross-pod discovery targets — consistent with the POST-target rule.)
 *   - The returned inbox URL is NOT yet validated; callers MUST pass it through
 *     {@link assertValidTargetUrl} (or use {@link resolveInboxTarget}) before
 *     POSTing.
 *
 * A profile advertising MULTIPLE `ldp:inbox` values is ambiguous and yields
 * `undefined` (we never guess which one is authoritative), and never throws.
 *
 * INTEROP NOTE: because the discovery GET refuses to follow redirects (the
 * security guard above), a recipient pod that serves its profile document via a
 * redirect (http→https canonicalisation, trailing-slash, or a 303/307 to a
 * canonical card URL) is NOT discoverable and presents as "no inbox". This is an
 * accepted security/interop tradeoff for the authenticated discovery path.
 *
 * @param fetchImpl - test-only override; **omit in production** so the
 *   auth-patched global fetch runs (AGENTS.md §Reading data).
 */
export async function discoverInbox(
  webId: string,
  fetchImpl?: typeof fetch,
): Promise<string | undefined> {
  let docUrl: string;
  try {
    docUrl = profileDocUrl(webId);
  } catch {
    return undefined; // not a parseable WebID URL
  }
  // GET-side token-leak guards. The auth-patched fetch attaches the user's
  // DPoP-bound token on a 401 retry, so the discovery GET must be as safe as the
  // POST target:
  //   - HTTPS-only: a cleartext http profile would expose the token to a MITM on
  //     the 401 retry (production WebIDs are https per AGENTS.md; local-dev http
  //     WebIDs are pickable but are not valid cross-pod discovery targets).
  //   - host not loopback/private/metadata: a 401 there would leak token/proof.
  if (!isValidTargetUrl(docUrl)) return undefined;

  // GET-side redirect guard (mirrors the POST path in notify-send): the recipient
  // pod is attacker-influenceable, so a public WebID host could 3xx the profile
  // GET to a private host that answers 401, and the auth-patched fetch would then
  // attach the user's token/proof to the redirected request. We force
  // `redirect: "manual"` on the discovery read and refuse to follow — `freshRdf`
  // sees an opaque-redirect (not ok) and throws, which we collapse to undefined.
  const guardedFetch = noFollowFetch(fetchImpl);

  let dataset: import("@rdfjs/types").DatasetCore;
  try {
    ({ dataset } = await freshRdf(docUrl, guardedFetch));
  } catch {
    // Profile unreadable → no inbox we can discover. NOTE: this collapses a
    // transient/5xx fetch failure into the same `undefined` as a genuinely
    // absent profile, so `resolveInboxTarget` reports `NoInboxError` for both.
    // That is an accepted simplification at this layer — the spec's contract is
    // "return undefined if absent/unreadable" — and the discovery is best-effort
    // (the user picks a person, not a guarantee the pod is reachable). A future
    // refinement could surface a distinct retryable error for non-404 failures.
    return undefined;
  }
  const inboxes = new InboxAgent(webId, dataset, DataFactory).inboxes;
  // Zero → no inbox; multiple → ambiguous, refuse to guess (fail closed).
  if (inboxes.size !== 1) return undefined;
  const [raw] = [...inboxes];
  // Resolve a possibly-relative inbox IRI against the profile DOCUMENT URL
  // (the RDF base), matching how a Solid client resolves relative terms.
  try {
    return new URL(raw, docUrl).toString();
  } catch {
    return undefined;
  }
}

/**
 * Parse an IPv4 dotted-quad string into its four octets, or `undefined` if it is
 * not a strict dotted-quad (each part 0–255, no leading-zero ambiguity issues
 * are irrelevant since we only block ranges — but we require exactly four
 * numeric parts in 0–255).
 */
function parseIpv4(host: string): [number, number, number, number] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    octets.push(n);
  }
  return octets as [number, number, number, number];
}

/**
 * True for an IPv4 address inside a private / loopback / link-local /
 * unspecified / reserved range that should never be a cross-pod POST target.
 * Since this is the fail-closed outbound gate and the host is a literal IP we
 * can deny precisely at the string level, we block well beyond RFC 1918:
 * loopback, link-local, CGNAT shared space, benchmarking, multicast and the
 * reserved/future 240.0.0.0/4 (incl broadcast). Encoded host forms (integer /
 * hex / octal) are canonicalised to dotted-decimal by `new URL()` before this
 * runs, so they are covered too (regression-locked in the test). The residual
 * DNS-rebinding gap is documented separately; that is the part we cannot close
 * in-browser.
 */
function isBlockedIpv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl 169.254.169.254 metadata)
  if (a === 0) return true; // 0.0.0.0/8 "this host" / unspecified
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT / shared address space
  if (a === 192 && b === 0 && octets[2] === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved (incl 255.255.255.255 broadcast)
  return false;
}

/** Parse 1–4 hex digits into a 16-bit group; `undefined` if malformed. */
function hexGroup(g: string): number | undefined {
  if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
  return parseInt(g, 16);
}

/**
 * Expand a (de-bracketed) IPv6 host into its 8 16-bit groups, or `undefined` if
 * it is not a parseable IPv6 literal. Handles `::` zero-compression and a
 * trailing embedded IPv4 (e.g. `::ffff:127.0.0.1` → groups 6/7 from the v4).
 */
function parseIpv6(host: string): number[] | undefined {
  // Drop a zone id (`%eth0`); brackets are stripped by the caller.
  const pct = host.indexOf("%");
  const h = pct === -1 ? host : host.slice(0, pct);
  if (!h.includes(":")) return undefined;
  if (h.indexOf("::") !== h.lastIndexOf("::")) return undefined; // at most one ::

  // Turn the head and (optional) tail-after-:: into group-string arrays. A
  // trailing embedded IPv4 becomes two 16-bit groups appended to whichever side
  // it sits on.
  const expandSide = (side: string): number[] | "err" => {
    if (side === "") return [];
    const tokens = side.split(":");
    const out: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.includes(".")) {
        // Only the final token may be an embedded IPv4.
        if (i !== tokens.length - 1) return "err";
        const v4 = parseIpv4(tok);
        if (!v4) return "err";
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        const n = hexGroup(tok);
        if (n === undefined) return "err";
        out.push(n);
      }
    }
    return out;
  };

  const dc = h.indexOf("::");
  if (dc === -1) {
    const groups = expandSide(h);
    if (groups === "err" || groups.length !== 8) return undefined;
    return groups;
  }

  const head = expandSide(h.slice(0, dc));
  const tail = expandSide(h.slice(dc + 2));
  if (head === "err" || tail === "err") return undefined;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return undefined;
  return [...head, ...Array(fill).fill(0), ...tail];
}

/** Split two 16-bit IPv6 groups into the four octets of an embedded IPv4. */
function embeddedV4(hi: number, lo: number): [number, number, number, number] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

/** True for an IPv6 address that is loopback / unspecified / ULA / link-local / mapped-blocked-v4. */
function isBlockedIpv6(groups: number[]): boolean {
  const allZeroExceptLast = groups.slice(0, 7).every((g) => g === 0);
  if (allZeroExceptLast && groups[7] === 1) return true; // ::1 loopback
  if (groups.every((g) => g === 0)) return true; // :: unspecified
  // fc00::/7 unique-local (first group's top 7 bits === 0xfc00 >> 9 i.e. 0b1111110)
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  // fec0::/10 deprecated site-local (legacy private scope) — block for parity.
  if ((groups[0] & 0xffc0) === 0xfec0) return true;
  // IPv4-mapped (::ffff:a.b.c.d) → groups[0..4]=0, groups[5]=0xffff
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    return isBlockedIpv4(embeddedV4(groups[6], groups[7]));
  }
  // IPv4-compatible (deprecated): ::a.b.c.d with high groups zero.
  if (groups.slice(0, 6).every((g) => g === 0) && (groups[6] !== 0 || groups[7] !== 0)) {
    return isBlockedIpv4(embeddedV4(groups[6], groups[7]));
  }
  // NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 in the last 32 bits;
  // in a NAT64 environment it translates to that v4, so decode + re-check.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return isBlockedIpv4(embeddedV4(groups[6], groups[7]));
  }
  // 6to4 (2002::/16) embeds the IPv4 in groups[1..2]; decode + re-check.
  if (groups[0] === 0x2002) {
    return isBlockedIpv4(embeddedV4(groups[1], groups[2]));
  }
  return false;
}

/**
 * Normalise a URL host into the bare hostname (strips IPv6 brackets) and
 * lower-cases it for name comparisons.
 */
function bareHost(hostname: string): string {
  let h = hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  // Strip a fully-qualified trailing dot: `localhost.` / `printer.local.`
  // resolve identically to the dot-less form, so a trailing dot is a classic
  // blocklist bypass — normalise it away before any name/IP check.
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** Well-known cloud-metadata hostnames that statically resolve to 169.254.169.254. */
const BLOCKED_METADATA_NAMES = new Set([
  "metadata.google.internal", // GCP
  "metadata.goog",
  // NB: the bare "metadata" short form is already covered by the dotless-host
  // rule in isBlockedName, so it is intentionally not duplicated here.
]);

/**
 * True when a hostname is a blocked name: the `localhost` / `.localhost` /
 * `.local` families, and the statically-known cloud-metadata hostnames (these
 * resolve to the 169.254.169.254 metadata IP, so denying them by name closes
 * the name-based variant of that SSRF — the broader resolve-to-private case
 * remains the documented DNS-rebinding residual).
 */
function isBlockedName(host: string): boolean {
  if (host === "localhost") return true;
  if (host.endsWith(".localhost")) return true;
  if (host === "local" || host.endsWith(".local")) return true;
  if (BLOCKED_METADATA_NAMES.has(host)) return true;
  // Dotless / single-label hosts (`wiki`, `router`, `intranet`) almost always
  // resolve to an intranet address via the resolver's search domain — a classic
  // SSRF blocklist-bypass. A legitimate cross-pod recipient pod is always an
  // FQDN, so reject any name with no dot. (IP literals are handled separately.)
  if (!host.includes(".")) return true;
  return false;
}

/**
 * True if a URL's HOST is in a blocked range/name — independent of scheme.
 * Used both by the full target validator and by the discovery GET guard (which
 * must block private hosts but does not impose the https-only POST-target rule
 * on a profile read).
 */
function isBlockedHostUrl(url: string | URL): boolean {
  let u: URL;
  try {
    u = typeof url === "string" ? new URL(url) : url;
  } catch {
    return true; // unparseable → treat as unsafe
  }
  const host = bareHost(u.hostname);
  if (host === "") return true;
  // IP literals first (an IPv6 literal contains ':' and no '.', so it must not
  // be caught by the dotless-name rule in isBlockedName).
  const v4 = parseIpv4(host);
  if (v4) return isBlockedIpv4(v4);
  const v6 = parseIpv6(host);
  if (v6) return isBlockedIpv6(v6);
  if (isBlockedName(host)) return true;
  return false; // a normal DNS name
}

/**
 * The reject reason for a candidate target URL, or `undefined` if it is safe.
 *
 * REJECT LIST (fail-closed, evaluated in order):
 *   - `not-absolute`  — not a parseable absolute URL.
 *   - `bad-scheme`    — scheme other than `https:`. We require HTTPS (not just
 *     http(s)): the auth-patched global `fetch` attaches the user's DPoP-bound
 *     access token, so a cross-pod request over cleartext `http:` would expose
 *     that token to a network MITM. HTTPS-only for the authenticated outbound
 *     gate; there is no dev-http escape hatch (local-dev pods are not valid
 *     cross-pod targets anyway — see the localhost/loopback host block).
 *   - `has-credentials` — any userinfo present (`url.username`/`url.password`),
 *     which could carry a confusing/attacker-controlled credential.
 *   - `blocked-host`  — a name or IP in a loopback / private / link-local /
 *     metadata / unique-local / reserved range, including IPv4-mapped IPv6 forms
 *     and trailing-dot FQDN variants (normalised in `bareHost`):
 *       names: `localhost`, `*.localhost`, `local`, `*.local`, dotless
 *              single-label hosts (`wiki`, `router`, …), and known cloud
 *              metadata hostnames (`metadata.google.internal`, …)
 *       IPv4 : 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
 *              169.254.0.0/16 (incl 169.254.169.254 cloud metadata), 0.0.0.0/8,
 *              100.64.0.0/10 (CGNAT), 192.0.0.0/24, 198.18.0.0/15, 255.255.255.255
 *       IPv6 : ::1, ::, fc00::/7, fe80::/10, fec0::/10, ::ffff:<blocked-v4>,
 *              ::<blocked-v4>
 *
 * NOTE on dev/localhost WebIDs: `people-search.looksLikeWebId` intentionally
 * ALLOWS localhost so a developer can PICK a local dev WebID. That is fine for
 * choosing a person. But this validator is the POST *target* gate, and the spec
 * requires it to reject localhost/private-IP inbox targets — so a local dev pod
 * cannot be used as a cross-pod delivery target. Kept strict and documented.
 */
function targetRejectReason(url: string): InvalidTargetReason | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not-absolute";
  }
  if (u.protocol !== "https:") return "bad-scheme"; // HTTPS-only (token over cleartext is a leak)
  if (u.username !== "" || u.password !== "") return "has-credentials";
  if (isBlockedHostUrl(u)) return "blocked-host"; // reuse the parsed URL (no re-parse)
  // A normal https off-origin recipient pod — allowed.
  return undefined;
}

/**
 * Throw {@link InvalidTargetError} unless `url` is a safe cross-pod POST target.
 * The single chokepoint applied to every discovered inbox URL BEFORE any
 * authenticated POST (see {@link resolveInboxTarget} and `notify-send.ts`).
 */
export function assertValidTargetUrl(url: string): void {
  const reason = targetRejectReason(url);
  if (reason) throw new InvalidTargetError(url, reason);
}

/** Boolean form of {@link assertValidTargetUrl} (for tests / pre-checks). */
export function isValidTargetUrl(url: string): boolean {
  return targetRejectReason(url) === undefined;
}

/**
 * Discover AND strictly validate a recipient's inbox in one step.
 *
 * @throws NoInboxError      when the profile advertises no `ldp:inbox`.
 * @throws InvalidTargetError when the discovered inbox fails the strict
 *   outbound validator (so the UI can show "that inbox address isn't safe").
 *
 * On success the returned `inbox` has passed {@link assertValidTargetUrl} and is
 * safe to POST to.
 */
export async function resolveInboxTarget(
  webId: string,
  fetchImpl?: typeof fetch,
): Promise<{ inbox: string }> {
  const inbox = await discoverInbox(webId, fetchImpl);
  if (!inbox) throw new NoInboxError(webId);
  assertValidTargetUrl(inbox); // fail closed before any POST happens
  return { inbox };
}
