// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect, vi } from "vitest";
import {
  isValidTargetUrl,
  assertValidTargetUrl,
  discoverInbox,
  resolveInboxTarget,
} from "./agent-target.js";
import { InvalidTargetError, NoInboxError } from "./errors.js";

const WEBID = "https://bob.example/profile/card#me";
const DOC = "https://bob.example/profile/card";

function ttl(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/turtle" } });
}

/** A profile fetch that serves `body` for the profile doc, 404 elsewhere. */
function profileFetch(body: string) {
  return vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === DOC) return ttl(body);
    return new Response("nf", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("assertValidTargetUrl / isValidTargetUrl — SSRF reject matrix", () => {
  it("accepts a normal https off-origin inbox", () => {
    expect(isValidTargetUrl("https://bob.example/inbox/")).toBe(true);
    expect(isValidTargetUrl("https://pod.other.tld/alice/inbox/")).toBe(true);
    expect(() => assertValidTargetUrl("https://bob.example/inbox/")).not.toThrow();
  });

  it("requires https — cleartext http is rejected (token-over-cleartext leak)", () => {
    // The auth-patched fetch attaches the user's DPoP token, so a POST target
    // MUST be https. http is a `bad-scheme` rejection even for a public host.
    expect(isValidTargetUrl("http://pod.example.tld/inbox/")).toBe(false);
    let reason = "";
    try {
      assertValidTargetUrl("http://pod.example.tld/inbox/");
    } catch (e) {
      reason = (e as InvalidTargetError).reason;
    }
    expect(reason).toBe("bad-scheme");
  });

  const blockedHosts = [
    "https://localhost/inbox/",
    "https://localhost:3000/inbox/",
    "https://foo.localhost/inbox/",
    "https://printer.local/inbox/",
    "https://127.0.0.1/inbox/",
    "https://127.5.5.5/inbox/",
    "https://10.0.0.1/inbox/",
    "https://10.255.255.255/inbox/",
    "https://172.16.0.1/inbox/",
    "https://172.31.255.255/inbox/",
    "https://192.168.1.1/inbox/",
    "https://169.254.0.1/inbox/",
    "https://169.254.169.254/latest/meta-data/", // cloud metadata
    "https://0.0.0.0/inbox/",
    "https://[::1]/inbox/",
    "https://[::]/inbox/",
    "https://[fc00::1]/inbox/", // unique-local
    "https://[fd12:3456::1]/inbox/", // fd.. is within fc00::/7
    "https://[fe80::1]/inbox/", // link-local
    "https://[::ffff:127.0.0.1]/inbox/", // IPv4-mapped loopback
    "https://[::ffff:192.168.0.1]/inbox/", // IPv4-mapped private
    // Trailing-dot (FQDN) blocklist-bypass variants — must still be blocked.
    "https://localhost./inbox/",
    "https://localhost.:3000/inbox/",
    "https://printer.local./inbox/",
    // Additional reserved IPv4 ranges (fail-closed gate denies all reserved).
    "https://100.64.0.1/inbox/", // CGNAT 100.64.0.0/10
    "https://100.127.255.255/inbox/",
    "https://192.0.0.1/inbox/", // 192.0.0.0/24
    "https://198.18.0.1/inbox/", // 198.18.0.0/15 benchmarking
    "https://198.19.255.255/inbox/",
    "https://255.255.255.255/inbox/", // broadcast
    "https://[fec0::1]/inbox/", // deprecated site-local
    "https://[64:ff9b::7f00:1]/inbox/", // NAT64 embedding 127.0.0.1
    "https://[2002:7f00:1::1]/inbox/", // 6to4 embedding 127.0.0.1
    // Multicast / reserved (224.0.0.0/4, 240.0.0.0/4).
    "https://224.0.0.1/inbox/",
    "https://240.0.0.1/inbox/",
    // Encoded-loopback forms — `new URL()` canonicalises these to 127.0.0.1, so
    // they must be blocked. This regression-locks the canonicalisation
    // assumption that the IPv4 string parser relies on (a load-bearing SSRF
    // defence: if a runtime parsed hosts differently this would silently open).
    "https://2130706433/inbox/", // integer form of 127.0.0.1
    "https://0x7f.0.0.1/inbox/", // hex first octet
    "https://0177.0.0.1/inbox/", // octal first octet
    "https://0x7f000001/inbox/", // hex integer form
    // Known cloud-metadata hostnames (resolve to 169.254.169.254).
    "https://metadata.google.internal/computeMetadata/",
    "https://metadata.google.internal./computeMetadata/", // trailing dot
    // Dotless / single-label hosts resolve to intranet via search domains.
    "https://wiki/inbox/",
    "https://router/inbox/",
    "https://intranet:8080/inbox/",
  ];
  it.each(blockedHosts)("rejects blocked host %s", (url) => {
    expect(isValidTargetUrl(url)).toBe(false);
    expect(() => assertValidTargetUrl(url)).toThrowError(InvalidTargetError);
  });

  it("does NOT block a public host that merely resembles a private one", () => {
    // 172.15.x and 172.32.x are NOT in 172.16.0.0/12.
    expect(isValidTargetUrl("https://172.15.0.1/inbox/")).toBe(true);
    expect(isValidTargetUrl("https://172.32.0.1/inbox/")).toBe(true);
    // 11.x and 192.169.x are public.
    expect(isValidTargetUrl("https://11.0.0.1/inbox/")).toBe(true);
    expect(isValidTargetUrl("https://192.169.0.1/inbox/")).toBe(true);
    // A public IPv6 (documentation range 2001:db8::) is not in any blocked range.
    expect(isValidTargetUrl("https://[2001:db8::1]/inbox/")).toBe(true);
    // 100.128.x is above the CGNAT 100.64.0.0/10 block → public.
    expect(isValidTargetUrl("https://100.128.0.1/inbox/")).toBe(true);
    // 100.63.x is below the CGNAT block → public.
    expect(isValidTargetUrl("https://100.63.255.255/inbox/")).toBe(true);
    // 6to4 embedding a PUBLIC v4 (8.8.8.8 → 2002:0808:0808::) is allowed.
    expect(isValidTargetUrl("https://[2002:808:808::1]/inbox/")).toBe(true);
  });

  it("rejects credentials-in-URL (userinfo)", () => {
    expect(isValidTargetUrl("https://user@bob.example/inbox/")).toBe(false);
    expect(isValidTargetUrl("https://user:pass@bob.example/inbox/")).toBe(false);
    let reason = "";
    try {
      assertValidTargetUrl("https://user:pass@bob.example/inbox/");
    } catch (e) {
      reason = (e as InvalidTargetError).reason;
    }
    expect(reason).toBe("has-credentials");
  });

  it("rejects non-http(s) schemes", () => {
    for (const u of [
      "ftp://bob.example/inbox/",
      "file:///etc/passwd",
      "ws://bob.example/inbox/",
      "javascript:alert(1)",
      "data:text/plain,hi",
    ]) {
      expect(isValidTargetUrl(u)).toBe(false);
    }
  });

  it("rejects non-absolute / unparseable URLs", () => {
    expect(isValidTargetUrl("/inbox/")).toBe(false);
    expect(isValidTargetUrl("not a url")).toBe(false);
    expect(isValidTargetUrl("")).toBe(false);
  });

  it("carries a machine-readable reason for each rejection class", () => {
    const reasonOf = (u: string) => {
      try {
        assertValidTargetUrl(u);
        return "ok";
      } catch (e) {
        return (e as InvalidTargetError).reason;
      }
    };
    expect(reasonOf("/inbox/")).toBe("not-absolute");
    expect(reasonOf("ftp://bob.example/x")).toBe("bad-scheme");
    expect(reasonOf("https://u:p@bob.example/x")).toBe("has-credentials");
    expect(reasonOf("https://127.0.0.1/x")).toBe("blocked-host");
  });
});

describe("discoverInbox — discovery is ONLY from the profile graph", () => {
  it("reads ldp:inbox via a typed accessor off the WebID subject", async () => {
    const body = `
      @prefix ldp: <http://www.w3.org/ns/ldp#> .
      <${WEBID}> ldp:inbox <https://bob.example/inbox/> .`;
    await expect(discoverInbox(WEBID, profileFetch(body))).resolves.toBe(
      "https://bob.example/inbox/",
    );
  });

  it("resolves a relative ldp:inbox against the profile document URL", async () => {
    const body = `
      @prefix ldp: <http://www.w3.org/ns/ldp#> .
      <${WEBID}> ldp:inbox </inbox/> .`;
    await expect(discoverInbox(WEBID, profileFetch(body))).resolves.toBe(
      "https://bob.example/inbox/",
    );
  });

  it("returns undefined when the profile advertises no inbox", async () => {
    const body = `
      @prefix foaf: <http://xmlns.com/foaf/0.1/> .
      <${WEBID}> foaf:name "Bob" .`;
    await expect(discoverInbox(WEBID, profileFetch(body))).resolves.toBeUndefined();
  });

  it("returns undefined when the profile is unreadable", async () => {
    const failing = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(discoverInbox(WEBID, failing)).resolves.toBeUndefined();
  });

  it("returns undefined (never throws) for a malformed ldp:inbox (literal object)", async () => {
    const body = `
      @prefix ldp: <http://www.w3.org/ns/ldp#> .
      <${WEBID}> ldp:inbox "not-a-node" .`;
    await expect(discoverInbox(WEBID, profileFetch(body))).resolves.toBeUndefined();
  });

  it("returns undefined for an opaque-redirect on the discovery GET (browser semantics)", async () => {
    // Mirrors the real browser: redirect:manual yields an opaque-redirect that
    // freshRdf cannot parse → discovery collapses to undefined (never follows it).
    const fetchImpl = (async () => {
      // The Fetch API forbids `new Response(null, { status: 0 })` (the
      // constructor only accepts 200–599), so build a valid Response and
      // override the readonly fields to match real opaque-redirect semantics
      // (type "opaqueredirect", status 0, ok false) — this exercises the
      // redirect-not-followed path rather than a constructor throw.
      const r = new Response(null, { status: 200 });
      Object.defineProperty(r, "type", { value: "opaqueredirect" });
      Object.defineProperty(r, "status", { value: 0 });
      Object.defineProperty(r, "ok", { value: false });
      return r;
    }) as unknown as typeof fetch;
    await expect(discoverInbox(WEBID, fetchImpl)).resolves.toBeUndefined();
  });

  it("ignores an inbox advertised by a DIFFERENT subject (only the WebID's own)", async () => {
    const body = `
      @prefix ldp: <http://www.w3.org/ns/ldp#> .
      <https://attacker.example/x#me> ldp:inbox <https://attacker.example/inbox/> .`;
    await expect(discoverInbox(WEBID, profileFetch(body))).resolves.toBeUndefined();
  });

  it("returns undefined (never throws) when MULTIPLE ldp:inbox values are advertised", async () => {
    const body = `
      @prefix ldp: <http://www.w3.org/ns/ldp#> .
      <${WEBID}> ldp:inbox <https://bob.example/inbox/>, <https://bob.example/inbox2/> .`;
    // Ambiguous — we never guess, and OptionalFrom-style cardinality must not throw.
    await expect(discoverInbox(WEBID, profileFetch(body))).resolves.toBeUndefined();
  });

  it("does NOT fetch the profile when the WebID host is private/loopback (GET token-leak guard)", async () => {
    const fetched: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return ttl(`<x> <y> "z" .`);
    }) as unknown as typeof fetch;
    // A loopback WebID must never be GET'd with the auth-patched fetch.
    await expect(
      discoverInbox("http://127.0.0.1:3000/alice/profile/card#me", fetchImpl),
    ).resolves.toBeUndefined();
    await expect(
      discoverInbox("https://169.254.169.254/profile#me", fetchImpl),
    ).resolves.toBeUndefined();
    // A cleartext http public WebID is also refused (token-over-cleartext guard).
    await expect(
      discoverInbox("http://public.example/profile/card#me", fetchImpl),
    ).resolves.toBeUndefined();
    expect(fetched).toHaveLength(0); // no profile fetch issued at all
  });

  it("forces redirect:manual on the discovery GET and does not follow a 3xx", async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      if (url === DOC) {
        // The discovery read MUST force redirect:manual (GET-side leak guard).
        expect(init?.redirect).toBe("manual");
        return new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/profile" },
        });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    // A 3xx on the profile GET → no inbox discovered, and the redirect target is
    // never fetched.
    await expect(discoverInbox(WEBID, fetchImpl)).resolves.toBeUndefined();
    expect(requested.some((u) => u.includes("169.254.169.254"))).toBe(false);
  });
});

