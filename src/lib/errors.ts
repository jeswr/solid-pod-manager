/**
 * Typed error classes for the data layer. The UI branches on `instanceof`,
 * never on message strings (AGENTS.md Part 2 §TypeScript). `@jeswr/fetch-rdf`
 * already throws its own `RdfFetchError` with `.status`/`.url`; these wrap the
 * cases that library does not model.
 */

/** Base class so the UI can catch "anything from the data layer" if it wants. */
export class PodDataError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PodDataError";
  }
}

/** The WebID profile has no `solid:storage` / `pim:storage` — no pod to browse. */
export class NoStorageError extends PodDataError {
  readonly webId: string;
  constructor(webId: string) {
    super(
      `This WebID has no pod storage in its profile, so there is nothing to browse yet (${webId}).`,
    );
    this.name = "NoStorageError";
    this.webId = webId;
  }
}

/** A Type-Index document was expected but could not be read or parsed. */
export class TypeIndexError extends PodDataError {
  readonly indexUrl: string;
  constructor(indexUrl: string, options?: { cause?: unknown }) {
    super(`Could not read the type index at ${indexUrl}.`, options);
    this.name = "TypeIndexError";
    this.indexUrl = indexUrl;
  }
}

/** Someone must be logged in for this operation, and no one is. */
export class NotAuthenticatedError extends PodDataError {
  constructor() {
    super("You need to be logged in to do this.");
    this.name = "NotAuthenticatedError";
  }
}

/**
 * A resource's access-control document could not be located (no
 * `Link: rel="acl"` header, or the resource itself was unreachable).
 */
export class AclDiscoveryError extends PodDataError {
  readonly resourceUrl: string;
  constructor(resourceUrl: string, options?: { cause?: unknown }) {
    super(`Could not locate the access settings for ${resourceUrl}.`, options);
    this.name = "AclDiscoveryError";
    this.resourceUrl = resourceUrl;
  }
}

/** An ACL document exists but could not be read or parsed. */
export class AclReadError extends PodDataError {
  readonly aclUrl: string;
  constructor(aclUrl: string, options?: { cause?: unknown }) {
    super(`Could not read the access settings at ${aclUrl}.`, options);
    this.name = "AclReadError";
    this.aclUrl = aclUrl;
  }
}

/**
 * An ACL update failed. Fail-closed: when this is thrown the document on the
 * server is either unchanged or in its previous state — callers must treat the
 * mutation as NOT applied and re-read before retrying.
 */
export class AclWriteError extends PodDataError {
  readonly aclUrl: string;
  constructor(aclUrl: string, message?: string, options?: { cause?: unknown }) {
    super(message ?? `Could not update the access settings at ${aclUrl}.`, options);
    this.name = "AclWriteError";
    this.aclUrl = aclUrl;
  }
}

/**
 * The resource's access-control document uses ACP (`.acr` / Access Control
 * Policy), not WAC. The per-resource Sharing panel only writes WAC today; it
 * fails closed here rather than parsing an ACP document as an empty WAC ACL
 * (which would under-report access) or writing WAC triples into it.
 */
export class AcpUnsupportedError extends PodDataError {
  readonly resourceUrl: string;
  constructor(resourceUrl: string, options?: { cause?: unknown }) {
    super(
      `This resource uses a newer access-control format this view can't edit yet (${resourceUrl}).`,
      options,
    );
    this.name = "AcpUnsupportedError";
    this.resourceUrl = resourceUrl;
  }
}

/** A pod write (PUT) was rejected by the server. */
export class ResourceWriteError extends PodDataError {
  readonly url: string;
  /** HTTP status the server answered with (412 = precondition failed). */
  readonly status: number;
  constructor(url: string, status: number) {
    super(`Could not save to your pod (${status}) at ${url}.`);
    this.name = "ResourceWriteError";
    this.url = url;
    this.status = status;
  }
}

/** A single item could not be read or parsed from the pod. */
export class ItemReadError extends PodDataError {
  readonly url: string;
  /** HTTP status from the underlying fetch (404 = not found). */
  readonly status: number;
  constructor(url: string, status: number, options?: { cause?: unknown }) {
    super(`Could not open this item (${status}) at ${url}.`, options);
    this.name = "ItemReadError";
    this.url = url;
    this.status = status;
  }
}

/**
 * A recipient's WebID profile advertises no `ldp:inbox`, so there is nowhere to
 * deliver a cross-pod notification. A clean, recoverable condition (the UI shows
 * "this person's pod doesn't advertise an inbox"), NOT a security failure.
 */
export class NoInboxError extends PodDataError {
  readonly webId: string;
  constructor(webId: string) {
    super(`This person's pod doesn't advertise an inbox to deliver to (${webId}).`);
    this.name = "NoInboxError";
    this.webId = webId;
  }
}

/**
 * A discovered cross-pod target URL (an LDN inbox) failed the strict outbound
 * validator and MUST NOT be POSTed to. This is the cross-pod analogue of
 * `pod-scope`'s SEC-1 guard: the auth-patched global `fetch` attaches the user's
 * DPoP-bound access token + a proof minted for the REQUESTED url on a 401 retry,
 * so POSTing to a localhost / private-range / metadata / credentials-bearing
 * host would leak that token+proof to an attacker-chosen origin (a
 * confused-deputy / SSRF). Fail closed — never POST when this is thrown.
 *
 * Carries a machine-readable {@link reason} so a security review (and tests) can
 * assert exactly WHY a target was rejected without parsing the message.
 */
export type InvalidTargetReason =
  | "not-absolute"
  | "bad-scheme"
  | "has-credentials"
  | "blocked-host";

export class InvalidTargetError extends PodDataError {
  readonly target: string;
  readonly reason: InvalidTargetReason;
  constructor(target: string, reason: InvalidTargetReason) {
    super(`That inbox address isn't safe to send to (${reason}): ${target}`);
    this.name = "InvalidTargetError";
    this.target = target;
    this.reason = reason;
  }
}

/** A cross-pod notification POST was rejected by the recipient's inbox. */
export class NotificationSendError extends PodDataError {
  readonly inbox: string;
  /** HTTP status the recipient inbox answered with. */
  readonly status: number;
  constructor(inbox: string, status: number) {
    super(`Could not deliver the notification (${status}) to ${inbox}.`);
    this.name = "NotificationSendError";
    this.inbox = inbox;
    this.status = status;
  }
}

/**
 * An inbox/chat URL passed to a read/mark/dismiss op is not a direct child of the
 * expected container. A confused-deputy guard (like {@link PodDataError}'s
 * `OutOfScopeError` for the productivity store): a crafted URL must never make
 * the app act on an arbitrary resource with the user's credentials. Fail closed.
 */
export class InboxScopeError extends PodDataError {
  readonly url: string;
  readonly container: string;
  constructor(url: string, container: string) {
    super(`Refusing to act on a resource outside the inbox container: ${url}`);
    this.name = "InboxScopeError";
    this.url = url;
    this.container = container;
  }
}

/** A pod delete (DELETE) was rejected by the server. */
export class ResourceDeleteError extends PodDataError {
  readonly url: string;
  /** HTTP status the server answered with. */
  readonly status: number;
  constructor(url: string, status: number) {
    super(`Could not delete from your pod (${status}) at ${url}.`);
    this.name = "ResourceDeleteError";
    this.url = url;
    this.status = status;
  }
}
