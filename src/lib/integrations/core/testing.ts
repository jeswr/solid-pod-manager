/**
 * Test doubles for the integrations framework (imported by vitest only).
 *
 * `createMemoryPod()` is a tiny in-memory Solid-ish resource server exposed as
 * a `fetch`: GET/PUT Turtle with ETags + `If-Match`/`If-None-Match`
 * preconditions — enough to exercise the real write path (writeResource,
 * type-index bootstrap, idempotent re-import) without any network.
 */
import { Parser, Store } from "n3";
import { type ImportReport, runImport } from "./import-runner.js";
import type { IntegrationAdapter } from "./types.js";

export const TEST_POD_ROOT = "https://pod.test/alice/";
export const TEST_WEBID = `${TEST_POD_ROOT}profile/card#me`;
export const TEST_PROFILE_DOC = `${TEST_POD_ROOT}profile/card`;

const PROFILE_TURTLE = `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix pim: <http://www.w3.org/ns/pim/space#>.
<${TEST_WEBID}> a foaf:Person ;
  solid:oidcIssuer <https://idp.test/> ;
  pim:storage <${TEST_POD_ROOT}> ;
  foaf:name "Alice Test" .
`;

interface StoredResource {
  body: string;
  version: number;
}

export interface MemoryPod {
  /** Pass as `podFetch`/`fetchImpl` into the code under test. */
  fetch: typeof fetch;
  /** Raw Turtle of a stored resource. */
  get(url: string): string | undefined;
  /** Parsed quads of a stored resource. */
  dataset(url: string): Store;
  /** Every stored resource URL (sorted). */
  urls(): string[];
  /** Number of PUTs served (for idempotency/overwrite assertions). */
  putCount: number;
}

/** An in-memory pod pre-seeded with a WebID profile (no type index — like CSS). */
export function createMemoryPod(): MemoryPod {
  const resources = new Map<string, StoredResource>();
  resources.set(TEST_PROFILE_DOC, { body: PROFILE_TURTLE, version: 1 });

  const pod: MemoryPod = {
    putCount: 0,
    get: (url) => resources.get(stripFragment(url))?.body,
    dataset: (url) => {
      const body = resources.get(stripFragment(url))?.body;
      return parseTurtle(body ?? "", stripFragment(url));
    },
    urls: () => [...resources.keys()].sort(),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = stripFragment(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      );
      const method = (init?.method ?? "GET").toUpperCase();
      const existing = resources.get(url);

      if (method === "GET") {
        if (!existing) return new Response("Not found", { status: 404 });
        return new Response(existing.body, {
          status: 200,
          headers: {
            "content-type": "text/turtle",
            etag: `"v${existing.version}"`,
          },
        });
      }

      if (method === "PUT") {
        const headers = new Headers(init?.headers);
        const ifMatch = headers.get("if-match");
        const ifNoneMatch = headers.get("if-none-match");
        if (ifNoneMatch === "*" && existing) {
          return new Response("Precondition failed", { status: 412 });
        }
        if (ifMatch && (!existing || `"v${existing.version}"` !== ifMatch)) {
          return new Response("Precondition failed", { status: 412 });
        }
        const version = (existing?.version ?? 0) + 1;
        resources.set(url, { body: String(init?.body ?? ""), version });
        pod.putCount += 1;
        return new Response(null, {
          status: existing ? 205 : 201,
          headers: { etag: `"v${version}"` },
        });
      }

      return new Response("Method not allowed", { status: 405 });
    }) as typeof fetch,
  };
  return pod;
}

/** Parse Turtle into an n3 Store (absolute IRIs resolved against `baseIri`). */
export function parseTurtle(text: string, baseIri?: string): Store {
  const store = new Store();
  if (text.trim().length > 0) {
    store.addQuads(new Parser({ baseIRI: baseIri }).parse(text));
  }
  return store;
}

function stripFragment(url: string): string {
  const i = url.indexOf("#");
  return i === -1 ? url : url.slice(0, i);
}

/**
 * The shared contract-test entry: run one demo-mode import (fixtures → memory
 * pod) and hand back both for assertions. `cursor` exercises incremental runs.
 */
export async function demoImport(
  adapter: IntegrationAdapter,
  opts?: { pod?: MemoryPod; cursor?: string },
): Promise<{ pod: MemoryPod; report: ImportReport }> {
  const pod = opts?.pod ?? createMemoryPod();
  const report = await runImport({
    adapter,
    webId: TEST_WEBID,
    podRoot: TEST_POD_ROOT,
    mode: "demo",
    cursor: opts?.cursor,
    podFetch: pod.fetch,
  });
  return { pod, report };
}
