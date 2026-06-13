// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Per-resource access control — the read/write model behind the Sharing panel
 * (feature-completeness plan Wave 3, Cluster B).
 *
 * Where {@link ./permissions.ts} answers "which *apps* can reach which
 * *categories*" (the by-app / by-category Connected-apps view), this module
 * answers the orthogonal question the Sharing panel asks: **for ONE resource,
 * who has which access, set where?** Both read the same `.acl` documents and
 * mutate them through the same sanctioned path — `@solid/object`'s typed
 * `AclResource` / `Authorization` wrappers, never hand-built triples
 * (the `solid-wac` house rule).
 *
 * The model groups subjects the way humans think about them, not the way WAC
 * stores them:
 *   - an **agent** (a person/app, by WebID — `acl:agent`)
 *   - a **group** (`acl:agentGroup`, a vcard/foaf Group document)
 *   - **public** (`acl:agentClass foaf:Agent` — anyone, even logged-out)
 *   - **authenticated** (`acl:agentClass acl:AuthenticatedAgent` — any
 *     logged-in agent)
 * …each at a plain-language **level** (Can view / Can edit / Owner), not raw
 * modes (feature plan §1, parity doc §5 — no jargon, ever).
 *
 * Inheritance is surfaced honestly: an effective entry is either **set
 * directly** on the resource (`acl:accessTo`) or **inherited** from a parent
 * container's `acl:default`. Reading walks accessTo first, falling back to the
 * nearest ancestor's `acl:default` when the resource has no own ACL document
 * (the monolithic WAC walk — `solid-wac` skill).
 *
 * Fail-closed: every read/parse/write error surfaces as a typed error from
 * {@link ./errors.ts}; nothing is ever guessed. Writes are conditional
 * (`If-Match` ETag) and atomic per document; a `409`/`412` conflict is retried
 * once after re-reading, then surfaces.
 *
 * SELF-LOCKOUT GUARD: the panel must never let a user strip their OWN Control
 * from a resource. {@link wouldLockOutOwner} is the single predicate the UI and
 * the writer both consult; the writer additionally refuses the mutation
 * fail-closed even if a caller forgets to check.
 */
import { AclResource, Authorization, Group } from "@solid/object";
import { DataFactory, Store, Writer } from "n3";
import type { DatasetCore, Term } from "@rdfjs/types";
import { freshRdf } from "./rdf-read.js";
import { RdfFetchError } from "@jeswr/fetch-rdf";
import {
  AclDiscoveryError,
  AclReadError,
  AclWriteError,
  AcpUnsupportedError,
  NotAuthenticatedError,
} from "./errors.js";
import { aclUrlFromLinkHeader, type AccessMode } from "./permissions.js";

const ACL = "http://www.w3.org/ns/auth/acl#";
const ACP = "http://www.w3.org/ns/solid/acp#";
const FOAF_AGENT = "http://xmlns.com/foaf/0.1/Agent";
const AUTHENTICATED_AGENT = `${ACL}AuthenticatedAgent`;

/** True for a clearly-ACP control document (`.acr`), which we don't edit. */
function isAcpControlUrl(aclUrl: string): boolean {
  try {
    return new URL(aclUrl).pathname.endsWith(".acr");
  } catch {
    return aclUrl.endsWith(".acr");
  }
}

/** True when a dataset carries ACP-namespace triples (an ACP document). */
function datasetUsesAcp(dataset: DatasetCore): boolean {
  for (const q of dataset) {
    if (q.predicate.value.startsWith(ACP)) return true;
    if (q.object.termType === "NamedNode" && q.object.value.startsWith(ACP)) return true;
  }
  return false;
}

/**
 * A plain-language access level — what the Sharing panel shows instead of raw
 * WAC modes (feature plan §1):
 *   - `add`   → Append only (can add, can't read/change) — the WAC `append`
 *     mode standing alone; surfaced honestly as "Can add" so an append-only
 *     rule is never misrepresented as readable, nor silently downgraded to
 *     read when edited (roborev).
 *   - `view`  → Read
 *   - `edit`  → Read + Write + Append
 *   - `owner` → Read + Write + Control (full control, incl. re-sharing)
 *
 * The raw modes are always kept on {@link AccessEntry.modes} so detail is never
 * lost regardless of the displayed level.
 */
export type AccessLevel = "add" | "view" | "edit" | "owner";

/**
 * The kind of subject a rule names — how the panel groups + labels it.
 * `origin` is a browser-app web origin (`acl:origin`), surfaced READ-ONLY
 * (managed in Connected apps). `class` is any OTHER `acl:agentClass` value the
 * panel doesn't model as public/authenticated; it is surfaced READ-ONLY too so
 * access is never under-reported, and preserved verbatim through writes /
 * materialisation (never silently dropped).
 */
export type SubjectKind =
  | "agent"
  | "group"
  | "public"
  | "authenticated"
  | "origin"
  | "class";

