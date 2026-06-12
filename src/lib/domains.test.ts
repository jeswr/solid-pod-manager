import { describe, expect, it } from "vitest";
import {
  claimDomain,
  describeState,
  DomainConflictError,
  DomainNotFoundError,
  DomainQuotaError,
  DomainsAuthError,
  DomainsUnavailableError,
  DomainValidationError,
  domainsApiBase,
  getDomain,
  isApexDomain,
  isPollableState,
  listDomains,
  releaseDomain,
  routingInstructions,
  txtInstruction,
  validateDomainInput,
  verifyDomain,
  type DomainState,
} from "./domains.js";

// --- Helpers -----------------------------------------------------------------

const BASE = "https://pod.example";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** A fetch mock that records calls and replays canned responses in order. */
function fetchMock(...responses: Response[]): {
  fetch: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const queue = [...responses];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (!next) throw new Error("fetchMock: no response queued");
    return next;
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const BINDING = {
  domain: "pod.example.org",
  podRoot: "https://pod.example/alice/",
  state: "claimed",
  createdAt: "2026-06-12T00:00:00.000Z",
  routing: { cnameTarget: "edge.pod.example.", aTargets: ["192.0.2.10"] },
  txtRecord: {
    name: "_solid-domain-challenge.pod.example.org",
    value: "pss-verify=abc123",
    expires: "2026-06-19T00:00:00.000Z",
  },
};

// --- Validation (mirrors the server's deny-by-default idna.ts) ----------------

describe("validateDomainInput", () => {
  it("accepts a plain subdomain and lowercases it", () => {
    expect(validateDomainInput("Pods.Example.ORG")).toEqual({
      ok: true,
      domain: "pods.example.org",
    });
  });

  it("accepts an apex domain and strips one trailing dot", () => {
    expect(validateDomainInput("example.org.")).toEqual({ ok: true, domain: "example.org" });
  });

  it("normalises a U-label to its IDNA A-label form", () => {
    const result = validateDomainInput("pöd.example");
    expect(result).toEqual({ ok: true, domain: "xn--pd-fka.example" });
  });

  it.each(["", "   ", "."])("rejects empty input %j", (input) => {
    expect(validateDomainInput(input).ok).toBe(false);
  });

  it.each([
    "https://example.org",
    "example.org/path",
    "user@example.org",
    "example.org:8080",
    "ex ample.org",
    "example.org?q=1",
    "example.org#frag",
    "exa%6Dple.org",
  ])("rejects input with forbidden characters: %s", (input) => {
    expect(validateDomainInput(input).ok).toBe(false);
  });

  it.each(["192.0.2.1", "0x7f.1"])("rejects IPv4 literals (%s)", (input) => {
    const result = validateDomainInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/IP address/i);
  });

  it("rejects single-label names", () => {
    expect(validateDomainInput("intranet").ok).toBe(false);
  });

  it.each(["pod.local", "pod.internal", "pod.test", "pod.invalid", "x.localhost", "x.onion"])(
    "rejects special-use TLDs (%s)",
    (input) => {
      expect(validateDomainInput(input).ok).toBe(false);
    },
  );

  it("rejects labels with leading/trailing hyphens", () => {
    expect(validateDomainInput("-bad.example.org").ok).toBe(false);
    expect(validateDomainInput("bad-.example.org").ok).toBe(false);
  });

  it("rejects names over 253 octets and labels over 63", () => {
    const longLabel = `${"a".repeat(64)}.example.org`;
    expect(validateDomainInput(longLabel).ok).toBe(false);
    const longName = `${Array.from({ length: 40 }, () => "abcdefg").join(".")}.org`;
    expect(validateDomainInput(longName).ok).toBe(false);
  });

  it("rejects the pod server's own host and any subdomain of it", () => {
    const protectedHosts = ["solid-test.jeswr.org"];
    expect(validateDomainInput("solid-test.jeswr.org", protectedHosts).ok).toBe(false);
    expect(validateDomainInput("me.solid-test.jeswr.org", protectedHosts).ok).toBe(false);
    expect(validateDomainInput("UPPER.Solid-Test.jeswr.org", protectedHosts).ok).toBe(false);
    // …but not unrelated domains that merely contain the host as a substring.
    expect(validateDomainInput("notsolid-test.jeswr.org.example.com", protectedHosts).ok).toBe(
      true,
    );
  });
});

