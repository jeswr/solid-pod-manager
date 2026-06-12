/**
 * Custom domains — the client for prod-solid-server's BYOD Phase 1 API
 * (`/account/domains`, docs/design/byod.md §5 in that repo). The flow:
 * claim a domain → publish a TXT challenge + a routing record → "Check now"
 * (POST verify) until the binding reaches `live`.
 *
 * The API lives on the USER'S pod server (the origin of their storage), is
 * DPoP-authed and owner-scoped. Production paths pass NO `fetch` — the
 * auth-patched global runs (AGENTS.md §Reading data); tests inject a mock.
 *
 * The feature is optional server-side (`PSS_CUSTOM_DOMAINS_ENABLE`): with the
 * flag off the routes do not exist, so the list endpoint answers 404 (or an
 * LDP fallthrough that is not the list shape). That is detected here as
 * {@link DomainsUnavailableError} — an empty state, never an error screen.
 */
import { PodDataError } from "./errors.js";

// --- Types (mirror src/http/domains.ts response shapes on the server) ------

/** Registry state machine (server: claimed → verified → live ⇄ suspended; released = tombstone). */
export type DomainState = "claimed" | "verified" | "live" | "suspended" | "released";

const STATES: ReadonlySet<string> = new Set([
  "claimed",
  "verified",
  "live",
  "suspended",
  "released",
]);

/** The TXT ownership challenge the owner must publish (present while `claimed`). */
export interface TxtChallenge {
  /** Record owner name: `_solid-domain-challenge.<domain>`. */
  name: string;
  /** Record value: `pss-verify=<token>`. */
  value: string;
  /** ISO timestamp the single-use token expires (7 days from claim). */
  expires?: string;
}

/** The published routing targets (server config; at least one kind when enabled). */
export interface RoutingTargets {
  /** What subdomain owners CNAME to. */
  cnameTarget?: string;
  /** What apex owners point A records at. */
  aTargets?: string[];
}

/** One DNS check outcome from POST verify (client-safe `detail` copy). */
export interface CheckResult {
  ok: boolean;
  detail: string;
}

/** Per-record results of the last "Check now" (txt while claimed; routing after). */
export interface DomainChecks {
  txt?: CheckResult;
  routing?: CheckResult;
}

/** A domain↔pod binding as the owner sees it. */
export interface DomainBinding {
  /** Lowercased IDNA A-label domain. */
  domain: string;
  /** The pod root the domain maps to. */
  podRoot: string;
  state: DomainState;
  createdAt: string;
  verifiedAt?: string;
  lastDnsCheck?: string;
  /** `https://<domain>/` — present once live. */
  aliasUrl?: string;
  routing: RoutingTargets;
  /** Present on claim/detail responses while the challenge is open. */
  txtRecord?: TxtChallenge;
  /** Present on verify responses. */
  checks?: DomainChecks;
}

// --- Typed errors (the UI branches on instanceof, never message strings) ---

/** Base class for anything the domains API client throws. */
export class DomainsError extends PodDataError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DomainsError";
  }
}

/** Custom domains are not enabled on this pod server (routes absent). */
export class DomainsUnavailableError extends DomainsError {
  constructor() {
    super("Custom domains are not enabled on your pod server.");
    this.name = "DomainsUnavailableError";
  }
}

/** The server answered 401 — the session has expired; sign in again. */
export class DomainsAuthError extends DomainsError {
  constructor() {
    super("Your session has expired. Sign in again to manage domains.");
    this.name = "DomainsAuthError";
  }
}

/** 403 on claim — the per-account domain quota is reached. */
export class DomainQuotaError extends DomainsError {
  constructor(serverMessage?: string) {
    super(serverMessage ?? "You have reached your domain limit on this server.");
    this.name = "DomainQuotaError";
  }
}

/**
 * 409 — the domain is already claimed (possibly by another account), the
 * challenge expired, or the binding is in a state that refuses the action.
 * The message is the server's honest explanation.
 */
export class DomainConflictError extends DomainsError {
  constructor(serverMessage?: string) {
    super(serverMessage ?? "This domain conflicts with an existing binding.");
    this.name = "DomainConflictError";
  }
}

/** 404 on a specific domain — no such binding owned by this account. */
export class DomainNotFoundError extends DomainsError {
  readonly domain: string;
  constructor(domain: string) {
    super(`There is no domain binding for ${domain} on your account.`);
    this.name = "DomainNotFoundError";
    this.domain = domain;
  }
}

/** 400 — the server rejected the input (its reason is client-safe copy). */
export class DomainValidationError extends DomainsError {
  constructor(serverMessage?: string) {
    super(serverMessage ?? "That domain cannot be connected.");
    this.name = "DomainValidationError";
  }
}

