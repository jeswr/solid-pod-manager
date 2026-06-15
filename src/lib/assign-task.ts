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
import { issuesStore, type Issue } from "./issues.js";
import { WacResourceSharingBackend, type AccessSubject } from "./resource-acl.js";
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

/**
 * Assign a task to another agent, cross-pod and safely.
 *
 * Flow (steps 1+2 are load-bearing; step 3 is best-effort):
 *   1. Validate the assignee WebID (http(s) IRI) — fail closed otherwise.
 *   2. WRITE the `wf:Task` (with `wf:assignee`) into the ASSIGNER'S OWN pod via
 *      the typed `issuesStore`.
 *   3. Grant the assignee MINIMAL `view` (WAC read) on JUST that task resource
 *      via `WacResourceSharingBackend`. If this fails, the assignment is rejected
 *      ({@link AssignError} `grant-failed`) — we don't leave an unreadable task.
 *   4. BEST-EFFORT: POST an as:Announce to the assignee's (discovered, SSRF-
 *      validated) inbox. A failure is swallowed → `notified: false`.
 *
 * Production callers pass NO `fetchImpl` (the auth-patched global runs); tests
 * inject one (AGENTS.md §Reading data).
 *
 * @throws AssignError `invalid-assignee` — the assignee is not an http(s) WebID.
 * @throws AssignError `grant-failed`     — the minimal WAC grant could not be set
 *   (the task was written but the assignee can't read it; the caller surfaces a
 *   retry). Distinct from a delivery failure, which is non-fatal.
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

  // 2. WRITE the task in the ASSIGNER'S OWN pod (typed issues builder). Living in
  //    the assigner's verified storage is exactly what makes the read side trust
  //    the assignee claim (federation-tasks tier-2 provenance).
  const store = issuesStore({ podRoot: args.podRoot, webId: args.assignerWebId, fetchImpl });
  const issue: Issue = {
    title: args.task.title.trim(),
    description: args.task.description?.trim() || undefined,
    state: args.task.state ?? "open",
    assignee, // wf:assignee — only persisted because we validated it is a WebID
  };
  const { url } = await store.create(issue, issue.title);

  // 3. MINIMAL WAC grant: the assignee gets `view` (read) on JUST this task
  //    resource — nothing broader (no write/control, no container default, no
  //    pod-wide access). A grant failure rejects the assignment so we never
  //    leave a task the assignee cannot read; the task resource is left in the
  //    assigner's pod (they can delete/re-try) — we do not silently swallow it.
  const subject: AccessSubject = { kind: "agent", id: assignee };
  const sharing = new WacResourceSharingBackend(args.assignerWebId, fetchImpl);
  try {
    await sharing.setAccess(url, subject, "view");
  } catch (cause) {
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
