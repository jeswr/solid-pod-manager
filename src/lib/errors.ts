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
