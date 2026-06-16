// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Browser shim for `node:net`'s `isIP`, for the static export build.
 *
 * `@jeswr/federation-client`'s inlined SSRF guard (`createGuardedFetch`)
 * statically imports `{ isIP } from "node:net"` to classify whether a host is an
 * IP literal (the only `node:net` symbol it needs — its `node:dns/promises`
 * lookup is a LAZY import gated behind a Node-only `hasNodeDns()` check). PM is a
 * pure browser static export (`output: "export"`), where `node:net` does not
 * exist, so webpack fails to bundle it. This module provides a faithful,
 * dependency-free `isIP` so the guard's IP-literal classification works
 * identically in the browser; `next.config.ts` aliases `node:net` to it for the
 * client bundle (additively).
 *
 * `isIP(input)` returns `4` for an IPv4 string, `6` for an IPv6 string, and `0`
 * otherwise — exactly Node's contract (see Node docs). The federation-client
 * guard relies only on these three return values.
 *
 * FOLLOW-UP (tracked): the real fix is upstream — `@jeswr/federation-client`'s
 * SSRF guard should not pull `node:net` into a browser bundle (and should offer a
 * browser-safe DNS-less mode). Filed as a PSS-agent issue; this shim is the local
 * unblock per the AGENTS.md "vendor + contribute back" rule.
 */

/** Strict dotted-quad IPv4 (0–255 per octet, no leading zeros beyond a single 0). */
function isIPv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    // Reject leading zeros ("01", "007") to match common IPv4 strictness; "0" is ok.
    if (part.length > 1 && part[0] === "0") return false;
    const n = Number(part);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

/**
 * IPv6 validation covering the forms Node's `isIP` accepts: full 8-group,
 * `::`-compressed, and IPv4-mapped tails (e.g. `::ffff:127.0.0.1`). Conservative
 * but faithful for the SSRF guard's purpose (classify private/loopback ranges).
 */
function isIPv6(value: string): boolean {
  const v = value;
  if (v.length === 0 || !v.includes(":")) return false;
  // At most one "::" compression.
  const doubleColon = v.match(/::/g);
  if (doubleColon && doubleColon.length > 1) return false;

  // Split off an optional IPv4-mapped tail (last group is dotted-quad).
  let head = v;
  let hasV4Tail = false;
  const lastColon = v.lastIndexOf(":");
  const tail = v.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!isIPv4(tail)) return false;
    hasV4Tail = true;
    head = v.slice(0, lastColon + 1); // keep the trailing ":" for group counting
  }

  const compressed = head.includes("::");
  // Remove the "::" for group parsing; track groups on each side.
  const groups = head.replace("::", ":").split(":").filter((g) => g.length > 0);
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return false;
  }
  // An IPv4 tail counts as two 16-bit groups.
  const groupCount = groups.length + (hasV4Tail ? 2 : 0);
  if (compressed) {
    // "::" stands in for one or more zero groups, so the explicit count must be
    // strictly under the full 8.
    return groupCount <= 7;
  }
  return groupCount === 8;
}

/**
 * Node's `net.isIP` contract: `4` for IPv4, `6` for IPv6, `0` otherwise. The only
 * `node:net` export `@jeswr/federation-client`'s SSRF guard uses.
 */
export function isIP(input: string): 0 | 4 | 6 {
  if (typeof input !== "string") return 0;
  if (isIPv4(input)) return 4;
  if (isIPv6(input)) return 6;
  return 0;
}

// Mirror node:net's shape just enough for the named import the SDK uses.
const netShim = { isIP };
export default netShim;
