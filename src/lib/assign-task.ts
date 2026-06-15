// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Cross-pod task ASSIGNMENT — the WRITE counterpart to `federation-tasks.ts`'s
 * "Assigned to me" READ view (bead pss-phg).
 *
 * The read side surfaces a foreign task as "assigned to me" ONLY when its
 * provenance is trustable: the task must reside in an AUTHORIZED ASSIGNER's OWN
 * verified `pim:storage` (see `federation-tasks.ts` §SECURITY, tier 2). This
 * module is the side that PRODUCES such a task, and it is built to satisfy that
 * exact trust model:
 *
 *   1. WRITE in the ASSIGNER'S OWN POD. The task is created via the typed
 *      `issuesStore` (one `wf:Task` under `issues/` in the assigner's pod) with
 *      `wf:assignee <assigneeWebID>`. Because it lives in the assigner's own
 *      verified storage, the read side's provenance check (the task resides in
 *      the assigner's `pim:storage`) trusts it. We NEVER write to the assignee's
 *      pod — that would be a huge cross-pod-WRITE surface and the claim would not
 *      be provenance-trustable anyway.
 *
 *   2. MINIMAL WAC GRANT. The assignee must be able to READ the task, so we grant
 *      them `view` (WAC `read`) on JUST THAT ONE TASK RESOURCE via the existing
 *      `WacResourceSharingBackend` (the Sharing panel's writer — typed
 *      `@solid/object` accessors, never hand-built ACL triples). This is the
 *      minimal grant: read on the single resource, nothing broader. We never
 *      grant write/control, never touch the container's `acl:default`, and never
 *      widen access to the rest of the pod. Default-deny everything else stands.
 *
 *      The grant writer only speaks WAC. PM has no ACP (`.acr`) sharing backend
 *      yet, so on an ACP-backed pod the grant cannot be set. To avoid leaving an
 *      ORPHAN task the assignee can never be granted read on, we DETECT the pod's
 *      access-control system (WAC vs ACP) on the target container BEFORE creating
 *      the task and, for ACP, fail clean (`grant-failed`) WITHOUT writing it —
 *      see {@link detectAccessControl}. Full ACP assignment support is tracked as
 *      a follow-up (bead: "ACP-backed pods: cross-pod task assignment grant").
 *
 *      ATOMICITY. Even on a WAC pod the grant can still fail after the write
 *      (403/network/race). A failed grant ROLLS BACK the just-created task
 *      (best-effort delete) before surfacing `grant-failed`, so a UI retry never
 *      stacks DUPLICATE unreadable assignments. Detect-before-write + rollback-
 *      on-grant-failure together mean an assignment either fully succeeds or
 *      leaves nothing behind.
 *
 *   3. BEST-EFFORT as:Announce. We notify the assignee by POSTing an
 *      ActivityStreams 2.0 `Announce` (object = the task IRI, target = the
 *      assignee WebID) to the assignee's LDN inbox, discovered + STRICTLY
 *      SSRF-validated by `notify-send.ts` / `agent-target.ts`. This is
 *      BEST-EFFORT: the assignment (write + grant) has already succeeded, so a
 *      failed/blocked notification (no inbox, unsafe target, delivery error) is
 *      swallowed and reported as `notified: false` — it NEVER fails the
 *      assignment.
 *
 * SECURITY:
 *   - The assignee WebID is validated as an absolute http(s) IRI before any I/O
 *     ({@link AssignError} `invalid-assignee` otherwise) — we never coerce
 *     arbitrary text into a WAC `acl:agent` / AS2.0 IRI.
 *   - The as:Announce target is the assignee's REAL inbox, discovered from their
 *     profile and SSRF-validated (no user-supplied POST target) — see
 *     `agent-target.ts`. The notify is also redirect-no-follow + final-URL
 *     re-validated in `notify-send.ts`.
 *   - The WAC grant is scoped to the single task resource; the writer's own
 *     self-lockout guard keeps the assigner as Owner.
 *
 * RDF/ACL house rule: the task is written via the typed `issues.ts` builder and
 * the grant via the typed `resource-acl.ts` writer — never hand-built triples.
 */
import { issuesStore, ISSUES_SLUG, type Issue } from "./issues.js";
import { WacResourceSharingBackend, type AccessSubject } from "./resource-acl.js";
import { aclUrlFromLinkHeader } from "./permissions.js";
import { sendNotification } from "./notify-send.js";
import { AssignError } from "./errors.js";

/** Arguments for {@link assignTask}. */
export interface AssignTaskArgs {
  /** The signed-in assigner's WebID — written as task author context + as:actor. */
  assignerWebId: string;
  /** The pod root the task is written into (the assigner's OWN active storage). */
  podRoot: string;
  /** The agent the task is assigned to — validated as an http(s) WebID. */
  assigneeWebId: string;
  /** The task payload (title required; description / state optional). */
  task: {
    title: string;
    description?: string;
    state?: Issue["state"];
  };
}

/** The outcome of {@link assignTask}. */
export interface AssignTaskResult {
  /** The new task resource URL (in the assigner's own pod). */
  url: string;
  /**
   * Whether the assignee was granted READ on the task. Always `true` on success
   * (a grant failure rejects the whole assignment — the task would be invisible
   * to the assignee, so we do NOT leave a half-shared task behind).
   */
  granted: boolean;
  /**
   * Whether the best-effort as:Announce was delivered to the assignee's inbox.
   * `false` when the assignee advertises no inbox, the inbox failed the SSRF
   * validator, or delivery errored — the assignment still SUCCEEDED.
   */
  notified: boolean;
}

/** True for an absolute http(s) URL usable as a WebID. */
function isHttpWebId(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** The access-control system a pod advertises for a resource. */
type AccessControlSystem = "wac" | "acp" | "unknown";

/** True for a clearly-ACP control document (an `.acr` slot). */
function isAcpControlUrl(aclUrl: string): boolean {
  try {
    return new URL(aclUrl).pathname.endsWith(".acr");
  } catch {
    return aclUrl.endsWith(".acr");
  }
}

/**
 * Detect whether `containerUrl` is governed by WAC or ACP, BEFORE we write the
 * task into it — so an ACP pod (which PM's grant writer can't serve yet) fails
 * clean without leaving an orphan task. We probe the container's
 * `Link: rel="acl"` header (the same discovery the WAC backend uses) and classify
 * the advertised control slot: a `.acr` target ⇒ ACP, any other ⇒ WAC. A probe
 * that doesn't resolve (no Link header, unreachable container) is `unknown` —
 * we DON'T fail on `unknown` (the WAC grant attempt + its own rollback handles a
 * later surprise); we only fail-fast on a DEFINITE ACP signal here.
 *
 * Uses GET (the auth-patched fetch only replays the 401→DPoP upgrade for GET).
 */
async function detectAccessControl(
  containerUrl: string,
  fetchImpl?: typeof fetch,
): Promise<AccessControlSystem> {
  let res: Response;
  try {
    res = await (fetchImpl ?? fetch)(containerUrl, { method: "GET" });
  } catch {
    return "unknown";
  }
  await res.body?.cancel().catch(() => undefined);
  if (!res.ok) return "unknown";
  const aclUrl = aclUrlFromLinkHeader(res.headers.get("link"), containerUrl);
  if (!aclUrl) return "unknown";
  return isAcpControlUrl(aclUrl) ? "acp" : "wac";
}

/**
 * Assign a task to another agent, cross-pod and safely.
 *
 * Flow (steps 1–4 are load-bearing; step 5 is best-effort):
 *   1. Validate the assignee WebID (http(s) IRI) — fail closed otherwise.
 *   2. DETECT the pod's access-control system on the target container. A
 *      DEFINITELY-ACP pod fails clean ({@link AssignError} `grant-failed`) BEFORE
 *      any write — PM has no ACP grant backend yet, so we never create an orphan.
 *   3. WRITE the `wf:Task` (with `wf:assignee`) into the ASSIGNER'S OWN pod via
 *      the typed `issuesStore`.
 *   4. Grant the assignee MINIMAL `view` (WAC read) on JUST that task resource
 *      via `WacResourceSharingBackend`. If this fails, the just-created task is
 *      ROLLED BACK (best-effort delete) and the assignment is rejected
 *      ({@link AssignError} `grant-failed`) — we never leave an unreadable task,
 *      and a retry can't duplicate it.
 *   5. BEST-EFFORT: POST an as:Announce to the assignee's (discovered, SSRF-
 *      validated) inbox. A failure is swallowed → `notified: false`.
 *
 * Atomicity: detect-before-write (step 2) + rollback-on-grant-failure (step 4)
 * mean an assignment either fully succeeds or leaves nothing in the pod.
 *
 * Production callers pass NO `fetchImpl` (the auth-patched global runs); tests
 * inject one (AGENTS.md §Reading data).
 *
 * @throws AssignError `invalid-assignee` — the assignee is not an http(s) WebID.
 * @throws AssignError `grant-failed`     — either the pod is ACP-backed (caught
 *   before any write, no task created) OR the minimal WAC grant could not be set
 *   (the just-created task is rolled back, so nothing is left behind). The caller
 *   surfaces a retry. Distinct from a delivery failure, which is non-fatal.
 */
export async function assignTask(
  args: AssignTaskArgs,
  fetchImpl?: typeof fetch,
): Promise<AssignTaskResult> {
  const assignee = args.assigneeWebId.trim();

  // 1. Validate the assignee FIRST — never write a malformed wf:assignee node or
  //    grant access to a non-WebID. The typed builder ALSO drops a non-WebID
  //    assignee, but we fail closed loudly here so the caller knows the
  //    assignment was rejected rather than silently un-assigned.
  if (!isHttpWebId(assignee)) {
    throw new AssignError("invalid-assignee", assignee);
  }
  if (!args.task.title.trim()) {
    throw new AssignError("invalid-task", "A task must have a title.");
  }

  const store = issuesStore({ podRoot: args.podRoot, webId: args.assignerWebId, fetchImpl });

  // 2. DETECT the pod's access-control system BEFORE writing. The grant writer
  //    only speaks WAC; PM has no ACP (`.acr`) backend yet. On a DEFINITELY-ACP
  //    pod we can never grant the assignee read, so we fail clean here — WITHOUT
  //    writing the task — rather than create an orphan the assignee can't reach.
  //    (`unknown` is permissive: we proceed and let the WAC grant + its rollback
  //    handle any later surprise.) Probe the target container (issues/), the slot
  //    the task will live under.
  const issuesContainer = new URL(ISSUES_SLUG, args.podRoot).toString();
  const acSystem = await detectAccessControl(issuesContainer, fetchImpl);
  if (acSystem === "acp") {
    throw new AssignError("grant-failed", issuesContainer, {
      cause: new Error(
        "This pod uses ACP access control, which task assignment doesn't support yet — no task was created.",
      ),
    });
  }

  // 3. WRITE the task in the ASSIGNER'S OWN pod (typed issues builder). Living in
  //    the assigner's verified storage is exactly what makes the read side trust
  //    the assignee claim (federation-tasks tier-2 provenance).
  const issue: Issue = {
    title: args.task.title.trim(),
    description: args.task.description?.trim() || undefined,
    state: args.task.state ?? "open",
    assignee, // wf:assignee — only persisted because we validated it is a WebID
  };
  const { url } = await store.create(issue, issue.title);

  // 4. MINIMAL WAC grant: the assignee gets `view` (read) on JUST this task
  //    resource — nothing broader (no write/control, no container default, no
  //    pod-wide access). A grant failure ROLLS BACK the just-created task (a
  //    best-effort delete) and THEN rejects the assignment, so no unreadable
  //    task is ever left behind and a UI retry can't stack duplicates. Rollback
  //    is best-effort: if the delete itself fails we still surface `grant-failed`
  //    (with the grant error as the cause), but we never silently swallow either.
  const subject: AccessSubject = { kind: "agent", id: assignee };
  const sharing = new WacResourceSharingBackend(args.assignerWebId, fetchImpl);
  try {
    await sharing.setAccess(url, subject, "view");
  } catch (cause) {
    // Roll back the orphan so a retry reuses no stale, unreadable resource.
    await store.remove(url).catch(() => undefined);
    throw new AssignError("grant-failed", url, { cause });
  }

  // 4. BEST-EFFORT as:Announce to the assignee's inbox. The assignment (write +
  //    grant) is already durable, so ANY delivery failure — no inbox, an unsafe
  //    (SSRF-blocked) target, or a non-2xx — is swallowed; we report it via
  //    `notified` rather than throwing. The target is the assignee's REAL inbox
  //    (discovered + strictly validated by sendNotification), never user input.
  let notified = false;
  try {
    await sendNotification(
      {
        recipientWebId: assignee,
        actorWebId: args.assignerWebId,
        type: "Announce",
        object: url, // the task IRI
        target: assignee, // the assignee the activity targets
        summary: `You have been assigned a task: ${issue.title}`,
        content: url,
      },
      fetchImpl,
    );
    notified = true;
  } catch {
    // Swallow — assignment succeeds even if the notification fails (best-effort).
    notified = false;
  }

  return { url, granted: true, notified };
}
