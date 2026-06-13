// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Cross-pod notification send — builds a well-formed ActivityStreams 2.0 (AS2.0)
 * notification and POSTs it to a recipient's LDN inbox (Linked Data
 * Notifications: an inbox accepts `POST text/turtle`).
 *
 * SECURITY. The POST target is NEVER taken from user input: it is discovered
 * from the recipient's profile and strictly validated by
 * `agent-target.resolveInboxTarget` (discover + {@link assertValidTargetUrl})
 * BEFORE any request is made (see the SSRF/confused-deputy rationale in
 * `agent-target.ts`). If discovery or validation fails, {@link sendNotification}
 * throws and NEVER issues the POST.
 *
 * HOST-LEAK CARE. The payload is intentionally minimal: it carries only the
 * sender WebID (`as:actor`), an optional `as:object`/`as:target` IRI the caller
 * explicitly supplies, a published timestamp, a type, and free-text
 * summary/content. We never sweep in the user's own internal pod URLs beyond
 * what the caller intends, so a notification cannot exfiltrate private resource
 * locations the recipient should not learn.
 *
 * RDF house rule: the notification is built via a typed `@rdfjs/wrapper` Doc
 * class + an n3 `Store`, serialised with `serializeTurtle` — never hand-concat
 * Turtle.
 */
import {
  LiteralAs,
  LiteralFrom,
  NamedNodeAs,
  NamedNodeFrom,
  OptionalAs,
  OptionalFrom,
  SetFrom,
  TermWrapper,
} from "@rdfjs/wrapper";
import { DataFactory, Store } from "n3";
import { serializeTurtle } from "./pod-data.js";
import { resolveInboxTarget, noFollowFetch, isValidTargetUrl } from "./agent-target.js";
import { NotificationSendError } from "./errors.js";

/** The ActivityStreams 2.0 namespace. */
const AS = "https://www.w3.org/ns/activitystreams#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

const PREFIXES = { as: AS } as const;

/** AS2.0 activity types this app sends. */
export type ActivityType = "Announce" | "Invite" | "Offer" | "Create" | "Update";

/** The plain shape of a notification the UI builds (no RDF terms). */
export interface ActivityNotification {
  /** `as:type` — the activity verb (defaults to `Announce`). */
  type: ActivityType;
  /** `as:actor` — the sender's WebID. */
  actor: string;
  /** `as:object` — an IRI the activity is about (e.g. a chat container, a poll). */
  object?: string;
  /** `as:target` — an IRI the activity targets (e.g. a recipient resource). */
  target?: string;
  /** `as:summary` — a short human-readable line. */
  summary?: string;
  /** `as:content` — a longer human-readable body. */
  content?: string;
  /** `as:published` — when it was sent (defaults to now). */
  published?: Date;
}

/** True for an absolute http(s) URL usable as an AS2.0 IRI object/actor/target. */
function isHttpIri(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Typed `@rdfjs/wrapper` view of a single AS2.0 activity subject. */
export class ActivityDoc extends TermWrapper {
  get types(): Set<string> {
    return SetFrom.subjectPredicate(this, RDF_TYPE, NamedNodeAs.string, NamedNodeFrom.string);
  }
  setType(t: ActivityType): this {
    this.types.add(`${AS}${t}`);
    return this;
  }
  /** `as:actor` — sender WebID (object property). */
  get actor(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${AS}actor`, NamedNodeAs.string);
  }
  set actor(v: string | undefined) {
    OptionalAs.object(this, `${AS}actor`, v, NamedNodeFrom.string);
  }
  /**
   * `as:object` — an IRI the activity is about. Named `activityObject` (not
   * `object`) because `TermWrapper` already defines an `object` term getter.
   */
  get activityObject(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${AS}object`, NamedNodeAs.string);
  }
  set activityObject(v: string | undefined) {
    OptionalAs.object(this, `${AS}object`, v, NamedNodeFrom.string);
  }
  get target(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${AS}target`, NamedNodeAs.string);
  }
  set target(v: string | undefined) {
    OptionalAs.object(this, `${AS}target`, v, NamedNodeFrom.string);
  }
  get summary(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${AS}summary`, LiteralAs.string);
  }
  set summary(v: string | undefined) {
    OptionalAs.object(this, `${AS}summary`, v, LiteralFrom.string);
  }
  get content(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${AS}content`, LiteralAs.string);
  }
  set content(v: string | undefined) {
    OptionalAs.object(this, `${AS}content`, v, LiteralFrom.string);
  }
  get published(): Date | undefined {
    return OptionalFrom.subjectPredicate(this, `${AS}published`, LiteralAs.date);
  }
  set published(v: Date | undefined) {
    OptionalAs.object(this, `${AS}published`, v, LiteralFrom.dateTime);
  }
}

/**
 * Build a fresh AS2.0 notification dataset rooted at `#it` (a relative subject —
 * the inbox assigns the final IRI). Only http(s) IRIs are written for
 * actor/object/target (never coerce arbitrary text into a NamedNode).
 */