/** Anything else non-2xx (5xx, unexpected shapes) — retryable. */
export class DomainsRequestError extends DomainsError {
  readonly status: number;
  constructor(status: number, serverMessage?: string) {
    super(serverMessage ?? `The domain service answered ${status}. Try again.`);
    this.name = "DomainsRequestError";
    this.status = status;
  }
}

// --- Client-side validation (mirrors the server's src/domains/idna.ts) -----

/** Result of {@link validateDomainInput}. */
export type DomainValidation =
  | { readonly ok: true; readonly domain: string }
  | { readonly ok: false; readonly reason: string };

/** Special-use / non-public TLDs that can never carry a public DNS proof. */
const FORBIDDEN_TLDS: ReadonlySet<string> = new Set([
  "local",
  "internal",
  "test",
  "invalid",
  "localhost",
  "arpa",
  "onion",
]);

/** A single DNS label: LDH, no leading/trailing hyphen, 1–63 octets. */
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Characters that could smuggle scheme/userinfo/port/path past the URL parser. */

const FORBIDDEN_CHARS = /[\x00-\x20/\\@:?#[\]%]/;

/** IPv4 dotted-quad after WHATWG URL canonicalisation. */
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Normalise + validate a domain the way the server will (deny by default):
 * IDNA A-label form via the WHATWG `URL` parser, then refuse IP literals,
 * special-use TLDs, the pod server's own namespace, and malformed names.
 * Pure; never throws — so the form can validate as the user types.
 *
 * @param protectedHosts - the pod server's hostname(s); the exact host and
 *   every subdomain of each are refused ("never shadow the canonical origin").
 */
export function validateDomainInput(
  input: string,
  protectedHosts: readonly string[] = [],
): DomainValidation {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, reason: "Enter a domain name." };
  }
  const raw = input.trim();
  if (raw.length > 1024) {
    return { ok: false, reason: "That domain is too long." };
  }
  // Strip exactly one trailing dot (the fully-qualified form).
  const trimmed = raw.endsWith(".") ? raw.slice(0, -1) : raw;
  if (trimmed.length === 0) {
    return { ok: false, reason: "Enter a domain name." };
  }
  if (FORBIDDEN_CHARS.test(trimmed)) {
    return {
      ok: false,
      reason: "Enter just the domain name — no spaces, https://, paths or ports.",
    };
  }
  // WHATWG URL applies IDNA ToASCII (U-label → A-label), lowercases, validates.
  let hostname: string;
  try {
    const url = new URL(`http://${trimmed}/`);
    hostname = url.hostname;
    if (url.port !== "" || url.username !== "" || url.pathname !== "/") {
      return { ok: false, reason: "Enter just the bare domain name." };
    }
  } catch {
    return { ok: false, reason: "That doesn't look like a valid domain name." };
  }
  if (IPV4_PATTERN.test(hostname) || (hostname.startsWith("[") && hostname.endsWith("]"))) {
    return { ok: false, reason: "IP addresses can't be connected — use a domain name." };
  }
  if (hostname.length > 253) {
    return { ok: false, reason: "That domain is too long (over 253 characters)." };
  }
  const labels = hostname.split(".");
  if (labels.length < 2) {
    return {
      ok: false,
      reason: "Enter a full domain, like pod.example.com.",
    };
  }
  for (const label of labels) {
    if (!LABEL_PATTERN.test(label)) {
      return { ok: false, reason: "That doesn't look like a valid domain name." };
    }
  }
  const tld = labels[labels.length - 1];
  if (FORBIDDEN_TLDS.has(tld)) {
    return { ok: false, reason: `.${tld} domains can't be reached from the public internet.` };
  }
  for (const rawHost of protectedHosts) {
    const host = rawHost.toLowerCase().replace(/\.$/, "");
    if (host.length === 0) continue;
    if (hostname === host || hostname.endsWith(`.${host}`)) {
      return { ok: false, reason: "That address already belongs to your pod server." };
    }
  }
  return { ok: true, domain: hostname };
}

// --- State mapping (badge copy the UI renders) ------------------------------

/** Visual tone for a state badge — mapped to badge styling in the UI layer. */
export type StateTone = "pending" | "progress" | "live" | "warning" | "muted";

export interface StateBadge {
  /** Short badge label. */
  label: string;
  tone: StateTone;
  /** One honest sentence about where the domain is in the flow. */
  description: string;
}

