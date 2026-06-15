// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import type { DatasetCore } from "@rdfjs/types";
import { shouldRebase } from "./rebase.js";

const URL = "https://alice.example/data/x.ttl";

async function ds(turtle: string): Promise<DatasetCore> {
  return parseRdf(turtle, "text/turtle", { baseIRI: URL });
}

describe("shouldRebase — the inline-edit hook rebase decision", () => {
  it("does NOT rebase when only the fields array is reallocated (same read)", async () => {
    const dataset = await ds(`<${URL}#it> <https://schema.org/name> "n" .`);
    const prev = { dataset, etag: '"v1"' };
    // A new render hands the SAME dataset object + ETag (fields elsewhere may be
    // a freshly-allocated array; that is not part of this decision).
    const next = { dataset, etag: '"v1"' };
    expect(shouldRebase(prev, next)).toBe(false);
  });

  it("rebases when the dataset object changes (a fresh parse / reload)", async () => {
    const a = await ds(`<${URL}#it> <https://schema.org/name> "old" .`);
    const b = await ds(`<${URL}#it> <https://schema.org/name> "new" .`);
    expect(shouldRebase({ dataset: a, etag: '"v1"' }, { dataset: b, etag: '"v2"' })).toBe(true);
  });

  it("rebases when only the ETag changes (same dataset object reference)", async () => {
    const dataset = await ds(`<${URL}#it> <https://schema.org/name> "n" .`);
    expect(shouldRebase({ dataset, etag: '"v1"' }, { dataset, etag: '"v2"' })).toBe(true);
  });

  it("rebases from a null ETag to a real one", async () => {
    const dataset = await ds(`<${URL}#it> <https://schema.org/name> "n" .`);
    expect(shouldRebase({ dataset, etag: null }, { dataset, etag: '"v1"' })).toBe(true);
  });
});
