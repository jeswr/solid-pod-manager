/**
 * Permissions — the WAC read/write model behind "Connected apps"
 * (DESIGN.md §3/§4 screens 6–7, §9 "keys & gates").
 *
 * The Connected-apps view is a *read model* over the pod's `.acl` documents:
 * for every agent that is not the pod owner, which data categories it can
 * reach and with which modes. Mutations (revoke / grant) edit those same
 * documents through `@solid/object`'s typed `AclResource`/`Authorization`
 * wrappers — never hand-built triples (the `solid-wac` house rule) — and are
 * atomic per document (conditional `PUT` with `If-Match`).
 *
 * Backend seam: everything goes through the {@link PermissionsBackend}
 * interface so an ACP (`.acr`) implementation can be added later without
 * changing the UI. Only WAC is implemented today (CSS v7 default).
 *
 * Fail-closed: any read/parse error surfaces as a typed error
 * ({@link AclReadError} / {@link AclWriteError}); nothing is ever guessed.
 * ACL documents are *discovered* from the `Link: rel="acl"` response header,
 * never derived from the resource URL.
 */
import { fetchRdf, parseRdf, RdfFetchError } from "@jeswr/fetch-rdf";
import { AclResource, Authorization } from "@solid/object";
import { DataFactory, Store, Writer } from "n3";
import type { DatasetCore, Term } from "@rdfjs/types";
import { CATEGORIES, UNCATEGORISED, type DataCategory } from "./categories.js";
import type { CategorySummary } from "./pod-data.js";
import { AclDiscoveryError, AclReadError, AclWriteError } from "./errors.js";
import { ProfileAgent } from "./profile-agent.js";

const ACL = "http://www.w3.org/ns/auth/acl#";

/** The four WAC modes, in plain identifiers the UI maps to copy. */
export type AccessMode = "read" | "write" | "append" | "control";

/**
 * Pseudo-category for grants that cover the whole pod (a rule on the storage
 * root with `acl:default`): shown as a single honest "All data" row instead of
 * fanning out to every category.
 */
export const ALL_DATA: DataCategory = {
  id: "all-data",
  label: "All data",
  tier: "common",
  icon: "boxes",
  assurance: "This app can reach everything stored in your pod.",
  description: "Everything in your pod, across every category.",
  classes: [],
};

/** What the read model needs to know about the pod. */
export interface PermissionsContext {
  /** The pod owner's WebID — its grants are filtered out of the app list. */
  ownerWebId: string;
  /** The storage root (trailing slash). */
  podRoot: string;
  /** The P1 category taxonomy as discovered from the Type Index. */
  summaries: CategorySummary[];
}

/**
 * One concrete place a grant lives: which ACL document, which
 * `acl:Authorization` subject inside it, and which target resource the rule
 * names. Revoke operates on these — they pin the mutation to exact documents.
 */
export interface AccessGrant {
  /** The ACL document URL. */
  aclUrl: string;
  /** IRI of the `acl:Authorization` subject inside that document. */
  authorization: string;
  /** The resource the rule names (`acl:accessTo` / `acl:default` object). */
  target: string;
  /** True when granted via `acl:default` (inherits to contained resources). */
  inherits: boolean;
}

/** A category an agent can reach, with modes and the grants that say so. */
export interface CategoryAccess {
  category: DataCategory;
  modes: AccessMode[];
  grants: AccessGrant[];
}

/** How the rule names the app: by WebID (`acl:agent`) or by `acl:origin`. */
export type AgentKind = "agent" | "origin";

/** The read model for one connected app (any non-owner agent in the ACLs). */
export interface AppAccess {
  /** The agent WebID or origin IRI. */
  agentId: string;
  kind: AgentKind;
  /** True when a storage-root `acl:default` rule covers the entire pod. */
  wholePod: boolean;
  /** Union of modes across all categories. */
  modes: AccessMode[];
  /** Per-category access, in taxonomy order (All data first, Other last). */
  categories: CategoryAccess[];
}

/**
 * The backend seam (DESIGN.md §9): WAC today, ACP later. The UI only ever
 * talks to this interface.
 */
