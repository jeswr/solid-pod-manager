// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import { createMemoryPod, TEST_POD_ROOT } from "../integrations/core/testing.js";
import { readResource } from "../pod-data.js";
import { saveFieldEdit, saveFormEdits } from "./write.js";
import { CONTACT_FIELDS } from "./edit-map.js";

const URL = `${TEST_POD_ROOT}contacts/c.ttl`;
const SUBJECT = `${URL}#it`;
const FN = "http://www.w3.org/2006/vcard/ns#fn";
const NOTE = "http://www.w3.org/2006/vcard/ns#note";
const EMAIL = "http://www.w3.org/2006/vcard/ns#hasEmail";

const SEED = `@prefix vcard: <http://www.w3.org/2006/vcard/ns#>.
<${SUBJECT}> a vcard:Individual ; vcard:fn "Ada" ; vcard:note "keep me" .`;

const nameField = CONTACT_FIELDS.find((f) => f.predicate === FN)!;

function seed(pod: ReturnType<typeof createMemoryPod>) {
  // Write the seed through the pod so it carries an ETag.
  return pod.fetch(URL, {
    method: "PUT",
    headers: { "content-type": "text/turtle" },
    body: SEED,
  });
}

describe("saveFieldEdit — conditional write round-trip", () => {
  it("saves a field, preserves unrelated triples, and returns a fresh ETag", async () => {
    const pod = createMemoryPod();
    await seed(pod);
    const { dataset, etag } = await readResource(URL, pod.fetch);

    const result = await saveFieldEdit(URL, dataset, SUBJECT, nameField, "Ada Byron", {
      fetchImpl: pod.fetch,
      etag,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.etag).toBeTruthy();

    // Re-read: fn changed, note preserved.
    const reread = await readResource(URL, pod.fetch);
    const fn: string[] = [];
    const note: string[] = [];
    for (const q of reread.dataset) {
      if (q.predicate.value === FN) fn.push(q.object.value);
      if (q.predicate.value === NOTE) note.push(q.object.value);
    }
    expect(fn).toEqual(["Ada Byron"]);
    expect(note).toEqual(["keep me"]);
  });

  it("reports `stale` on a 412 (concurrent edit)", async () => {
    const pod = createMemoryPod();
    await seed(pod);
    const { dataset } = await readResource(URL, pod.fetch);

    // Simulate a concurrent edit: someone else PUTs, bumping the ETag.
    await pod.fetch(URL, {
      method: "PUT",
      headers: { "content-type": "text/turtle" },
      body: SEED.replace("keep me", "changed elsewhere"),
    });

    // Our save still carries the OLD etag → 412.
    const result = await saveFieldEdit(URL, dataset, SUBJECT, nameField, "Ada Byron", {
      fetchImpl: pod.fetch,
      etag: '"v1"',
    });
    expect(result).toMatchObject({ ok: false, reason: "stale" });
  });

  it("reports `validation` on a malformed value without writing", async () => {
    const pod = createMemoryPod();
    await seed(pod);
    const { dataset, etag } = await readResource(URL, pod.fetch);
    const emailField = CONTACT_FIELDS.find((f) => f.predicate === EMAIL)!;
    const result = await saveFieldEdit(URL, dataset, SUBJECT, emailField, "not-an-email", {
      fetchImpl: pod.fetch,
      etag,
    });
    expect(result).toMatchObject({ ok: false, reason: "validation" });
  });

  it("refuses an unconditional write when no ETag is available (safe default)", async () => {
    const pod = createMemoryPod();
    await seed(pod);
    const { dataset } = await readResource(URL, pod.fetch);
    const before = pod.putCount;
    const result = await saveFieldEdit(URL, dataset, SUBJECT, nameField, "X", {
      fetchImpl: pod.fetch,
      etag: null,
    });
    expect(result).toMatchObject({ ok: false, reason: "stale" });
    expect(pod.putCount).toBe(before); // nothing was written
  });

  it("allows an unconditional write when the caller opts in", async () => {
    const pod = createMemoryPod();
    await seed(pod);
    const { dataset } = await readResource(URL, pod.fetch);
    const result = await saveFieldEdit(URL, dataset, SUBJECT, nameField, "Forced", {
      fetchImpl: pod.fetch,
      etag: null,
      allowUnconditional: true,
    });
    expect(result.ok).toBe(true);
  });

  it("reports `forbidden` on a 403", async () => {
    // A fetch that always 403s on write.
    const forbiddenFetch = (async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PUT") return new Response("no", { status: 403 });
      return new Response(SEED, { status: 200, headers: { "content-type": "text/turtle", etag: '"v1"' } });
    }) as unknown as typeof fetch;
    const dataset = await parseRdf(SEED, "text/turtle", { baseIRI: URL });
    const result = await saveFieldEdit(URL, dataset, SUBJECT, nameField, "X", {
      fetchImpl: forbiddenFetch,
      etag: '"v1"',
    });
    expect(result).toMatchObject({ ok: false, reason: "forbidden" });
  });
});

describe("saveFormEdits — multi-field write", () => {
  it("writes several fields in one document PUT", async () => {
    const pod = createMemoryPod();
    await seed(pod);
    const { dataset, etag } = await readResource(URL, pod.fetch);
    const before = pod.putCount;

    const result = await saveFormEdits(
      URL,
      dataset,
      SUBJECT,
      CONTACT_FIELDS,
      { [FN]: "Grace Hopper", [EMAIL]: "grace@navy.mil" },
      { fetchImpl: pod.fetch, etag },
    );

    expect(result.ok).toBe(true);
    expect(pod.putCount - before).toBe(1); // one document write, not two

    const reread = await readResource(URL, pod.fetch);
    const fn: string[] = [];
    const email: string[] = [];
    for (const q of reread.dataset) {
      if (q.predicate.value === FN) fn.push(q.object.value);
      if (q.predicate.value === EMAIL) email.push(q.object.value);
    }
    expect(fn).toEqual(["Grace Hopper"]);
    expect(email).toEqual(["mailto:grace@navy.mil"]);
  });
});