const STATE_BADGES: Readonly<Record<DomainState, StateBadge>> = {
  claimed: {
    label: "Pending DNS",
    tone: "pending",
    description:
      "Waiting for the DNS records. Add the TXT challenge and routing record, then check again — changes can take up to 48 hours to propagate.",
  },
  verified: {
    label: "Verifying",
    tone: "progress",
    description:
      "Ownership is proven. Waiting for the routing record to point this domain at your pod server.",
  },
  live: {
    label: "Live",
    tone: "live",
    description: "This domain serves your pod. The first visit may take a few seconds while the certificate is issued.",
  },
  suspended: {
    label: "Suspended",
    tone: "warning",
    description:
      "The routing record stopped pointing at your pod server, so the domain is paused. Restore the DNS record and it recovers automatically.",
  },
  released: {
    label: "Released",
    tone: "muted",
    description: "This domain was disconnected. Claim it again to reconnect it.",
  },
};

/** Badge copy for a binding state. */
export function describeState(state: DomainState): StateBadge {
  return STATE_BADGES[state];
}

/** States the UI should keep polling verify for while the page is visible. */
export function isPollableState(state: DomainState): boolean {
  return state === "claimed" || state === "verified";
}

// --- DNS instructions --------------------------------------------------------

/** One DNS record the owner must create, ready to copy field-by-field. */
export interface DnsInstruction {
  type: "TXT" | "CNAME" | "A";
  /** Record owner name (what goes in the DNS host/name field). */
  name: string;
  /** Record value/target. */
  value: string;
}

/** Apex heuristic: two labels = apex (recommend A), more = subdomain (CNAME). */
export function isApexDomain(domain: string): boolean {
  return domain.split(".").length === 2;
}

/**
 * The routing record options for a binding, recommended one first. Subdomains
 * get the CNAME first; apexes the A records (most DNS hosts refuse a CNAME at
 * the apex). Only options the server actually publishes are returned.
 */
export function routingInstructions(binding: {
  domain: string;
  routing: RoutingTargets;
}): DnsInstruction[] {
  const cname: DnsInstruction[] = binding.routing.cnameTarget
    ? [{ type: "CNAME", name: binding.domain, value: binding.routing.cnameTarget }]
    : [];
  const a: DnsInstruction[] = (binding.routing.aTargets ?? []).map((target) => ({
    type: "A",
    name: binding.domain,
    value: target,
  }));
  return isApexDomain(binding.domain) ? [...a, ...cname] : [...cname, ...a];
}

/** The TXT challenge as a copyable instruction (while the challenge is open). */
export function txtInstruction(binding: DomainBinding): DnsInstruction | undefined {
  if (!binding.txtRecord) return undefined;
  return { type: "TXT", name: binding.txtRecord.name, value: binding.txtRecord.value };
}

// --- API client ---------------------------------------------------------------

/** The domains API origin for a pod: the pod server itself. */
export function domainsApiBase(podRootOrStorage: string): string {
  return new URL(podRootOrStorage).origin;
}

const LIST_PATH = "/account/domains";

type FetchLike = typeof fetch;