export interface PermissionsBackend {
  /** Build the {@link AppAccess} read model for every non-owner agent. */
  listApps(ctx: PermissionsContext): Promise<AppAccess[]>;
  /**
   * Remove an agent from the authorizations named by `grants`. Atomic per ACL
   * document; throws {@link AclWriteError} (fail-closed) on any failure.
   * Removing the agent removes ALL of its modes on those rules — revoke
   * prefers over-removal to silently leaving access behind.
   */
  revokeGrants(agentId: string, grants: AccessGrant[]): Promise<void>;
  /**
   * Give an agent access to a category (default mode: Read). Writes one new
   * authorization per category location, into the ACL document its server
   * advertises.
   */
  grant(
    ctx: PermissionsContext,
    agentId: string,
    categoryId: string,
    modes?: AccessMode[],
  ): Promise<void>;
}

// ─── Read model ─────────────────────────────────────────────────────────────

/** A resource belonging to a category (the taxonomy projected onto URLs). */
interface Scope {
  category: DataCategory;
  /** Resource URL; containers end in `/`. */
  resource: string;
}

function ensureSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** Project the category taxonomy onto resource URLs (pod root included). */
function scopesOf(ctx: PermissionsContext): Scope[] {
  const scopes: Scope[] = [{ category: ALL_DATA, resource: ensureSlash(ctx.podRoot) }];
  const seen = new Set<string>([scopes[0].resource]);
  for (const summary of ctx.summaries) {
    for (const loc of summary.locations) {
      for (const resource of [
        loc.container ? ensureSlash(loc.container) : undefined,
        loc.instance,
      ]) {
        if (!resource) continue;
        const key = `${summary.category.id}|${resource}`;
        if (seen.has(key)) continue;
        seen.add(key);
        scopes.push({ category: summary.category, resource });
      }
    }
  }
  return scopes;
}

/**
 * Parse a `Link` header and resolve the `rel="acl"` target against the
 * resource URL. Exported for tests. Handles quoted params and multiple
 * comma-separated link-values (commas inside `<>` or quotes are not splits).
 */
