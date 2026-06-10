import { describe, it, expect } from "vitest";
import { DataFactory, Store } from "n3";
import { IntegrationSyncError } from "./errors.js";
import { runImport } from "./import-runner.js";
import { createMemoryPod, TEST_POD_ROOT, TEST_WEBID } from "./testing.js";
import type { ImportContext, IntegrationAdapter } from "./types.js";
import { CLASSES, MusicRecording } from "./vocab.js";

/** Minimal adapter exercising the full runner path. */
const toyAdapter: IntegrationAdapter = {
  metadata: {
    id: "toy",
    name: "Toy",
    tier: "A",
    authKind: "oauth-pkce",
    scopes: [],
    categories: ["media"],
    whatYouGet: "One song.",
    requirements: [],
  },
  apiHeaders: { "x-toy": "1" },
  fixtures: () => [
    { url: "https://api.toy.test/songs", json: { songs: [{ id: "s1", title: "Demo Song" }] } },
  ],
  async import(ctx: ImportContext) {
    const res = await ctx.api("https://api.toy.test/songs");
    const { songs } = (await res.json()) as { songs: { id: string; title: string }[] };
    const store = new Store();
    const docUrl = ctx.resolve("music/songs.ttl");
    for (const s of songs) {
      const rec = new MusicRecording(`${docUrl}#song-${s.id}`, store, DataFactory).mark();
      rec.name = s.title;
      rec.identifier = s.id;
    }
    ctx.progress({ label: "Saving songs", done: 1, total: 1 });
    await ctx.write({
      slug: "music/songs.ttl",
      category: "media",
      forClass: CLASSES.MusicRecording,
      dataset: store,
    });
    return { cursor: "after-s1" };
  },
};

describe("runImport (demo mode, memory pod)", () => {
  it("writes fixture data into the adapter container and registers the class", async () => {
    const pod = createMemoryPod();
    const progress: string[] = [];

    const report = await runImport({
      adapter: toyAdapter,
      webId: TEST_WEBID,
      podRoot: TEST_POD_ROOT,
      mode: "demo",
      podFetch: pod.fetch,
      onProgress: (p) => progress.push(p.label),
    });

    const docUrl = `${TEST_POD_ROOT}integrations/toy/music/songs.ttl`;
    expect(report.written.map((w) => w.url)).toEqual([docUrl]);
    expect(report.categories).toEqual(["media"]);
    expect(report.cursor).toBe("after-s1");
    expect(progress).toContain("Saving songs");

    // The exact RDF: typed MusicRecording with the fixture title.
    const ds = pod.dataset(docUrl);
    const rec = new MusicRecording(`${docUrl}#song-s1`, ds, DataFactory);
    expect(rec.types.has(CLASSES.MusicRecording)).toBe(true);
    expect(rec.name).toBe("Demo Song");

    // Registered in the (bootstrapped) type index → appears under My data.
    expect(pod.get(report.indexUrl)).toContain(CLASSES.MusicRecording);
    expect(pod.get(report.indexUrl)).toContain("integrations/toy/music/");
  });

  it("is idempotent: re-import overwrites the same doc, no duplicates", async () => {
    const pod = createMemoryPod();
    const opts = {
      adapter: toyAdapter,
      webId: TEST_WEBID,
      podRoot: TEST_POD_ROOT,
      mode: "demo" as const,
      podFetch: pod.fetch,
    };
    const first = await runImport(opts);
    const urlsAfterFirst = pod.urls();
    const second = await runImport({ ...opts, cursor: first.cursor });

    expect(pod.urls()).toEqual(urlsAfterFirst); // same resources, nothing new
    expect(second.written).toHaveLength(1);
    const ds = pod.dataset(second.written[0].url);
    // Still exactly one song subject — overwritten, not appended.
    expect([...ds].filter((q) => q.predicate.value.endsWith("/name"))).toHaveLength(1);
  });

  it("refuses live mode without a token", async () => {
    const pod = createMemoryPod();
    await expect(
      runImport({
        adapter: toyAdapter,
        webId: TEST_WEBID,
        podRoot: TEST_POD_ROOT,
        mode: "live",
        podFetch: pod.fetch,
      }),
    ).rejects.toBeInstanceOf(IntegrationSyncError);
  });

  it("injects the bearer token + adapter headers in live mode", async () => {
    const pod = createMemoryPod();
    const seen: Record<string, string | null>[] = [];
    const apiFetch: typeof fetch = async (_input, init) => {
      const h = new Headers(init?.headers);
      seen.push({ authorization: h.get("authorization"), "x-toy": h.get("x-toy") });
      return Response.json({ songs: [] });
    };

    await runImport({
      adapter: toyAdapter,
      webId: TEST_WEBID,
      podRoot: TEST_POD_ROOT,
      mode: "live",
      token: { accessToken: "tok-1", tokenType: "Bearer" },
      podFetch: pod.fetch,
      apiFetch,
    });

    expect(seen[0]).toEqual({ authorization: "Bearer tok-1", "x-toy": "1" });
  });
});
