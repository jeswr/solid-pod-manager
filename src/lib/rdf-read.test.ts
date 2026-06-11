import { describe, expect, it } from "vitest";
import { freshRdf } from "./rdf-read.js";

const TURTLE = `<https://pod.example/x> a <https://schema.org/Thing>.`;

function recordingFetch(record: { headers?: Headers }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    record.headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    return new Response(TURTLE, {
      status: 200,
      headers: { "content-type": "text/turtle", etag: '"v1"' },
    });
  }) as typeof fetch;
}

describe("freshRdf", () => {
  it("sends Cache-Control: no-cache so cached pod documents are revalidated", async () => {
    // Pods (CSS included) send ETag/Last-Modified but no Cache-Control, so
    // browsers heuristically serve reads from cache WITHOUT revalidating —
    // which hid a just-linked type index from My-data (read-your-writes bug).
    const record: { headers?: Headers } = {};
    const { dataset, etag } = await freshRdf("https://pod.example/x", recordingFetch(record));

    expect(record.headers?.get("cache-control")).toBe("no-cache");
    expect(dataset.size).toBe(1);
    expect(etag).toBe('"v1"'); // validator still flows through for If-Match writes
  });
});