describe("resolveInboxTarget — discover + validate, fail closed", () => {
  it("returns a validated inbox for a normal off-origin profile", async () => {
    const body = `
      @prefix ldp: <http://www.w3.org/ns/ldp#> .
      <${WEBID}> ldp:inbox <https://bob.example/inbox/> .`;
    await expect(resolveInboxTarget(WEBID, profileFetch(body))).resolves.toEqual({
      inbox: "https://bob.example/inbox/",
    });
  });

  it("throws NoInboxError when no inbox is advertised", async () => {
    const body = `<${WEBID}> <http://xmlns.com/foaf/0.1/name> "Bob" .`;
    await expect(resolveInboxTarget(WEBID, profileFetch(body))).rejects.toBeInstanceOf(
      NoInboxError,
    );
  });

  it("throws InvalidTargetError when the discovered inbox is a private/loopback host", async () => {
    // Discovery from the profile yields a loopback inbox → strict validator rejects.
    const body = `
      @prefix ldp: <http://www.w3.org/ns/ldp#> .
      <${WEBID}> ldp:inbox <http://127.0.0.1:9999/inbox/> .`;
    // freshRdf will resolve the absolute inbox; the doc fetch host is bob.example.
    const fetchImpl = profileFetch(body);
    await expect(resolveInboxTarget(WEBID, fetchImpl)).rejects.toBeInstanceOf(InvalidTargetError);
  });
});