/** A subject the panel can address: a who + how-it-is-named. */
export interface AccessSubject {
  kind: SubjectKind;
  /**
   * The WebID (agent) or group-document IRI (group). Empty for public /
   * authenticated — those are singletons addressed by {@link SubjectKind}.
   */
  id: string;
}

/** Where a rule lives relative to the resource being shared. */
export type AccessSource =
  /** Set directly on this resource (`acl:accessTo`). */
  | "direct"
  /** Inherited from a parent container's `acl:default`. */
  | "inherited";

/** One row in the "who has access" view for a resource. */
export interface AccessEntry {
  subject: AccessSubject;
  /** Plain-language level (the highest the modes add up to). */
  level: AccessLevel;
  /** The raw WAC modes, kept so detail/append is never lost. */
  modes: AccessMode[];
  /** Direct on the resource, or inherited from an ancestor's default. */
  source: AccessSource;
}

/** The full effective-access read model for one resource. */
export interface ResourceAccess {
  /** The resource the panel is sharing. */
  resourceUrl: string;
  /** The ACL document that governs it (may be an ancestor's). */
  aclUrl: string;
  /**
   * True when the governing ACL is an ANCESTOR's (this resource has no own
   * `.acl`), so every entry is inherited and "Set specific access" is offered.
   */
  inherited: boolean;
  /** All effective entries, owner-first then by level. */
  entries: AccessEntry[];
}

// ─── Level ⇄ modes ────────────────────────────────────────────────────────────

/** The WAC modes a level writes. Owner = full control over the resource. */
export function modesForLevel(level: AccessLevel): AccessMode[] {
  switch (level) {
    case "add":
      return ["append"];
    case "view":
      return ["read"];
    case "edit":
      return ["read", "write", "append"];
    case "owner":
      // Owner is a superset of edit + Control: include append explicitly so
      // promoting someone to Owner never removes their ability to ADD contained
      // resources (WAC Write does not imply Append) (roborev High).
      return ["read", "write", "append", "control"];
  }
}

/**
 * The plain-language level a set of modes adds up to (the highest honest
 * label). Control ⇒ owner; write ⇒ edit; read ⇒ view; append-only (no read)
 * ⇒ add. An append-only rule is reported as `add`, never `view`, so it is
 * neither misrepresented as readable nor silently downgraded when edited.
 */
export function levelForModes(modes: Iterable<AccessMode>): AccessLevel {
  const set = new Set(modes);
  if (set.has("control")) return "owner";
  if (set.has("write")) return "edit";
  if (set.has("read")) return "view";
  if (set.has("append")) return "add";
  return "view";
}

const LEVEL_RANK: Record<AccessLevel, number> = { owner: 0, edit: 1, view: 2, add: 3 };

// ─── Subject helpers ──────────────────────────────────────────────────────────

/**
 * A stable key for de-duping/identifying a subject across rules. Only `public`
 * and `authenticated` are singletons (one each per resource); `agent`, `group`
 * and `origin` are keyed by IRI so multiple distinct subjects of the same kind
 * (e.g. several `acl:origin` apps) never collapse into one (roborev High).
 */
export function subjectKey(s: AccessSubject): string {
  return s.kind === "public" || s.kind === "authenticated" ? s.kind : `${s.kind}|${s.id}`;
}

function sameSubject(a: AccessSubject, b: AccessSubject): boolean {
  return subjectKey(a) === subjectKey(b);
}

const MODE_ORDER: AccessMode[] = ["read", "append", "write", "control"];
function sortModes(modes: Iterable<AccessMode>): AccessMode[] {
  return [...new Set(modes)].sort((a, b) => MODE_ORDER.indexOf(a) - MODE_ORDER.indexOf(b));
}

function modesOf(auth: Authorization): AccessMode[] {
  const out: AccessMode[] = [];
  if (auth.canRead) out.push("read");
  if (auth.canWrite) out.push("write");
  if (auth.canAppend) out.push("append");
  if (auth.canReadWriteAcl) out.push("control");
  return out;
}

/** The named-IRI objects of a predicate on an auth subject (defensive). */
function irisOf(auth: Authorization, predicate: string): string[] {
  const subject = DataFactory.namedNode(auth.value);
  const out: string[] = [];
  for (const q of auth.dataset.match(subject as Term, DataFactory.namedNode(predicate))) {
    if (q.object.termType === "NamedNode") out.push(q.object.value);
  }
  return out;
}

/** The subjects a single authorization names (across all of WAC's vocab). */
function subjectsOf(auth: Authorization): AccessSubject[] {
  const out: AccessSubject[] = [];
  for (const id of auth.agent) out.push({ kind: "agent", id });
  // Group: the wrapper exposes a single agentGroup; match quads for multiples.
  for (const id of irisOf(auth, `${ACL}agentGroup`)) out.push({ kind: "group", id });
  for (const cls of auth.agentClass) {
    if (cls === FOAF_AGENT) out.push({ kind: "public", id: "" });
    else if (cls === AUTHENTICATED_AGENT) out.push({ kind: "authenticated", id: "" });
    // Any OTHER agentClass is surfaced read-only (keyed by the class IRI) so
    // access is never under-reported, and preserved verbatim on write.
    else out.push({ kind: "class", id: cls });
  }
  // Browser-app origins (`acl:origin`) are surfaced READ-ONLY so the panel
  // never under-reports access; they are managed in Connected apps, not edited
  // inline here. The writer never touches origin rules (detachSubject has no
  // origin case), so they survive every per-resource mutation.
  for (const id of auth.origin) out.push({ kind: "origin", id });
  return out;
}