/** Parse a JSON body, tolerating non-JSON answers (LDP fallthrough, proxies). */
async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const data: unknown = await response.json();
    return typeof data === "object" && data !== null
      ? (data as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function serverMessage(body: Record<string, unknown> | undefined): string | undefined {
  return typeof body?.message === "string" ? body.message : undefined;
}

/** Map a non-2xx management-route response to a typed error. Never returns. */
async function throwForStatus(response: Response, domain?: string): Promise<never> {
  const body = await readJson(response);
  const message = serverMessage(body);
  switch (response.status) {
    case 400:
      throw new DomainValidationError(message);
    case 401:
      throw new DomainsAuthError();
    case 403:
      throw new DomainQuotaError(message);
    case 404:
      // On a specific domain this means "no such binding you own"; the
      // feature-off case is detected on the LIST endpoint (see listDomains).
      throw domain === undefined
        ? new DomainsUnavailableError()
        : new DomainNotFoundError(domain);
    case 409:
      throw new DomainConflictError(message);
    default:
      throw new DomainsRequestError(response.status, message);
  }
}

/** Coerce one server binding object; throws on shapes the server never emits. */
function parseBinding(value: unknown): DomainBinding {
  const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  if (
    raw === undefined ||
    typeof raw.domain !== "string" ||
    typeof raw.podRoot !== "string" ||
    typeof raw.state !== "string" ||
    !STATES.has(raw.state) ||
    typeof raw.createdAt !== "string"
  ) {
    throw new DomainsRequestError(200, "The server answered with an unexpected shape.");
  }
  const routingRaw =
    typeof raw.routing === "object" && raw.routing !== null
      ? (raw.routing as Record<string, unknown>)
      : {};
  const routing: RoutingTargets = {
    ...(typeof routingRaw.cnameTarget === "string" ? { cnameTarget: routingRaw.cnameTarget } : {}),
    ...(Array.isArray(routingRaw.aTargets)
      ? { aTargets: routingRaw.aTargets.filter((t): t is string => typeof t === "string") }
      : {}),
  };
  const txtRaw =
    typeof raw.txtRecord === "object" && raw.txtRecord !== null
      ? (raw.txtRecord as Record<string, unknown>)
      : undefined;
  const txtRecord: TxtChallenge | undefined =
    txtRaw && typeof txtRaw.name === "string" && typeof txtRaw.value === "string"
      ? {
          name: txtRaw.name,
          value: txtRaw.value,
          ...(typeof txtRaw.expires === "string" ? { expires: txtRaw.expires } : {}),
        }
      : undefined;
  const checksRaw =
    typeof raw.checks === "object" && raw.checks !== null
      ? (raw.checks as Record<string, unknown>)
      : undefined;
  const check = (v: unknown): CheckResult | undefined => {
    const c = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
    return c && typeof c.ok === "boolean" && typeof c.detail === "string"
      ? { ok: c.ok, detail: c.detail }
      : undefined;
  };
  const checks: DomainChecks | undefined = checksRaw
    ? {
        ...(check(checksRaw.txt) ? { txt: check(checksRaw.txt) } : {}),
        ...(check(checksRaw.routing) ? { routing: check(checksRaw.routing) } : {}),
      }
    : undefined;
  return {
    domain: raw.domain,
    podRoot: raw.podRoot,
    state: raw.state as DomainState,
    createdAt: raw.createdAt,
    ...(typeof raw.verifiedAt === "string" ? { verifiedAt: raw.verifiedAt } : {}),
    ...(typeof raw.lastDnsCheck === "string" ? { lastDnsCheck: raw.lastDnsCheck } : {}),
    ...(typeof raw.aliasUrl === "string" ? { aliasUrl: raw.aliasUrl } : {}),
    routing,
    ...(txtRecord ? { txtRecord } : {}),
    ...(checks ? { checks } : {}),
  };
}

/**
 * List the account's domain bindings. Throws {@link DomainsUnavailableError}
 * when the feature is off server-side: the routes are absent, so the path
 * 404s — and anything that is not the `{ domains: [...] }` list shape is
 * treated the same way (an LDP fallthrough is "not this feature", not a bug).
 */
export async function listDomains(
  base: string,
  fetchImpl?: FetchLike,
): Promise<DomainBinding[]> {
  const doFetch = fetchImpl ?? fetch;
  const response = await doFetch(`${base}${LIST_PATH}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    if (response.status === 401) throw new DomainsAuthError();
    if (response.status === 404 || response.status === 405) throw new DomainsUnavailableError();
    await throwForStatus(response);
  }
  const body = await readJson(response);
  if (!body || !Array.isArray(body.domains)) {
    // 200 but not the list shape — this origin does not serve the domains API.
    throw new DomainsUnavailableError();
  }
  return body.domains.map(parseBinding);
}

/** Claim a domain for a pod root. Returns the binding incl. the TXT challenge. */
export async function claimDomain(
  base: string,
  claim: { domain: string; podRoot: string },
  fetchImpl?: FetchLike,
): Promise<DomainBinding> {
  const doFetch = fetchImpl ?? fetch;
  const response = await doFetch(`${base}${LIST_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(claim),
  });
  if (!response.ok) {
    if (response.status === 404 || response.status === 405) throw new DomainsUnavailableError();
    await throwForStatus(response);
  }
  return parseBinding(await readJson(response));
}

/** Fetch one binding's detail (state + open challenge + instructions). */
export async function getDomain(
  base: string,
  domain: string,
  fetchImpl?: FetchLike,
): Promise<DomainBinding> {
  const doFetch = fetchImpl ?? fetch;
  const response = await doFetch(`${base}${LIST_PATH}/${encodeURIComponent(domain)}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) await throwForStatus(response, domain);
  return parseBinding(await readJson(response));
}

/** Run the DNS checks now (TXT while claimed, routing after). */
export async function verifyDomain(
  base: string,
  domain: string,
  fetchImpl?: FetchLike,
): Promise<DomainBinding> {
  const doFetch = fetchImpl ?? fetch;
  const response = await doFetch(
    `${base}${LIST_PATH}/${encodeURIComponent(domain)}/verify`,
    { method: "POST", headers: { accept: "application/json" } },
  );
  if (!response.ok) await throwForStatus(response, domain);
  return parseBinding(await readJson(response));
}

/** Release (disconnect) a domain binding. */
export async function releaseDomain(
  base: string,
  domain: string,
  fetchImpl?: FetchLike,
): Promise<void> {
  const doFetch = fetchImpl ?? fetch;
  const response = await doFetch(`${base}${LIST_PATH}/${encodeURIComponent(domain)}`, {
    method: "DELETE",
    headers: { accept: "application/json" },
  });
  if (!response.ok) await throwForStatus(response, domain);
}
