// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Federation tasks — the "Assigned to me" view (pss-erv MVP + pss-6ae + pss-l87).
 *
 * Discovers `wf:Task` resources across the pods the user can read — their OWN
 * pods AND the pods of agents they have authorized (friends / contacts) — and
 * surfaces the subset where `wf:assignee == the logged-in WebID`. This is the
 * consumption side of the SHARED TASK MODEL: PM and solid-issues both stamp
 * issues/tasks as `wf:Task` and register `solid:forClass wf:Task` in their owner's
 * Type Index (see `issues.ts` pss-77n), so a federation consumer can enumerate
 * every tracker's container by reading those registrations.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY — THE ASSIGNEE CLAIM IS UNTRUSTED (pss-6ae). This is the heart of the
 * module. A `wf:assignee <myWebID>` triple is just data a pod *claims*; a hostile
 * or careless foreign pod can assert "task X is assigned to you" about anyone. We
 * must therefore NEVER show a foreign task as "assigned to me" on the strength of
 * the claim alone. Two trust tiers, both verified before a task is surfaced:
 *
 *   1. OWN-POD (trusted). The task resource lives inside one of the user's OWN
 *      `pim:storage` pods (`isInOwnPods`). The user controls the bytes, so a
 *      self-assigned or owner-assigned task is authentic by construction. (PM's
 *      own issues land here.)
 *
 *   2. FOREIGN-POD (verified-provenance only). The task lives in a pod that is
 *      NOT the user's. The bare assignee claim is INSUFFICIENT. To be shown it
 *      must satisfy ALL of:
 *        (a) The task came from an AUTHORIZED ASSIGNER — a WebID the user has
 *            authorized by adding them to `foaf:knows` (friends) or saving them
 *            as a contact. A random stranger's pod is never trusted.
 *        (b) The task resource actually RESIDES IN that authorized assigner's
 *            OWN pod — verified against the assigner's advertised `pim:storage`
 *            (read from the assigner's profile). This binds the claim to a pod
 *            the assigner demonstrably controls: a third pod cannot impersonate a
 *            trusted friend by hosting a task that merely *names* the friend.
 *        (c) The assigner's WebID was DISCOVERED as a federation source (we
 *            enumerated their Type Index for `wf:Task`), not free-text — so the
 *            URL we fetched is bounded to the authorized set.
 *
 * The discovery walk itself is constrained: we read Type Indexes ONLY from the
 * user's own profile and from the profiles of authorized agents. We never
 * dereference an arbitrary URL on the strength of pod content (a crafted
 * registration cannot steer an authenticated fetch off the authorized set — the
 * container we list must be within an authorized source's own storage).
 *
 * RESIDUAL: DNS-rebinding on a foreign host string is an accepted residual risk
 * (same as `agent-target.ts`); a server-side relay with DNS-pinning would close
 * it. The provenance check here is about WHO claims the assignment, not about
 * connecting to a private address (own-pod + authorized-storage URLs are already
 * the user's / a friend's public pods).
 *
 * RDF read via the typed `issues.ts` parser + `type-index.ts` accessors only —
 * never regex on RDF, never hand-built quads (house rule).
 */
import { RdfFetchError } from "@jeswr/fetch-rdf";
import { freshRdf } from "./rdf-read.js";
import { readProfile, type PodProfile } from "./profile.js";
import { profileDocUrl } from "./profile-edit.js";
import { readKnows } from "./social.js";
import { discoverRegistrations, type RegisteredLocation } from "./type-index.js";
import { ISSUE_CLASS, parseIssue, type Issue } from "./issues.js";
import { isInOwnPods } from "./pod-scope.js";
import { listContainer } from "./pod-data.js";

/**
 * A federated task surfaced in the "Assigned to me" view: the parsed task plus
 * the provenance the UI needs to show the user WHY they can trust it.
 */
export interface AssignedTask {
  /** The task resource URL (always within an authorized source's pod). */
  url: string;
  /** The parsed `wf:Task` payload (title, state, assignee, …). */
  task: Issue;
  /** Whether the task lives in one of the user's OWN pods. */
  own: boolean;
  /**
   * The authorized assigner's WebID — the agent whose pod hosts the task. For an
   * own-pod task this is the user's own WebID. For a foreign task it is the
   * verified friend/contact WebID (never the unverified pod owner of a stranger).
   */
  source: string;
}

/**
 * The set of WebIDs the user has AUTHORIZED as task assigners — their own WebID
 * (always) plus friends (`foaf:knows`) and saved-contact WebIDs. A foreign task
 * is only ever shown if its host pod belongs to one of these.
 */
export interface AuthorizedSources {
  /** The logged-in user's WebID. */
  self: string;
  /** Distinct authorized assigner WebIDs (friends + contacts), excluding self. */
  others: string[];
}

/**
 * Build the authorized-source set from the user's social graph.
 *
 * @param self        - the logged-in WebID.
 * @param friends     - `foaf:knows` WebIDs (from the user's profile).
 * @param contactWebIds - WebIDs of saved contacts (those that carry one).
 *
 * Pure. De-duplicates, drops non-WebID strings and the user's own WebID from
 * `others` (self is tracked separately, always authorized).
 */
export function buildAuthorizedSources(
  self: string,
  friends: readonly string[],
  contactWebIds: readonly string[],
): AuthorizedSources {
  const others = new Set<string>();
  for (const w of [...friends, ...contactWebIds]) {
    const v = w.trim();
    if (!v || v === self) continue;
    if (!isHttpWebId(v)) continue;
    others.add(v);
  }
  return { self, others: [...others].sort() };
}

/** True for an absolute http(s) URL usable as a WebID (mirrors issues.isWebId). */
function isHttpWebId(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Does `assignee` name the logged-in user? An exact IRI match (WebIDs are
 * compared as opaque IRIs — no normalisation beyond trimming, since a WebID is a
 * stable identifier the issuer minted). Pure.
 */
export function isAssignedToMe(assignee: string | undefined, myWebId: string): boolean {
  if (!assignee) return false;
  return assignee.trim() === myWebId.trim();
}

/**
 * VERIFY a task's provenance against the trust model (pss-6ae). Returns the
 * trusted {@link AssignedTask} when the claim is authentic, or `undefined` to
 * REJECT (the task is dropped, never shown). Pure — no I/O; the caller supplies
 * the already-fetched facts (own pods, the source WebID this URL was discovered
 * under, that source's verified storage roots).
 *
 * The function fails CLOSED on every ambiguity:
 *   - The task must actually be assigned to me (defensive re-check; the caller
 *     already filters, but provenance and assignment are verified together so a
 *     mis-wired caller cannot leak an unassigned task).
 *   - OWN-POD: `url` is within one of `ownStorages` → trusted (`own: true`,
 *     source = self). No further check; the user controls the bytes.
 *   - FOREIGN: `url` is NOT in an own pod. Then it is shown ONLY if the
 *     discovery `source` is an authorized assigner (`others`) AND `url` is
 *     within that source's OWN verified storage (`sourceStorages`). Otherwise
 *     REJECT — a foreign pod's bare claim is never trusted.
 *
 * @param url            - the task resource URL.
 * @param task           - the parsed task (must carry `wf:assignee`).
 * @param myWebId        - the logged-in WebID.
 * @param ownStorages    - the user's own `pim:storage` roots.
 * @param source         - the WebID under whose Type Index this task was
 *   discovered (self for own pods; a friend/contact for foreign ones).
 * @param sourceStorages - the discovery source's verified `pim:storage` roots
 *   (read from the source's profile). Empty/irrelevant for own-pod tasks.
 * @param authorized     - the authorized-source set.
 */
export function verifyAssignedTask(opts: {
  url: string;
  task: Issue;
  myWebId: string;
  ownStorages: readonly string[];
  source: string;
  sourceStorages: readonly string[];
  authorized: AuthorizedSources;
}): AssignedTask | undefined {
  const { url, task, myWebId, ownStorages, source, sourceStorages, authorized } = opts;

  // Defensive: provenance is only ever asserted for tasks assigned to me.
  if (!isAssignedToMe(task.assignee, myWebId)) return undefined;

  // Tier 1 — OWN POD. The user controls these bytes; the assignment is authentic.
  if (isInOwnPods(url, ownStorages)) {
    return { url, task, own: true, source: myWebId };
  }

  // Tier 2 — FOREIGN POD. The bare claim is untrusted. Require an authorized
  // assigner AND that the task resides in that assigner's OWN verified storage.
  const isAuthorizedSource = source === authorized.self || authorized.others.includes(source);
  if (!isAuthorizedSource) return undefined; // discovered under a non-authorized WebID — reject.
  if (source === authorized.self) {
    // The user's own WebID claimed a task that is NOT in their own pod — that is
    // an inconsistent (possibly spoofed) registration. Fail closed.
    return undefined;
  }
  // The task must live in the AUTHORIZED ASSIGNER's own pod — not merely be
  // hosted somewhere that names them. Binds the claim to a pod they control.
  if (!isInOwnPods(url, sourceStorages)) return undefined;

  return { url, task, own: false, source };
}

/**
 * Read one container's `wf:Task` resources and return those assigned to me.
 * Each item is parsed via the typed `issues.ts` parser; non-task / unreadable
 * resources are skipped (resilience over strictness — a broken sibling resource
 * never sinks the whole list). A missing container (404/403) yields no items.
 *
 * NOTE: this does NOT verify provenance — it only reads + assignment-filters.
 * The caller pairs each `{ url, task }` with its discovery source and runs
 * {@link verifyAssignedTask}. Kept separate so the (pure) trust decision is unit
 * testable without a pod.
 *
 * @param fetchImpl - test-only override; **omit in production** so the
 *   auth-patched global fetch runs (AGENTS.md §Reading data).
 */
async function readAssignedFromContainer(
  containerUrl: string,
  myWebId: string,
  fetchImpl?: typeof fetch,
): Promise<{ url: string; task: Issue }[]> {
  let entries: { url: string }[];
  try {
    entries = await listContainer(containerUrl, fetchImpl);
  } catch (e) {
    if (e instanceof RdfFetchError && (e.status === 404 || e.status === 403)) return [];
    throw e;
  }

  const candidates = entries.filter((entry) => !entry.url.endsWith("/")); // skip sub-containers
  const parsed = await Promise.all(
    candidates.map(async (entry) => {
      try {
        const { dataset } = await freshRdf(entry.url, fetchImpl);
        const task = parseIssue(entry.url, dataset);
        if (!task) return undefined; // not a wf:Task
        if (!isAssignedToMe(task.assignee, myWebId)) return undefined;
        return { url: entry.url, task };
      } catch {
        return undefined; // unreadable / unparseable — skip, don't fail the list.
      }
    }),
  );
  return parsed.filter((p): p is { url: string; task: Issue } => p !== undefined);
}

/**
 * The `wf:Task` containers registered in a source's Type Index, plus any
 * single-resource `solid:instance` registrations. Filters to `wf:Task`
 * registrations only — a federation consumer must not list a source's unrelated
 * containers.
 */
function taskLocations(locations: RegisteredLocation[]): RegisteredLocation[] {
  return locations.filter((l) => l.forClass === ISSUE_CLASS);
}

/**
 * Discover + verify every task assigned to the logged-in user across their own
 * pods and the pods of authorized agents (friends / contacts).
 *
 * Flow:
 *   1. Read the user's own profile → own storages + Type Index `wf:Task`
 *      registrations.
 *   2. Build the authorized-source set (self + friends + contact WebIDs).
 *   3. For each authorized FOREIGN source: read their profile → their verified
 *      storages + their Type Index `wf:Task` registrations.
 *   4. For every discovered `wf:Task` container/instance, read the tasks
 *      assigned to me, then run {@link verifyAssignedTask} with the source's
 *      provenance. Only verified tasks are returned.
 *
 * Every cross-pod read is bounded: a foreign source's registered container must
 * be within THAT source's own verified storage before it is listed (a crafted
 * registration pointing elsewhere is dropped — defence in depth on top of the
 * per-task provenance check).
 *
 * @param myWebId   - the logged-in WebID.
 * @param myProfile - the user's already-fetched profile (own storages + index
 *   links). Passing it avoids a redundant fetch and matches the session model.
 * @param contactWebIds - WebIDs of the user's saved contacts (those with one).
 * @param fetchImpl - test-only override; **omit in production**.
 */
export async function discoverAssignedTasks(opts: {
  myWebId: string;
  myProfile: PodProfile;
  myProfileDataset: import("@rdfjs/types").DatasetCore;
  contactWebIds: readonly string[];
  fetchImpl?: typeof fetch;
}): Promise<AssignedTask[]> {
  const { myWebId, myProfile, myProfileDataset, contactWebIds, fetchImpl } = opts;
  const ownStorages = myProfile.storages;

  const friends = readKnows(myWebId, myProfileDataset);
  const authorized = buildAuthorizedSources(myWebId, friends, contactWebIds);

  const results: AssignedTask[] = [];
  const seen = new Set<string>();

  const collect = (task: AssignedTask | undefined): void => {
    if (!task || seen.has(task.url)) return;
    seen.add(task.url);
    results.push(task);
  };

  // ── 1. Own pods. Discover this user's wf:Task registrations + list them.
  //    Wrapped fail-closed: a broken own type-index or container must not sink
  //    the whole view (it would also hide any readable foreign sources). Logged
  //    + skipped rather than thrown.
  try {
    const ownReg = await discoverRegistrations(myWebId, myProfileDataset, fetchImpl);
    const ownTaskLocs = taskLocations(ownReg.locations);
    await readSourceTasks({
      locations: ownTaskLocs,
      source: myWebId,
      sourceStorages: ownStorages,
      myWebId,
      ownStorages,
      authorized,
      fetchImpl,
      collect,
    });
  } catch (e) {
    logSkippedSource(myWebId, e);
  }

  // ── 2. Foreign authorized sources (friends + contacts). Each source is read
  //    in FULL ISOLATION: a single source whose profile, type-index, or task
  //    container is unreadable/broken (403/500/parse error) is skipped
  //    fail-closed (logged, omitted) — it must not reject the aggregate and hide
  //    the user's own tasks or the OTHER readable sources. `allSettled` ensures
  //    a rejection from one source never propagates; the inner try/catch is the
  //    primary guard and the one that logs.
  await Promise.allSettled(
    authorized.others.map(async (sourceWebId) => {
      try {
        let sourceProfile: PodProfile;
        let sourceDataset: import("@rdfjs/types").DatasetCore;
        try {
          const { dataset } = await freshRdf(profileDocUrl(sourceWebId), fetchImpl);
          sourceDataset = dataset;
          sourceProfile = readProfile(sourceWebId, dataset);
        } catch (e) {
          logSkippedSource(sourceWebId, e); // unreadable source profile — skip this source.
          return;
        }
        const reg = await discoverRegistrations(sourceWebId, sourceDataset, fetchImpl);
        await readSourceTasks({
          locations: taskLocations(reg.locations),
          source: sourceWebId,
          sourceStorages: sourceProfile.storages,
          myWebId,
          ownStorages,
          authorized,
          fetchImpl,
          collect,
        });
      } catch (e) {
        // A broken type-index or task container for this source — skip it
        // fail-closed. Own-pod tasks and other readable sources still render.
        logSkippedSource(sourceWebId, e);
      }
    }),
  );

  return sortAssigned(results);
}

/**
 * Read + verify the tasks for ONE source's registered locations. A location's
 * `container` and `instance` are each verified INDEPENDENTLY against the source's
 * own verified storage before any authenticated read (defence in depth): an
 * off-storage value in one field skips only that field, never the valid sibling.
 * Found tasks are verified via {@link verifyAssignedTask} and handed to `collect`.
 */
async function readSourceTasks(opts: {
  locations: RegisteredLocation[];
  source: string;
  sourceStorages: readonly string[];
  myWebId: string;
  ownStorages: readonly string[];
  authorized: AuthorizedSources;
  fetchImpl?: typeof fetch;
  collect: (task: AssignedTask | undefined) => void;
}): Promise<void> {
  const { locations, source, sourceStorages, myWebId, ownStorages, authorized, fetchImpl, collect } =
    opts;

  // For a foreign source the read URLs MUST be within that source's own storage.
  // For the user's own source they must be within an own pod. (self is also in
  // `authorized`, so this single guard covers both.)
  const allowedRoots = source === myWebId ? ownStorages : sourceStorages;

  await Promise.all(
    locations.map(async (loc) => {
      const found: { url: string; task: Issue }[] = [];
      // `container` and `instance` are verified INDEPENDENTLY: an off-storage
      // value in one field must skip ONLY that field, never drop a valid sibling
      // (nor the tasks already read from a valid container). A single location
      // can legitimately carry both.
      if (loc.container && isInOwnPods(loc.container, allowedRoots)) {
        found.push(...(await readAssignedFromContainer(loc.container, myWebId, fetchImpl)));
      }
      if (loc.instance && isInOwnPods(loc.instance, allowedRoots)) {
        try {
          const { dataset } = await freshRdf(loc.instance, fetchImpl);
          const task = parseIssue(loc.instance, dataset);
          if (task && isAssignedToMe(task.assignee, myWebId)) {
            found.push({ url: loc.instance, task });
          }
        } catch {
          // skip unreadable instance.
        }
      }
      for (const { url, task } of found) {
        collect(
          verifyAssignedTask({
            url,
            task,
            myWebId,
            ownStorages,
            source,
            sourceStorages,
            authorized,
          }),
        );
      }
    }),
  );
}

/**
 * Sort assigned tasks for the UI: open before closed; own-pod before foreign
 * within a state band; newest-created first within that. Pure.
 */
export function sortAssigned(tasks: readonly AssignedTask[]): AssignedTask[] {
  const stateRank: Record<Issue["state"], number> = { open: 0, "in-progress": 1, closed: 2 };
  return [...tasks].sort((a, b) => {
    const sr = stateRank[a.task.state] - stateRank[b.task.state];
    if (sr !== 0) return sr;
    if (a.own !== b.own) return a.own ? -1 : 1;
    const ta = a.task.created?.getTime() ?? 0;
    const tb = b.task.created?.getTime() ?? 0;
    return tb - ta;
  });
}

/** Count of assigned tasks not yet closed (the badge on the nav / header). */
export function openAssignedCount(tasks: readonly AssignedTask[]): number {
  return tasks.filter((t) => t.task.state !== "closed").length;
}

/**
 * Log (at `console.debug` only) that a federation source was skipped fail-closed
 * because its profile / type-index / task container was unreadable or broken.
 * A broken source must NEVER sink the aggregate view — it is omitted, not raised.
 * Mirrors the notifications-degradation convention (no user-facing error).
 */
function logSkippedSource(source: string, err: unknown): void {
  if (typeof console !== "undefined" && typeof console.debug === "function") {
    console.debug("[federation-tasks] skipped unreadable source", source, err);
  }
}