// ─── Backend seam ─────────────────────────────────────────────────────────────

/**
 * The per-resource sharing backend. Mirrors {@link ./permissions.ts}'s
 * `PermissionsBackend` seam so an ACP (`.acr`) implementation can land later
 * without touching the panel. WAC today.
 */
export interface ResourceSharingBackend {
  /** Build the effective-access read model for `resourceUrl`. */
  read(resourceUrl: string): Promise<ResourceAccess>;
  /**
   * Set a subject's access on the resource to `level` (creating, upgrading or
   * downgrading the rule). Promoting an inherited resource to its own ACL
   * MATERIALISES the inherited rules first (the WAC walk is monolithic — a
   * fresh ACL replaces, never merges with, the ancestor's).
   *
   * @throws AclWriteError fail-closed on any server rejection, and
   *   specifically when the change would strip the current user's own Control
   *   (self-lockout guard) — callers should pre-check with
   *   {@link wouldLockOutOwner}.
   */
  setAccess(
    resourceUrl: string,
    subject: AccessSubject,
    level: AccessLevel,
  ): Promise<void>;
  /**
   * Remove a subject from the resource's own ACL entirely. Refuses (fail-closed
   * AclWriteError) when it would remove the current user's last Control.
   */
  removeAccess(resourceUrl: string, subject: AccessSubject): Promise<void>;
}

// ─── Self-lockout guard ─────────────────────────────────────────────────────

/**
 * Would applying `change` to `access` leave the current user (`ownerWebId`)
 * without Control of the resource? The single predicate the panel and the
 * writer both consult.
 *
 * Conservative by design: it only considers Control that the user holds *as a
 * named agent* (`acl:agent`) — Control inherited via a group or `agentClass`
 * is real but not something this panel can keep stable, so we never let the
 * user's named Control be removed/downgraded if it is the only Control they
 * have here. (A pure-inherited entry can't be removed by this panel anyway —
 * the writer only mutates the resource's own ACL.)
 *
 * @param change - the pending mutation. `remove` drops the subject; otherwise
 *   the subject is set to `level`.
 */
export function wouldLockOutOwner(
  access: ResourceAccess,
  ownerWebId: string,
  change: { subject: AccessSubject; level: AccessLevel } | { subject: AccessSubject; remove: true },
): boolean {
  const ownerSubject: AccessSubject = { kind: "agent", id: ownerWebId };
  // Only the owner's OWN entry is at stake here.
  if (!sameSubject(change.subject, ownerSubject)) return false;

  // Does the owner currently hold Control as a named agent on this resource?
  const current = access.entries.find((e) => sameSubject(e.subject, ownerSubject));
  const hasControlNow = current?.modes.includes("control") ?? false;
  if (!hasControlNow) return false; // can't lose what they don't have here

  // After the change: removing, or downgrading below owner, drops Control.
  if ("remove" in change) return true;
  return change.level !== "owner";
}

// ─── WAC backend ──────────────────────────────────────────────────────────────

/** WAC implementation of the {@link ResourceSharingBackend} seam. */
export class WacResourceSharingBackend implements ResourceSharingBackend {
  /**
   * @param ownerWebId - the signed-in user's WebID; the self-lockout guard
   *   protects this agent's Control.
   * @param fetchImpl - test-only override. **Omit in production** so the
   *   auth-patched global fetch runs (AGENTS.md §Reading data).
   */
  constructor(
    private readonly ownerWebId: string,
    private readonly fetchImpl?: typeof fetch,
  ) {
    if (!ownerWebId) throw new NotAuthenticatedError();
  }

  private call(input: string, init?: RequestInit): Promise<Response> {
    return (this.fetchImpl ?? fetch)(input, init);
  }

  /**
   * Discover the ACL document URL governing a resource from its
   * `Link: rel="acl"` header (never guessed). Uses GET (the auth-patched fetch
   * only replays the 401→DPoP upgrade for GET). Returns the URL plus whether the
   * resource exists; `undefined` when the resource itself is absent.
   */
  private async discoverAclUrl(resourceUrl: string): Promise<string | undefined> {
    let res: Response;
    try {
      res = await this.call(resourceUrl, { method: "GET" });
    } catch (cause) {
      throw new AclDiscoveryError(resourceUrl, { cause });
    }
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new AclDiscoveryError(resourceUrl);
    const acl = aclUrlFromLinkHeader(res.headers.get("link"), resourceUrl);
    if (!acl) throw new AclDiscoveryError(resourceUrl);
    return acl;
  }

