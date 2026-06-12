/**
 * A {@link SessionStore} test double that faithfully models IndexedDB's
 * persistence semantics WITHOUT a browser or a fake-indexeddb dependency: it
 * `structuredClone`s every value on write and read, exactly as IndexedDB does.
 *
 * Why this is a faithful IndexedDB stand-in for these tests:
 *  - IndexedDB stores values by the structured-clone algorithm; `structuredClone`
 *    is that same algorithm exposed synchronously.
 *  - A NON-EXTRACTABLE `CryptoKey` survives structured clone with
 *    `extractable: false` preserved and STILL SIGNS — the key-continuity
 *    property the persisted-refresh-token design depends on. (Verified directly
 *    in session-persistence.test.ts; this double inherits it.)
 *
 * Using this in `node` (vitest's environment here) avoids adding fake-indexeddb
 * to the shared, symlinked node_modules. The real {@link IndexedDbSessionStore}
 * is covered separately where an IDBFactory is available.
 */
import type {
  PersistedSession,
  SessionStore,
} from "../session-persistence.js";

export class StructuredCloneSessionStore implements SessionStore {
  readonly #map = new Map<string, PersistedSession>();
  /** Inspectable call log so tests can assert what was written/cleared. */
  readonly puts: PersistedSession[] = [];
  readonly deletes: string[] = [];

  async get(issuer: string): Promise<PersistedSession | undefined> {
    const stored = this.#map.get(issuer);
    return stored === undefined ? undefined : structuredClone(stored);
  }

  async put(session: PersistedSession): Promise<void> {
    const cloned = structuredClone(session);
    this.#map.set(session.issuer, cloned);
    this.puts.push(cloned);
  }

  async delete(issuer: string): Promise<void> {
    this.#map.delete(issuer);
    this.deletes.push(issuer);
  }

  /** Test helper: the raw stored value (already a structured clone). */
  peek(issuer: string): PersistedSession | undefined {
    return this.#map.get(issuer);
  }
}