export function aclUrlFromLinkHeader(
  header: string | null,
  resourceUrl: string,
): string | undefined {
  if (!header) return undefined;
  for (const part of splitLinkHeader(header)) {
    const m = /^\s*<([^>]*)>\s*;?(.*)$/.exec(part);
    if (!m) continue;
    const rel = /rel\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(m[2]);
    const relValue = rel?.[1] ?? rel?.[2];
    if (!relValue) continue;
    if (relValue.split(/\s+/).some((r) => r.toLowerCase() === "acl")) {
      try {
        return new URL(m[1], resourceUrl).toString();
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function splitLinkHeader(header: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inAngle = false;
  let inQuote = false;
  for (const ch of header) {
    if (ch === "<" && !inQuote) inAngle = true;
    else if (ch === ">" && !inQuote) inAngle = false;
    else if (ch === '"') inQuote = !inQuote;
    if (ch === "," && !inAngle && !inQuote) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/**
 * Read all IRIs for a predicate off an authorization subject, defensively:
 * non-NamedNode objects (malformed user literals) are skipped, never thrown on
 * (solid-wac skill). The typed wrapper exposes `accessTo`/`default` as
 * single-valued; the spec allows multiples, so we match quads directly here.
 */
function irisOf(auth: Authorization, predicate: string): string[] {
  const subject = DataFactory.namedNode(auth.value);
  const out: string[] = [];
  for (const q of auth.dataset.match(subject as Term, DataFactory.namedNode(predicate))) {
    if (q.object.termType === "NamedNode") out.push(q.object.value);
  }
  return out;
}

function modesOf(auth: Authorization): AccessMode[] {
  const out: AccessMode[] = [];
  if (auth.canRead) out.push("read");
  if (auth.canWrite) out.push("write");
  // `write` subsumes `append` (solid-wac) — listing both is noise.
  if (auth.canAppend && !auth.canWrite) out.push("append");
  if (auth.canReadWriteAcl) out.push("control");
  return out;
}

const MODE_ORDER: AccessMode[] = ["read", "append", "write", "control"];

function sortModes(modes: Iterable<AccessMode>): AccessMode[] {
  return [...new Set(modes)].sort((a, b) => MODE_ORDER.indexOf(a) - MODE_ORDER.indexOf(b));
}

const CATEGORY_ORDER = new Map<string, number>([
  [ALL_DATA.id, -1],
  ...CATEGORIES.map((c, i) => [c.id, i] as const),
  [UNCATEGORISED.id, CATEGORIES.length],
]);

/** WAC implementation of the {@link PermissionsBackend} seam. */
export class WacPermissionsBackend implements PermissionsBackend {
  /**
   * @param fetchImpl - test-only override. **Omit in production** so the
   *   auth-patched global fetch runs (AGENTS.md §Reading data).
   */
  constructor(private readonly fetchImpl?: typeof fetch) {}

  private call(input: string, init?: RequestInit): Promise<Response> {
    // Resolve the global at call time — never capture a stale reference.
    return (this.fetchImpl ?? fetch)(input, init);
  }

  /**
   * Discover the ACL document URL for a resource from its `Link: rel="acl"`
   * header (never guessed). Returns `undefined` when the resource itself is
   * absent (a registered-but-missing location — skip, not an error).
   *
   * Uses **GET**, not HEAD: the reactive-authentication global-fetch patch only
   * replays the 401→DPoP upgrade for GET, so a HEAD to a protected resource
   * returns a bare 401 that never authenticates (observed in e2e). The body is
   * discarded — only the `Link` header matters.
   */
  private async discoverAclUrl(resourceUrl: string): Promise<string | undefined> {
    let res: Response;
    try {
      res = await this.call(resourceUrl, { method: "GET" });
    } catch (cause) {
      throw new AclDiscoveryError(resourceUrl, { cause });
    }
    // Drain the body so the connection is freed (we only wanted the headers).
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new AclDiscoveryError(resourceUrl);
    const acl = aclUrlFromLinkHeader(res.headers.get("link"), resourceUrl);
    if (!acl) throw new AclDiscoveryError(resourceUrl);
    return acl;
  }

  /** Fetch + parse one ACL document. `404` → `undefined` (governed by an ancestor). */
  private async readAcl(
    aclUrl: string,
  ): Promise<{ dataset: DatasetCore; etag: string | null } | undefined> {
    try {
      const { dataset, etag } = await fetchRdf(
        aclUrl,
        this.fetchImpl ? { fetch: this.fetchImpl } : undefined,
      );
      return { dataset, etag };
    } catch (e) {
      if (e instanceof RdfFetchError && e.status === 404) return undefined;
      throw new AclReadError(aclUrl, { cause: e });
    }
  }

  async listApps(ctx: PermissionsContext): Promise<AppAccess[]> {
    const podRoot = ensureSlash(ctx.podRoot);
    const scopes = scopesOf(ctx);

    // Discover the governing ACL document of every scoped resource, then read
    // each distinct document once.
    const aclUrls = new Set<string>();
    for (const resource of new Set(scopes.map((s) => s.resource))) {
      const acl = await this.discoverAclUrl(resource);
      if (acl) aclUrls.add(acl);
    }

    const apps = new Map<string, AppAccess>();
    const byCategory = new Map<string, Map<string, CategoryAccess>>();

    for (const aclUrl of aclUrls) {
      const doc = await this.readAcl(aclUrl);
      if (!doc) continue; // no ACL doc here — the root's rules already cover it
      const acl = new AclResource(doc.dataset, DataFactory);
      for (const auth of acl.authorizations) {
        const modes = modesOf(auth);
        if (modes.length === 0) continue;
        const targets = [
          ...irisOf(auth, `${ACL}accessTo`).map((t) => ({ target: t, inherits: false })),
          ...irisOf(auth, `${ACL}default`).map((t) => ({ target: t, inherits: true })),
        ];
        const subjects: { agentId: string; kind: AgentKind }[] = [
          ...[...auth.agent]
            .filter((a) => a !== ctx.ownerWebId)
            .map((agentId) => ({ agentId, kind: "agent" as const })),
          ...[...auth.origin].map((agentId) => ({ agentId, kind: "origin" as const })),
        ];
        if (subjects.length === 0) continue;

        for (const { target, inherits } of targets) {
          const grant: AccessGrant = {
            aclUrl,
            authorization: auth.value,
            target,
            inherits,
          };
          // Whole-pod: a default rule on the storage root covers everything.
          const wholePod = inherits && ensureSlash(target) === podRoot;
          const matched = wholePod
            ? [ALL_DATA]
            : matchScopes(scopes, target, inherits);
          for (const { agentId, kind } of subjects) {
            const key = `${kind}|${agentId}`;
            let app = apps.get(key);
            if (!app) {
              app = { agentId, kind, wholePod: false, modes: [], categories: [] };
              apps.set(key, app);
              byCategory.set(key, new Map());
            }
            if (wholePod) app.wholePod = true;
            const categories = byCategory.get(key);
            if (!categories) continue;
            for (const category of matched) {
              let entry = categories.get(category.id);
              if (!entry) {
                entry = { category, modes: [], grants: [] };
                categories.set(category.id, entry);
              }
              entry.modes = sortModes([...entry.modes, ...modes]);
              if (
                !entry.grants.some(
                  (g) =>
                    g.aclUrl === grant.aclUrl &&
                    g.authorization === grant.authorization &&
                    g.target === grant.target &&
                    g.inherits === grant.inherits,
                )
              ) {
                entry.grants.push(grant);
              }
            }
          }
        }
      }
    }

    for (const [key, app] of apps) {
      const categories = [...(byCategory.get(key)?.values() ?? [])];
      categories.sort(
        (a, b) =>
          (CATEGORY_ORDER.get(a.category.id) ?? 99) -
          (CATEGORY_ORDER.get(b.category.id) ?? 99),
      );
      app.categories = categories;
      app.modes = sortModes(categories.flatMap((c) => c.modes));
    }

    return [...apps.values()].filter((a) => a.categories.length > 0);
  }

  async revokeGrants(agentId: string, grants: AccessGrant[]): Promise<void> {
    const byDoc = new Map<string, Set<string>>();
    for (const g of grants) {
      const set = byDoc.get(g.aclUrl) ?? new Set<string>();
      set.add(g.authorization);
      byDoc.set(g.aclUrl, set);
    }
    for (const [aclUrl, authorizations] of byDoc) {
      await this.updateAcl(aclUrl, (acl) => {
        let changed = false;
        for (const auth of acl.authorizations) {
          if (!authorizations.has(auth.value)) continue;
          if (auth.agent.delete(agentId)) changed = true;
          if (auth.origin.delete(agentId)) changed = true;
          pruneEmptyAuthorization(auth);
        }
        return changed;
      });
    }
  }

  async grant(
    ctx: PermissionsContext,
    agentId: string,
    categoryId: string,
    modes: AccessMode[] = ["read"],
  ): Promise<void> {
    const targets = grantTargets(ctx, categoryId);
    if (targets.length === 0) {
      throw new AclWriteError(
        ensureSlash(ctx.podRoot),
        "This category has no storage location to share yet.",
      );
    }
    for (const target of targets) {
      const aclUrl = await this.discoverAclUrl(target);
      if (!aclUrl) {
        throw new AclWriteError(target, `The resource to share does not exist (${target}).`);
      }
      const existing = await this.readAcl(aclUrl);
      const dataset: DatasetCore = existing?.dataset ?? new Store();
      if (!existing) {
        // A fresh ACL document REPLACES inherited rules (the WAC walk is
        // monolithic) — it must carry the owner's full control or we lock the
        // owner out of their own resource.
        applyAuthorization(dataset, `${aclUrl}#owner`, {
          agentId: ctx.ownerWebId,
          target,
          modes: ["read", "write", "control"],
        });
      }
      applyAuthorization(dataset, `${aclUrl}#grant-${crypto.randomUUID()}`, {
        agentId,
        target,
        modes,
      });
      await this.putAcl(aclUrl, dataset, existing ? existing.etag : "create");
    }
  }

  /**
   * Read-modify-write one ACL document with `If-Match`. Retries once on `412`
   * (someone wrote in between) by re-reading and re-applying; any other
   * failure throws {@link AclWriteError} (fail-closed).
   */
  private async updateAcl(
    aclUrl: string,
    mutate: (acl: AclResource) => boolean,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const doc = await this.readAcl(aclUrl);
      if (!doc) return; // document gone — nothing to revoke
      const acl = new AclResource(doc.dataset, DataFactory);
      if (!mutate(acl)) return; // nothing to change
      const status = await this.tryPutAcl(aclUrl, doc.dataset, doc.etag);
      if (status === "ok") return;
      if (status !== "conflict") {
        throw new AclWriteError(aclUrl, undefined, { cause: status });
      }
      // conflict (412): loop re-reads and re-applies once
    }
    throw new AclWriteError(
      aclUrl,
      "The access settings changed while saving. Nothing was changed — try again.",
    );
  }

  private async putAcl(
    aclUrl: string,
    dataset: DatasetCore,
    etag: string | null | "create",
  ): Promise<void> {
    const status = await this.tryPutAcl(aclUrl, dataset, etag);
    if (status !== "ok") {
      throw new AclWriteError(aclUrl, undefined, {
        cause: status === "conflict" ? "412 precondition failed" : status,
      });
    }
  }

  private async tryPutAcl(
    aclUrl: string,
    dataset: DatasetCore,
    etag: string | null | "create",
  ): Promise<"ok" | "conflict" | unknown> {
    let body: string;
    try {
      body = await toTurtle(dataset);
    } catch (cause) {
      return cause;
    }
    const headers: Record<string, string> = { "content-type": "text/turtle" };
    if (etag === "create") headers["if-none-match"] = "*";
    else if (etag) headers["if-match"] = etag;
    let res: Response;
    try {
      res = await this.call(aclUrl, { method: "PUT", headers, body });
    } catch (cause) {
      return cause;
    }
    if (res.ok) return "ok";
    if (res.status === 412) return "conflict";
    return `PUT ${aclUrl} -> ${res.status}`;
  }
}

/** Match a rule target against the category scopes (no match → "Other data"). */
function matchScopes(scopes: Scope[], target: string, inherits: boolean): DataCategory[] {
  const matched = new Map<string, DataCategory>();
  for (const scope of scopes) {
    if (scope.category.id === ALL_DATA.id) {
      // The pod root itself: `accessTo` on the root names only the root
      // listing; report it under "All data" (the only honest bucket).
      if (scope.resource === target || scope.resource === ensureSlash(target)) {
        matched.set(ALL_DATA.id, ALL_DATA);
      }
      continue;
    }
    const covered =
      scope.resource === target ||
      (inherits && scope.resource.startsWith(ensureSlash(target)));
    if (covered) matched.set(scope.category.id, scope.category);
  }
  if (matched.size === 0) return [UNCATEGORISED];
  return [...matched.values()];
}

/** The resources a grant on `categoryId` writes rules for. */
function grantTargets(ctx: PermissionsContext, categoryId: string): string[] {
  if (categoryId === ALL_DATA.id) return [ensureSlash(ctx.podRoot)];
  const summary = ctx.summaries.find((s) => s.category.id === categoryId);
  if (!summary) return [];
  const targets = new Set<string>();
  for (const loc of summary.locations) {
    if (loc.container) targets.add(ensureSlash(loc.container));
    if (loc.instance) targets.add(loc.instance);
  }
  return [...targets];
}

/**
 * Write one `acl:Authorization` into a dataset through the typed wrapper —
 * the only sanctioned authoring path (never hand-built triples).
 */
function applyAuthorization(
  dataset: DatasetCore,
  iri: string,
  rule: { agentId: string; target: string; modes: AccessMode[] },
): void {
  const auth = new Authorization(iri, dataset, DataFactory);
  auth.type.add(`${ACL}Authorization`);
  auth.accessTo = rule.target;
  if (rule.target.endsWith("/")) auth.default = rule.target; // containers inherit
  auth.agent.add(rule.agentId);
  auth.canRead = rule.modes.includes("read");
  auth.canWrite = rule.modes.includes("write");
  auth.canAppend = rule.modes.includes("append");
  auth.canReadWriteAcl = rule.modes.includes("control");
}

/**
 * Remove an authorization's remaining triples once no subject is left —
 * a rule that names no agent grants nothing (fail-closed) but is clutter.
 */
function pruneEmptyAuthorization(auth: Authorization): void {
  if (
    auth.agent.size > 0 ||
    auth.agentClass.size > 0 ||
    auth.origin.size > 0 ||
    auth.agentGroup !== undefined
  ) {
    return;
  }
  const subject = DataFactory.namedNode(auth.value);
  for (const quad of [...auth.dataset.match(subject as Term)]) {
    auth.dataset.delete(quad);
  }
}

function toTurtle(dataset: DatasetCore): Promise<string> {
  return new Promise((resolve, reject) => {
    const writer = new Writer({
      format: "text/turtle",
      prefixes: { acl: ACL, foaf: "http://xmlns.com/foaf/0.1/" },
    });
    for (const quad of dataset) writer.addQuad(quad);
    writer.end((err, result) => (err ? reject(err) : resolve(result)));
  });
}

// ─── App identity ───────────────────────────────────────────────────────────

/** Human-readable identity for an agent. Name + homepage only — never logos. */
export interface AppIdentity {
  agentId: string;
  /** `client_name` → profile name → URL host. Never empty. */
  name: string;
  /** `client_uri` → the agent URL's origin. */
  homepage?: string;
}

/**
 * Resolve a human-readable identity for an app agent by dereferencing its URL:
 * a Client Identifier Document (JSON-LD `client_name` / `client_uri`) where
 * available, else an RDF profile name, else the URL's host. **Never loads
 * remote logos** (accepted design decision — privacy/CSP). All failures fall
 * back silently: identity is cosmetic and must never break the list.
 *
 * @param fetchImpl - test-only override; omit in production.
 */
export async function fetchAppIdentity(
  agentId: string,
  fetchImpl?: typeof fetch,
): Promise<AppIdentity> {
  const fallback = fallbackIdentity(agentId);
  let res: Response;
  try {
    const doFetch = fetchImpl ?? fetch;
    res = await doFetch(agentId, {
      headers: {
        accept: "application/ld+json, application/json;q=0.9, text/turtle;q=0.8",
      },
      signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(8000) : undefined,
    });
  } catch {
    return fallback;
  }
  if (!res.ok) return fallback;
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  try {
    if (contentType.includes("json") && !contentType.includes("ld+json")) {
      return identityFromClientDocument(agentId, await res.json(), fallback);
    }
    if (contentType.includes("ld+json")) {
      // A Client Identifier Document is JSON-LD; read the registration fields
      // directly (they are plain JSON keys in the OIDC registration vocab).
      const body = await res.text();
      const parsed: unknown = JSON.parse(body);
      const fromCid = identityFromClientDocument(agentId, parsed, undefined);
      if (fromCid) return fromCid;
      return identityFromRdf(agentId, body, contentType, res.url, fallback);
    }
    return identityFromRdf(agentId, await res.text(), contentType, res.url, fallback);
  } catch {
    return fallback;
  }
}

function identityFromClientDocument(
  agentId: string,
  doc: unknown,
  fallback: AppIdentity,
): AppIdentity;
function identityFromClientDocument(
  agentId: string,
  doc: unknown,
  fallback: undefined,
): AppIdentity | undefined;
function identityFromClientDocument(
  agentId: string,
  doc: unknown,
  fallback: AppIdentity | undefined,
): AppIdentity | undefined {
  if (typeof doc !== "object" || doc === null) return fallback;
  const record = doc as Record<string, unknown>;
  const name = typeof record.client_name === "string" ? record.client_name : undefined;
  const homepage = typeof record.client_uri === "string" ? record.client_uri : undefined;
  if (!name && !homepage) return fallback;
  return {
    agentId,
    name: name ?? fallback?.name ?? hostOf(agentId) ?? agentId,
    homepage: homepage ?? fallback?.homepage,
  };
}

async function identityFromRdf(
  agentId: string,
  body: string,
  contentType: string,
  finalUrl: string,
  fallback: AppIdentity,
): Promise<AppIdentity> {
  try {
    const dataset = await parseRdf(body, contentType, { baseIRI: finalUrl || agentId });
    const agent = new ProfileAgent(agentId, dataset, DataFactory);
    const name = agent.displayName;
    return {
      agentId,
      name: name && name !== agentId ? name : fallback.name,
      homepage: agent.homepage ?? fallback.homepage,
    };
  } catch {
    return fallback;
  }
}

function fallbackIdentity(agentId: string): AppIdentity {
  const host = hostOf(agentId);
  if (!host) return { agentId, name: agentId };
  try {
    return { agentId, name: host, homepage: new URL(agentId).origin };
  } catch {
    return { agentId, name: host };
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/** Union of every grant across an app's categories (for "remove all access"). */
export function allGrants(app: AppAccess): AccessGrant[] {
  const out: AccessGrant[] = [];
  const seen = new Set<string>();
  for (const category of app.categories) {
    for (const g of category.grants) {
      const key = `${g.aclUrl}|${g.authorization}|${g.target}|${g.inherits}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(g);
    }
  }
  return out;
}

/** Plain-language verb phrase for a set of modes (DESIGN.md §6 copy). */
export function describeModes(modes: AccessMode[]): string {
  const parts: string[] = [];
  if (modes.includes("read")) parts.push("see");
  if (modes.includes("append")) parts.push("add to");
  if (modes.includes("write")) parts.push("change");
  if (modes.includes("control")) parts.push("manage sharing of");
  if (parts.length === 0) return "access";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