  /** Fetch + parse one ACL document. `404` → `undefined` (governed elsewhere). */
  private async readAcl(
    aclUrl: string,
  ): Promise<{ dataset: DatasetCore; etag: string | null } | undefined> {
    try {
      const { dataset, etag } = await freshRdf(aclUrl, this.fetchImpl);
      return { dataset, etag };
    } catch (e) {
      if (e instanceof RdfFetchError && e.status === 404) return undefined;
      throw new AclReadError(aclUrl, { cause: e });
    }
  }

  async read(resourceUrl: string): Promise<ResourceAccess> {
    const aclUrl = await this.discoverAclUrl(resourceUrl);
    if (!aclUrl) {
      throw new AclDiscoveryError(resourceUrl);
    }
    // ACP servers advertise an `.acr` control document. We only do WAC: fail
    // closed on a clearly-ACP slot rather than parsing it as an empty WAC ACL
    // (under-reporting) or PUTting WAC triples into it (roborev High).
    if (isAcpControlUrl(aclUrl)) throw new AcpUnsupportedError(resourceUrl);
    // The server's Link header points at the resource's OWN acl slot, but that
    // document may not exist (then an ancestor's acl:default governs). Read it;
    // if absent, the effective rules are inherited.
    const own = await this.readAcl(aclUrl);
    if (own) {
      // Defence-in-depth: even a `.acl`-named document can carry ACP triples on
      // a hybrid server — refuse to render/mutate it as WAC (roborev).
      if (datasetUsesAcp(own.dataset)) throw new AcpUnsupportedError(resourceUrl);
      // Direct: only rules whose `acl:accessTo` names THIS resource apply. A
      // single ACL document can carry rules for several targets; a rule that
      // names a different `accessTo` (or only a `default`) is not this
      // resource's access and must not be shown (roborev High — target match).
      return {
        resourceUrl,
        aclUrl,
        inherited: false,
        entries: this.entriesFrom(own.dataset, resourceUrl, "direct", {
          accessTo: resourceUrl,
        }),
      };
    }
    // No own ACL — find the nearest ancestor that has one and read its
    // `acl:default` rules (those are what actually apply). Only rules whose
    // `acl:default` names THAT ancestor container govern this resource.
    const ancestor = await this.findInheritedAcl(resourceUrl, aclUrl);
    return {
      resourceUrl,
      aclUrl, // the slot the panel would PUT to when "Set specific access" is chosen
      inherited: true,
      entries: ancestor
        ? this.entriesFrom(ancestor.dataset, ancestor.url, "inherited", {
            default: ancestor.container,
          })
        : [],
    };
  }

  /**
   * Walk parent containers from `resourceUrl` to the origin root, returning the
   * first ancestor ACL document that exists. `selfAclUrl` is skipped (it was
   * already found absent).
   */
  private async findInheritedAcl(
    resourceUrl: string,
    selfAclUrl: string,
  ): Promise<{ url: string; container: string; dataset: DatasetCore } | undefined> {
    for (const container of ancestorContainers(resourceUrl)) {
      // Only a genuinely-absent ancestor (404 → undefined) is skipped; any
      // other discovery/read failure (401/403/network) PROPAGATES so the panel
      // fails closed rather than underreporting inherited access (roborev).
      const aclUrl = await this.discoverAclUrl(container);
      if (!aclUrl || aclUrl === selfAclUrl) continue;
      if (isAcpControlUrl(aclUrl)) throw new AcpUnsupportedError(resourceUrl);
      const doc = await this.readAcl(aclUrl);
      if (doc) {
        if (datasetUsesAcp(doc.dataset)) throw new AcpUnsupportedError(resourceUrl);
        return { url: aclUrl, container, dataset: doc.dataset };
      }
    }
    return undefined;
  }

  /**
   * Project an ACL dataset into effective entries that apply to a specific
   * target. A single ACL document can carry rules for many targets; only those
   * whose `acl:accessTo` (direct read) or `acl:default` (inherited read) names
   * `match` actually govern the resource being shared, so unrelated rules are
   * skipped (roborev High — target match).
   */
  private entriesFrom(
    dataset: DatasetCore,
    aclUrl: string,
    source: AccessSource,
    match: { accessTo: string } | { default: string },
  ): AccessEntry[] {
    const predicate = "accessTo" in match ? `${ACL}accessTo` : `${ACL}default`;
    const target = "accessTo" in match ? match.accessTo : match.default;
    const acl = new AclResource(dataset, DataFactory);
    const byKey = new Map<string, AccessEntry>();
    for (const auth of acl.authorizations) {
      const modes = modesOf(auth);
      if (modes.length === 0) continue;
      // The rule must name our exact target on the relevant predicate.
      if (!irisOf(auth, predicate).some((iri) => sameResource(iri, target))) continue;
      for (const subject of subjectsOf(auth)) {
        const key = subjectKey(subject);
        const existing = byKey.get(key);
        const merged = sortModes([...(existing?.modes ?? []), ...modes]);
        byKey.set(key, {
          subject,
          modes: merged,
          level: levelForModes(merged),
          source,
        });
      }
    }
    return sortEntries([...byKey.values()]);
  }