// --- State mapping -------------------------------------------------------------

describe("describeState", () => {
  it.each([
    ["claimed", "Pending DNS", "pending"],
    ["verified", "Verifying", "progress"],
    ["live", "Live", "live"],
    ["suspended", "Suspended", "warning"],
    ["released", "Released", "muted"],
  ] as const)("maps %s → %s (%s)", (state, label, tone) => {
    const badge = describeState(state as DomainState);
    expect(badge.label).toBe(label);
    expect(badge.tone).toBe(tone);
    expect(badge.description.length).toBeGreaterThan(10);
  });

  it("polls only while claimed or verified", () => {
    expect(isPollableState("claimed")).toBe(true);
    expect(isPollableState("verified")).toBe(true);
    expect(isPollableState("live")).toBe(false);
    expect(isPollableState("suspended")).toBe(false);
    expect(isPollableState("released")).toBe(false);
  });
});

// --- DNS instructions ------------------------------------------------------------

describe("DNS instructions", () => {
  it("detects apexes by label count", () => {
    expect(isApexDomain("example.org")).toBe(true);
    expect(isApexDomain("pod.example.org")).toBe(false);
  });

  it("recommends CNAME first for subdomains, A first for apexes", () => {
    const sub = routingInstructions({
      domain: "pod.example.org",
      routing: { cnameTarget: "edge.host.", aTargets: ["192.0.2.10"] },
    });
    expect(sub.map((r) => r.type)).toEqual(["CNAME", "A"]);
    const apex = routingInstructions({
      domain: "example.org",
      routing: { cnameTarget: "edge.host.", aTargets: ["192.0.2.10", "192.0.2.11"] },
    });
    expect(apex.map((r) => r.type)).toEqual(["A", "A", "CNAME"]);
  });

  it("omits record kinds the server does not publish", () => {
    expect(
      routingInstructions({ domain: "pod.example.org", routing: { aTargets: ["192.0.2.10"] } }),
    ).toEqual([{ type: "A", name: "pod.example.org", value: "192.0.2.10" }]);
    expect(routingInstructions({ domain: "pod.example.org", routing: {} })).toEqual([]);
  });

  it("exposes the TXT challenge as a copyable record while open", () => {
    const binding = {
      ...BINDING,
      state: "claimed" as const,
      routing: {},
    };
    expect(txtInstruction(binding)).toEqual({
      type: "TXT",
      name: "_solid-domain-challenge.pod.example.org",
      value: "pss-verify=abc123",
    });
    expect(txtInstruction({ ...binding, txtRecord: undefined })).toBeUndefined();
  });
});

// --- API client --------------------------------------------------------------------

describe("domainsApiBase", () => {
  it("is the origin of the pod storage", () => {
    expect(domainsApiBase("https://solid-test.jeswr.org/alice/")).toBe(
      "https://solid-test.jeswr.org",
    );
  });
});

describe("listDomains", () => {
  it("parses the list shape", async () => {
    const { fetch, calls } = fetchMock(jsonResponse(200, { domains: [BINDING] }));
    const domains = await listDomains(BASE, fetch);
    expect(calls[0].url).toBe("https://pod.example/account/domains");
    expect(domains).toHaveLength(1);
    expect(domains[0].domain).toBe("pod.example.org");
    expect(domains[0].state).toBe("claimed");
    expect(domains[0].txtRecord?.value).toBe("pss-verify=abc123");
    expect(domains[0].routing.cnameTarget).toBe("edge.pod.example.");
  });

  it("detects the feature being disabled (404 — routes absent)", async () => {
    const { fetch } = fetchMock(
      jsonResponse(404, { message: "Route GET:/account/domains not found", statusCode: 404 }),
    );
    await expect(listDomains(BASE, fetch)).rejects.toBeInstanceOf(DomainsUnavailableError);
  });

  it("treats a 200 that is not the list shape as feature-disabled (LDP fallthrough)", async () => {
    const { fetch } = fetchMock(new Response("<html>not the API</html>", { status: 200 }));
    await expect(listDomains(BASE, fetch)).rejects.toBeInstanceOf(DomainsUnavailableError);
  });

  it("surfaces 401 as a session-expired error", async () => {
    const { fetch } = fetchMock(jsonResponse(401, { error: "Unauthorized" }));
    await expect(listDomains(BASE, fetch)).rejects.toBeInstanceOf(DomainsAuthError);
  });
});

