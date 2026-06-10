/** Small dataset utilities shared by adapters. */
import type { DatasetCore } from "@rdfjs/types";
import { Store } from "n3";

/**
 * A writable `n3.Store` view of an (optional) existing dataset — the merge
 * target for incremental imports. Quads are deduplicated by the store, which
 * is what makes merge re-imports idempotent.
 */
export function asStore(existing?: DatasetCore): Store {
  if (!existing) return new Store();
  if (existing instanceof Store) return existing;
  const store = new Store();
  for (const quad of existing) store.add(quad);
  return store;
}