  async setAccess(
    resourceUrl: string,
    subject: AccessSubject,
    level: AccessLevel,
  ): Promise<void> {
    // Self-lockout guard (defence-in-depth — refuse even if the UI didn't).
    const before = await this.read(resourceUrl);
    if (wouldLockOutOwner(before, this.ownerWebId, { subject, level })) {
      throw new AclWriteError(
        before.aclUrl,
        "That would remove your own ability to manage this resource. Keep yourself as Owner.",
      );
    }
    await this.mutateOwnAcl(resourceUrl, before, (dataset, ownAclUrl) => {
      writeSubjectRule(dataset, ownAclUrl, resourceUrl, subject, modesForLevel(level));
    });
  }

  async removeAccess(resourceUrl: string, subject: AccessSubject): Promise<void> {
    const before = await this.read(resourceUrl);
    if (wouldLockOutOwner(before, this.ownerWebId, { subject, remove: true })) {
      throw new AclWriteError(
        before.aclUrl,
        "That would remove your own ability to manage this resource. Keep yourself as Owner.",
      );
    }
    // When access is inherited, removal MATERIALISES a resource-specific ACL
    // that copies the inherited rules EXCEPT this subject — the honest meaning
    // of "remove" here is "this item should not grant that subject, even though
    // the folder does". (mutateOwnAcl does the materialise; the mutate then
    // drops the subject from the freshly-copied, now resource-targeted rules.)
    // We never edit the ancestor the user didn't ask to touch.
    await this.mutateOwnAcl(resourceUrl, before, (dataset) => {
      removeSubjectRules(dataset, subject, resourceUrl);
    });
  }

  /**
   * Read-modify-write the resource's OWN ACL document with `If-Match`. When the
   * resource currently inherits (no own ACL), MATERIALISE the inherited rules
   * into a fresh document first (the WAC walk is monolithic — a new ACL
   * replaces the ancestor's; without copying we'd silently drop everyone else's
   * access). The fresh document always carries the owner's Control.
   *
   * Retries once on `409`/`412` (a concurrent write) by re-reading; any other
   * failure throws {@link AclWriteError} (fail-closed).
   */
  private async mutateOwnAcl(
    resourceUrl: string,
    access: ResourceAccess,
    mutate: (dataset: DatasetCore, ownAclUrl: string) => void,
  ): Promise<void> {
    const ownAclUrl = access.aclUrl;
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await this.readAcl(ownAclUrl);
      let dataset: DatasetCore;
      let etag: string | null | "create";
      if (existing) {
        // Race guard: the slot may have become an ACP document between the
        // initial read() and now — never PUT WAC triples into ACP data
        // (roborev). Fail closed.
        if (datasetUsesAcp(existing.dataset)) {
          throw new AcpUnsupportedError(resourceUrl);
        }
        // An existing ACL with NO ETag would force an unconditional PUT, which
        // could clobber a concurrent change to access-control data. Fail closed
        // rather than write blind (roborev) — re-reading later will usually
        // carry an ETag; a server that never sends one needs a real fix, not a
        // silent overwrite.
        if (existing.etag === null) {
          throw new AclWriteError(
            ownAclUrl,
            "Couldn't safely update the access settings (the server didn't provide a version tag). Nothing was changed.",
          );
        }
        dataset = existing.dataset;
        etag = existing.etag;
      } else if (access.inherited) {
        // Materialise: copy the inherited effective rules into a new document
        // so promoting this resource to its own ACL never strips others. The
        // snapshot in `access` may be stale if the PARENT changed since the
        // initial read(), so RE-READ the inherited access right now and
        // materialise from the fresh state — otherwise we could write back
        // grants just revoked upstream (roborev). If the re-read shows the
        // resource is no longer inherited, loop and take the existing/direct
        // path instead.
        const fresh = await this.read(resourceUrl);
        if (!fresh.inherited) {
          access = fresh;
          continue;
        }
        dataset = new Store();
        materialiseInherited(dataset, ownAclUrl, resourceUrl, fresh.entries);
        etag = "create";
      } else {
        // The resource HAD its own direct ACL at read() but it's gone now —
        // another client deleted it concurrently. Recreating from the stale
        // snapshot (with If-None-Match: *) could restore grants they just
        // removed, so treat this as a conflict: re-read and retry (roborev).
        access = await this.read(resourceUrl);
        continue;
      }
      mutate(dataset, ownAclUrl);
      // ALWAYS guarantee the owner holds a NAMED Control rule on this resource
      // after the mutation — for existing ACLs too, not just freshly-
      // materialised ones. The wouldLockOutOwner guard only protects Control
      // the owner holds as a named agent; if their only Control came via
      // public/authenticated/group (which this panel may legitimately edit),
      // that guard wouldn't fire, so without this the owner could be locked out
      // (roborev High). ensureOwnerControl is idempotent — a no-op when a named
      // owner-Control rule already exists.
      ensureOwnerControl(dataset, ownAclUrl, resourceUrl, this.ownerWebId);
      const status = await this.tryPutAcl(ownAclUrl, dataset, etag);
      if (status === "ok") return;
      if (status !== "conflict") {
        throw new AclWriteError(ownAclUrl, undefined, { cause: status });
      }
      // conflict: re-read (the resource may now have its own ACL) and re-apply.
      access = await this.read(resourceUrl);
    }
    throw new AclWriteError(
      ownAclUrl,
      "The access settings changed while saving. Nothing was changed — try again.",
    );
  }

  private async tryPutAcl(
    aclUrl: string,
    dataset: DatasetCore,
    etag: string | null | "create",
  ): Promise<"ok" | "conflict" | "forbidden" | unknown> {
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
    if (res.status === 412 || res.status === 409) return "conflict";
    if (res.status === 403 || res.status === 401) return "forbidden";
    return `PUT ${aclUrl} -> ${res.status}`;
  }
}

