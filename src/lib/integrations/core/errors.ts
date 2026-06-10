/**
 * Typed errors for the integrations framework. The UI branches on
 * `instanceof` (AGENTS.md Part 2 §TypeScript), never on message strings.
 */

/** Base class: anything thrown by an integration adapter or the framework. */
export class IntegrationError extends Error {
  /** Catalog id of the adapter involved (e.g. `"spotify"`). */
  readonly adapterId: string;
  constructor(adapterId: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IntegrationError";
    this.adapterId = adapterId;
  }
}

/** Why an authorization attempt failed — the UI maps these to copy. */
export type AuthFailureReason =
  | "not-configured" // no client id (demo mode) — connect button should not call authorize
  | "popup-blocked"
  | "cancelled" // user closed the popup / denied the grant
  | "state-mismatch" // possible CSRF — always surfaced, never retried silently
  | "exchange-failed"; // token endpoint said no

/** The OAuth dance failed before we ever had a token. */
export class IntegrationAuthError extends IntegrationError {
  readonly reason: AuthFailureReason;
  constructor(
    adapterId: string,
    reason: AuthFailureReason,
    message?: string,
    options?: { cause?: unknown },
  ) {
    super(adapterId, message ?? `Authorization failed (${reason}).`, options);
    this.name = "IntegrationAuthError";
    this.reason = reason;
  }
}

/** A pull from the source API (or a pod write during import) failed. */
export class IntegrationSyncError extends IntegrationError {
  /** The URL that failed, when known. */
  readonly url?: string;
  /** HTTP status, when the failure was an HTTP answer. */
  readonly status?: number;
  constructor(
    adapterId: string,
    message: string,
    options?: { url?: string; status?: number; cause?: unknown },
  ) {
    super(adapterId, message, { cause: options?.cause });
    this.name = "IntegrationSyncError";
    this.url = options?.url;
    this.status = options?.status;
  }
}

/** The platform rate-limited us (HTTP 429). Retry after the given delay. */
export class RateLimitedError extends IntegrationSyncError {
  /** Parsed `Retry-After`, in seconds, when the platform sent one. */
  readonly retryAfterSeconds?: number;
  constructor(adapterId: string, url: string, retryAfterSeconds?: number) {
    super(adapterId, `Rate limited by the platform at ${url}.`, { url, status: 429 });
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