export function buildNotification(notification: ActivityNotification): Store {
  const store = new Store();
  const doc = new ActivityDoc("#it", store, DataFactory).setType(notification.type);
  doc.actor = isHttpIri(notification.actor) ? notification.actor : undefined;
  doc.activityObject = isHttpIri(notification.object) ? notification.object : undefined;
  doc.target = isHttpIri(notification.target) ? notification.target : undefined;
  doc.summary = notification.summary?.trim() || undefined;
  doc.content = notification.content?.trim() || undefined;
  doc.published = notification.published ?? new Date();
  return store;
}

/** Arguments for {@link sendNotification}. */
export interface SendNotificationArgs {
  /** The recipient agent's WebID (its inbox is discovered + validated). */
  recipientWebId: string;
  /** The sender's WebID — written as `as:actor`. */
  actorWebId: string;
  /** Activity verb; defaults to `Announce`. */
  type?: ActivityType;
  object?: string;
  target?: string;
  summary?: string;
  content?: string;
  published?: Date;
}

/**
 * Discover + STRICTLY validate the recipient's inbox, then POST a serialised
 * AS2.0 Turtle notification to it.
 *
 * Order matters for security: {@link resolveInboxTarget} (discover from profile
 * + `assertValidTargetUrl`) runs BEFORE the body is even built, so a bad target
 * means NO POST is ever issued. Production callers pass no `fetchImpl` (the
 * auth-patched global runs); tests inject one.
 *
 * @throws NoInboxError        recipient advertises no inbox.
 * @throws InvalidTargetError  the inbox failed the strict SSRF validator.
 * @throws NotificationSendError on a non-2xx inbox response.
 * @returns the validated inbox URL that was posted to.
 */
export async function sendNotification(
  args: SendNotificationArgs,
  fetchImpl?: typeof fetch,
): Promise<{ inbox: string }> {
  // 1. Discover + STRICT validate the target FIRST — fail closed before any POST.
  const { inbox } = await resolveInboxTarget(args.recipientWebId, fetchImpl);

  // 2. Build the minimal AS2.0 payload and serialise to Turtle.
  const dataset = buildNotification({
    type: args.type ?? "Announce",
    actor: args.actorWebId,
    object: args.object,
    target: args.target,
    summary: args.summary,
    content: args.content,
    published: args.published,
  });
  const body = await serializeTurtle(dataset, PREFIXES);

  // 3. POST to the validated inbox (LDN accepts text/turtle).
  //
  //    SECURITY (redirect bypass): the inbox host comes from the recipient's
  //    profile, so it is attacker-influenceable — it only has to be a public
  //    host that passes the validator. If we followed redirects, that host could
  //    answer with a 3xx to `https://169.254.169.254/` / a private host, and the
  //    auth-patched fetch would transparently re-attach the user's DPoP
  //    token+proof on the redirected request — the confused-deputy this layer
  //    exists to prevent. So we route through `noFollowFetch` (the OUTERMOST
  //    wrapper, shared with the discovery GET) which forces `redirect: "manual"`,
  //    and we fail closed on any 3xx / opaque-redirect.
  //
  //    RESIDUAL RISK (documented, not silently assumed): the auth-patched global
  //    `fetch` performs its 401→token→retry INTERNALLY, beneath this wrapper. If
  //    that layer reconstructs its own `RequestInit` instead of preserving the
  //    one we pass, the `redirect: "manual"` option could be dropped on the
  //    authenticated retry. We cannot enforce that from out here. As a
  //    defence-in-depth backstop we ALSO re-validate the FINAL response URL
  //    (`res.url`, when the runtime populates it) against the strict validator,
  //    so a response that came from a redirected — and now off-target — origin is
  //    rejected rather than trusted. (Browsers expose `res.url` as the final URL;
  //    on an opaque-redirect it is empty, which we already reject by status.)
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "text/turtle" },
    body,
  };
  const res = await noFollowFetch(fetchImpl)(inbox, init);

  // A blocked/refused redirect surfaces as an opaque-redirect (status 0). Treat
  // it distinctly so a refused redirect is not conflated with a real server error.
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    throw new NotificationSendError(inbox, res.status || 0);
  }
  if (!res.ok) throw new NotificationSendError(inbox, res.status);

  // Defence-in-depth backstop: if the runtime followed a redirect anyway (e.g. an
  // auth retry that dropped `redirect: "manual"`), the final URL would differ and
  // could point off-target. Reject unless the final URL is still a valid target.
  const finalUrl = res.url;
  if (finalUrl && !isValidTargetUrl(finalUrl)) {
    throw new NotificationSendError(finalUrl, res.status);
  }
  return { inbox };
}