// ─── Authoring (typed wrapper only — never hand-built triples) ────────────────

/**
 * Set/replace one subject's rule for `resourceUrl` in `dataset`. Removes any
 * existing rules that name this subject AND target this resource first (so a
 * level change is a clean replace, not a union) — rules for OTHER targets in
 * the same ACL document are left untouched (roborev High — scoped removal) —
 * then writes one authorization at the new modes. A modes list of length 0
 * removes the subject without re-adding it.
 */
function writeSubjectRule(
  dataset: DatasetCore,
  aclUrl: string,
  resourceUrl: string,
  subject: AccessSubject,
  modes: AccessMode[],
): void {
  removeSubjectRules(dataset, subject, resourceUrl);
  if (modes.length === 0) return;
  const iri = `${aclUrl}#${ruleFragment(subject, resourceUrl)}`;
  const auth = new Authorization(iri, dataset, DataFactory);
  auth.type.add(`${ACL}Authorization`);
  auth.accessTo = resourceUrl;
  if (resourceUrl.endsWith("/")) auth.default = resourceUrl; // containers inherit
  attachSubject(auth, subject);
  auth.canRead = modes.includes("read");
  auth.canWrite = modes.includes("write");
  auth.canAppend = modes.includes("append");
  auth.canReadWriteAcl = modes.includes("control");
}

/** Attach a subject to an authorization via the right typed accessor. */
function attachSubject(auth: Authorization, subject: AccessSubject): void {
  switch (subject.kind) {
    case "agent":
      auth.agent.add(subject.id);
      break;
    case "group":
      // Add the EXACT `acl:agentGroup` quad rather than the single-valued
      // wrapper setter, so a rule that already names other groups keeps them
      // (the wrapper setter is single-valued and would clobber them) (roborev).
      // A Group instance is constructed to satisfy the typed authoring path,
      // then its term is written — never a hand-built predicate string.
      auth.dataset.add(
        DataFactory.quad(
          DataFactory.namedNode(auth.value),
          DataFactory.namedNode(`${ACL}agentGroup`),
          DataFactory.namedNode(new Group(subject.id, auth.dataset, DataFactory).value),
        ),
      );
      break;
    case "public":
      auth.accessibleToAny = true;
      break;
    case "authenticated":
      auth.accessibleToAuthenticated = true;
      break;
    case "origin":
      // Preserved (e.g. when materialising an inherited resource) so a browser
      // app's origin trust is never silently dropped. The `origin` Set is the
      // typed accessor — adding to it writes the `acl:origin` triple.
      auth.origin.add(subject.id);
      break;
    case "class":
      // An unmodelled agentClass — preserved verbatim so materialisation never
      // drops it. `agentClass` is the typed accessor.
      auth.agentClass.add(subject.id);
      break;
  }
}

/**
 * Remove this subject from every authorization that names it AND targets
 * `resourceUrl` (via `acl:accessTo` or `acl:default`). A rule that also names
 * other subjects has just this subject pruned off it; a rule left naming no one
 * is deleted entirely (fail-closed — a subject-less rule grants nothing but is
 * clutter). Rules for OTHER targets in the same document are never touched, so
 * editing one resource's sharing can't silently revoke the subject elsewhere
 * (roborev High — scoped removal).
 */
function removeSubjectRules(
  dataset: DatasetCore,
  subject: AccessSubject,
  resourceUrl: string,
): void {
  const acl = new AclResource(dataset, DataFactory);
  for (const auth of [...acl.authorizations]) {
    if (!subjectsOf(auth).some((s) => sameSubject(s, subject))) continue;
    if (!authTargetsResource(auth, resourceUrl)) continue;
    // If this authorization ALSO names other targets, splitting it into a
    // resource-only authorization first means detaching the subject affects
    // ONLY this resource — never the other targets (roborev High — multi-target
    // rule). Single-target rules (the common case, and everything this writer
    // itself creates) skip the split and are detached directly.
    const resourceAuth = splitOutResourceTarget(dataset, auth, resourceUrl);
    detachSubject(resourceAuth, subject);
    pruneEmptyAuthorization(resourceAuth);
  }
}