describe("claimDomain", () => {
  it("POSTs domain + podRoot and returns the challenge", async () => {
    const { fetch, calls } = fetchMock(jsonResponse(201, BINDING));
    const binding = await claimDomain(
      BASE,
      { domain: "pod.example.org", podRoot: "https://pod.example/alice/" },
      fetch,
    );
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      domain: "pod.example.org",
      podRoot: "https://pod.example/alice/",
    });
    expect(binding.txtRecord?.name).toBe("_solid-domain-challenge.pod.example.org");
  });

  it("maps 403 to the quota error with the server's copy", async () => {
    const { fetch } = fetchMock(
      jsonResponse(403, { error: "Forbidden", message: "Per-account domain quota (5) reached." }),
    );
    await expect(
      claimDomain(BASE, { domain: "a.example.org", podRoot: "https://pod.example/alice/" }, fetch),
    ).rejects.toThrow(DomainQuotaError);
  });

  it("maps 409 to a conflict error carrying the server message", async () => {
    const { fetch } = fetchMock(
      jsonResponse(409, {
        error: "Conflict",
        message: "This domain already has a binding owned by another account.",
      }),
    );
    const error = await claimDomain(
      BASE,
      { domain: "a.example.org", podRoot: "https://pod.example/alice/" },
      fetch,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainConflictError);
    expect((error as Error).message).toMatch(/another account/);
  });

  it("maps 400 to a validation error with the server reason", async () => {
    const { fetch } = fetchMock(
      jsonResponse(400, { error: "BadRequest", message: "Domain contains an invalid label." }),
    );
    const error = await claimDomain(
      BASE,
      { domain: "bad", podRoot: "https://pod.example/alice/" },
      fetch,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainValidationError);
    expect((error as Error).message).toBe("Domain contains an invalid label.");
  });

  it("maps a 404 (feature off) to unavailable", async () => {
    const { fetch } = fetchMock(jsonResponse(404, {}));
    await expect(
      claimDomain(BASE, { domain: "a.example.org", podRoot: "https://pod.example/alice/" }, fetch),
    ).rejects.toBeInstanceOf(DomainsUnavailableError);
  });
});

describe("getDomain / verifyDomain / releaseDomain", () => {
  it("fetches detail by domain", async () => {
    const { fetch, calls } = fetchMock(jsonResponse(200, BINDING));
    const binding = await getDomain(BASE, "pod.example.org", fetch);
    expect(calls[0].url).toBe("https://pod.example/account/domains/pod.example.org");
    expect(binding.state).toBe("claimed");
  });

  it("maps detail 404 to not-found for that domain", async () => {
    const { fetch } = fetchMock(jsonResponse(404, { error: "NotFound" }));
    const error = await getDomain(BASE, "gone.example.org", fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainNotFoundError);
    expect((error as DomainNotFoundError).domain).toBe("gone.example.org");
  });

  it("POSTs verify and surfaces per-record checks", async () => {
    const { fetch, calls } = fetchMock(
      jsonResponse(200, {
        ...BINDING,
        txtRecord: undefined,
        checks: {
          txt: { ok: true, detail: "TXT record found (all resolvers agree)." },
          routing: { ok: false, detail: "Routing record not seen yet." },
        },
      }),
    );
    const binding = await verifyDomain(BASE, "pod.example.org", fetch);
    expect(calls[0].url).toBe("https://pod.example/account/domains/pod.example.org/verify");
    expect(calls[0].init?.method).toBe("POST");
    expect(binding.checks?.txt?.ok).toBe(true);
    expect(binding.checks?.routing?.ok).toBe(false);
  });

  it("maps an expired challenge (409) to a conflict with honest copy", async () => {
    const { fetch } = fetchMock(
      jsonResponse(409, {
        error: "Conflict",
        message: "The TXT challenge has expired. Claim the domain again to mint a new token.",
      }),
    );
    const error = await verifyDomain(BASE, "pod.example.org", fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainConflictError);
    expect((error as Error).message).toMatch(/expired/);
  });

  it("releases with DELETE (204)", async () => {
    const { fetch, calls } = fetchMock(new Response(null, { status: 204 }));
    await releaseDomain(BASE, "pod.example.org", fetch);
    expect(calls[0].init?.method).toBe("DELETE");
  });
});