/** True when an authorization names `resourceUrl` on accessTo or default. */
function authTargetsResource(auth: Authorization, resourceUrl: string): boolean {
  return [
    ...irisOf(auth, `${ACL}accessTo`),
    ...irisOf(auth, `${ACL}default`),
  ].some((iri) => sameResource(iri, resourceUrl));
}

/**
 * Ensure there is an authorization that applies to EXACTLY `resourceUrl` (and
 * no other target), carrying the same subjects + modes as `auth`, and return
 * it. When `auth` already targets only `resourceUrl`, it is returned unchanged.
 * Otherwise `auth` is rewritten to drop the `resourceUrl` target (keeping its
 * other targets, subjects and modes intact) and a fresh resource-only
 * authorization is cloned from it — so a later detach touches only this
 * resource (roborev High). Never hand-builds triples beyond cloning the typed
 * accessor values.
 */
function splitOutResourceTarget(
  dataset: DatasetCore,
  auth: Authorization,
  resourceUrl: string,
): Authorization {
  const accessTo = irisOf(auth, `${ACL}accessTo`);
  const defaults = irisOf(auth, `${ACL}default`);
  const otherAccessTo = accessTo.filter((t) => !sameResource(t, resourceUrl));
  const otherDefaults = defaults.filter((t) => !sameResource(t, resourceUrl));
  // Single-target (only this resource): nothing to split.
  if (otherAccessTo.length === 0 && otherDefaults.length === 0) return auth;

  // Clone a resource-only authorization carrying the same subjects + modes.
  // Derive a fresh fragment on the SAME document as the original rule.
  const base = auth.value.includes("#") ? auth.value.slice(0, auth.value.indexOf("#")) : auth.value;
  const cloneIri = `${base}#split-${base64url(`${auth.value} ${resourceUrl}`)}`;
  const clone = new Authorization(cloneIri, dataset, DataFactory);
  clone.type.add(`${ACL}Authorization`);
  if (accessTo.some((t) => sameResource(t, resourceUrl))) clone.accessTo = resourceUrl;
  if (defaults.some((t) => sameResource(t, resourceUrl))) clone.default = resourceUrl;
  for (const s of subjectsOf(auth)) attachSubject(clone, s);
  clone.canRead = auth.canRead;
  clone.canWrite = auth.canWrite;
  clone.canAppend = auth.canAppend;
  clone.canReadWriteAcl = auth.canReadWriteAcl;

  // Drop the resource target from the ORIGINAL so it keeps only its others.
  const subj = DataFactory.namedNode(auth.value);
  for (const pred of [`${ACL}accessTo`, `${ACL}default`]) {
    for (const q of [...auth.dataset.match(subj as Term, DataFactory.namedNode(pred))]) {
      if (q.object.termType === "NamedNode" && sameResource(q.object.value, resourceUrl)) {
        auth.dataset.delete(q);
      }
    }
  }
  return clone;
}

function detachSubject(auth: Authorization, subject: AccessSubject): void {
  switch (subject.kind) {
    case "agent":
      auth.agent.delete(subject.id);
      break;
    case "group":
      // Delete ONLY the exact `acl:agentGroup` quad for this group, so a rule
      // that names several groups loses just this one (the single-valued
      // wrapper setter would clear all of them, or miss a non-first group)
      // (roborev High).
      auth.dataset.delete(
        DataFactory.quad(
          DataFactory.namedNode(auth.value),
          DataFactory.namedNode(`${ACL}agentGroup`),
          DataFactory.namedNode(subject.id),
        ),
      );
      break;
    case "public":
      auth.accessibleToAny = false;
      break;
    case "authenticated":
      auth.accessibleToAuthenticated = false;
      break;
    case "origin":
      auth.origin.delete(subject.id);
      break;
    case "class":
      auth.agentClass.delete(subject.id);
      break;
  }
}

/**
 * Copy the effective inherited entries into a fresh ACL document for
 * `resourceUrl`, so promoting an inherited resource to its own ACL preserves
 * everyone's access (the monolithic WAC walk would otherwise drop them).
 */
function materialiseInherited(
  dataset: DatasetCore,
  aclUrl: string,
  resourceUrl: string,
  entries: AccessEntry[],
): void {
  for (const entry of entries) {
    writeSubjectRule(dataset, aclUrl, resourceUrl, entry.subject, entry.modes);
  }
}

/** Guarantee the owner holds the FULL Owner mode set on this resource. */
function ensureOwnerControl(
  dataset: DatasetCore,
  aclUrl: string,
  resourceUrl: string,
  ownerWebId: string,
): void {
  const acl = new AclResource(dataset, DataFactory);
  const ownerSubject: AccessSubject = { kind: "agent", id: ownerWebId };
  const ownerModes = modesForLevel("owner");
  for (const auth of acl.authorizations) {
    // The rule must name the owner, target THIS resource, AND grant the FULL
    // owner mode set — a Control-only rule would label the user "Owner" while
    // leaving them unable to read/edit/add (roborev). A shared ACL document may
    // carry an owner rule for a SIBLING target, which doesn't protect this one.
    const protects =
      authTargetsResource(auth, resourceUrl) &&
      subjectsOf(auth).some((s) => sameSubject(s, ownerSubject)) &&
      ownerModes.every((m) => modesOf(auth).includes(m));
    if (protects) return; // already fully owner on this resource
  }
  // writeSubjectRule replaces any partial owner rule on this resource with a
  // complete one (it removes the subject's matching-target rules first).
  writeSubjectRule(dataset, aclUrl, resourceUrl, ownerSubject, ownerModes);
}

/** Delete an authorization's triples once it names no subject. */
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

/**
 * A stable, collision-resistant rule fragment for a (subject, target) pair.
 * The TARGET is part of the key so that when one ACL document governs several
 * resources (a shared `.acl`), the same subject on two targets gets two
 * distinct rule subjects — setting access for one never overwrites the other
 * (roborev High — fragment collision). Stable per pair, so a re-grant reuses
 * the same rule (a clean replace).
 */
function ruleFragment(subject: AccessSubject, resourceUrl: string): string {
  // Non-lossy, deterministic, collision-free: base64url over the exact
  // (kind, subject-id, target) tuple. A NUL separator keeps the components
  // unambiguous so distinct tuples can never encode to the same fragment
  // (roborev — no hash collisions). Result is always valid IRI-fragment chars.
  const sep = "\u0000";
  const key = `${subject.kind}${sep}${subject.id}${sep}${resourceUrl}`;
  return `rule-${base64url(key)}`;
}

/** Deterministic, reversible, URL-safe base64 of a UTF-8 string. */
function base64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  // `btoa` is available in the browser and in Node ≥16.
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

// ─── Misc ───────────────────────────────────────────────────────────────────

/** Owner-first, then by level, then by subject kind/id — a stable UI order. */
function sortEntries(entries: AccessEntry[]): AccessEntry[] {
  const kindRank: Record<SubjectKind, number> = {
    agent: 0,
    group: 1,
    origin: 2,
    class: 3,
    authenticated: 4,
    public: 5,
  };
  return entries.sort((a, b) => {
    const lvl = LEVEL_RANK[a.level] - LEVEL_RANK[b.level];
    if (lvl !== 0) return lvl;
    const kind = kindRank[a.subject.kind] - kindRank[b.subject.kind];
    if (kind !== 0) return kind;
    return a.subject.id.localeCompare(b.subject.id);
  });
}

/**
 * The parent containers of a resource URL, nearest-first, up to (and including)
 * the origin root. Exported for tests.
 */
export function ancestorContainers(resourceUrl: string): string[] {
  let url: URL;
  try {
    url = new URL(resourceUrl);
  } catch {
    return [];
  }
  const out: string[] = [];
  // Strip a trailing slash to step up from a container to its parent.
  let path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  while (path.length > 0) {
    const slash = path.lastIndexOf("/");
    if (slash < 0) break;
    const parent = path.slice(0, slash + 1);
    out.push(`${url.origin}${parent}`);
    if (parent === "/") break;
    path = parent.slice(0, -1);
  }
  return out;
}

/**
 * Resource-IRI equality for ACL targets — EXACT match. `/foo` and `/foo/` are
 * distinct IRIs in WAC (a container vs a resource named `foo`), so we must not
 * treat them as the same target; doing so could surface or mutate rules for the
 * wrong resource (roborev). Container inputs are canonicalised (trailing slash)
 * before they reach the ACL-matching code — see {@link ancestorContainers} and
 * the read entrypoint — so an exact comparison is both correct and safe. Never
 * loosen this into prefix/substring/slash-insensitive matching.
 */
function sameResource(a: string, b: string): boolean {
  return a === b;
}

/** Plain-language label per level — WAC jargon never reaches the UI. */
export const LEVEL_LABEL: Record<AccessLevel, string> = {
  add: "Can add",
  view: "Can view",
  edit: "Can edit",
  owner: "Owner",
};

/** A one-line description of what a level lets the subject do. */
export const LEVEL_DESCRIPTION: Record<AccessLevel, string> = {
  add: "Add new items, but not see or change what's there.",
  view: "Read this, but not change it.",
  edit: "Read and make changes.",
  owner: "Full control, including who else can access it.",
};

/**
 * An honest one-line description of an entry's ACTUAL modes, not just its
 * level. A `view` entry that also carries `append` (read+append, no write) is
 * described as "…and add", so the panel never misrepresents append as plain
 * read (roborev). The level itself stays simple; this only enriches the copy.
 */
export function describeEntryAccess(entry: AccessEntry): string {
  if (entry.level === "view" && entry.modes.includes("append")) {
    return "Read this and add new items, but not change what's there.";
  }
  return LEVEL_DESCRIPTION[entry.level];
}

/** Plain-language label per subject kind, for the "who" column. */
export function subjectLabel(subject: AccessSubject): string {
  switch (subject.kind) {
    case "public":
      return "Anyone on the web";
    case "authenticated":
      return "Anyone signed in";
    case "group":
      return "A group";
    case "origin":
      return "A browser app";
    case "class":
      return "A group of agents";
    case "agent":
      return subject.id;
  }
}
