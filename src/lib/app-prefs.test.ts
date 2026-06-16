// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
//
// Task #89 (G2/P0): app preferences moved from localStorage into the pod's
// owner-private preferences file (composing with G1, #87). These tests drive the
// REAL parse/serialise (parseRdf / n3.Writer via writeResource) against an
// in-memory pod; only `fetch` is stubbed. They cover:
//   - read from the pod (defaults when nothing stored / no prefs file),
//   - the full RDF round-trip (theme + channels + read markers + escape hatch),
//   - the read-modify-write PRESERVING foreign triples (G1's type-index link),
//   - a removed marker/extra leaving no orphan,
//   - the conditional write + idempotent re-write,
//   - corrupt-value tolerance.
import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import {
  createMemoryPod,
  TEST_POD_ROOT,
  TEST_PROFILE_DOC,
  TEST_WEBID,
} from "./integrations/core/testing.js";
import {
  appPrefsKey,
  appPrefsSubjectUrl,
  buildAppPrefsDataset,
  defaultAppPrefs,
  discoverPreferencesFile,
  fetchAppPrefs,
  isUnstoredDefault,
  legacyHasCustomisation,
  migrateLegacyPrefs,
  persistOptimistic,
  readAppPrefs,
  writeAppPrefs,
  type AppPrefs,
} from "./app-prefs.js";
import { SwrCache, deriveSwrInitialState } from "./swr-cache.js";
import {
  communityPrefsKey,
  defaultCommunityPrefs,
  type PrefsStorage,
} from "./community-prefs.js";
import { preferencesFileLink } from "./preferences.js";

/** A tiny in-memory localStorage double (the PrefsStorage contract). */
function memStorage(seed: Record<string, string> = {}): PrefsStorage {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

const PREFS_URL = `${TEST_POD_ROOT}settings/preferences.ttl`;
const SUBJECT = appPrefsSubjectUrl(PREFS_URL);

/** A representative non-default prefs object. */
function richPrefs(): AppPrefs {
  return {
    community: {
      matrixRooms: ["#solid_project:matrix.org", "#my-room:example.org"],
      discourseTopicIds: [42, 7],
      includeDiscourseLatest: false,
      readMarker: { "discourse:t:1": "12", "matrix:!room:server": "1700000000000" },
    },
    theme: "dark",
    extra: { sidebarCollapsed: "true", lastTab: "files" },
  };
}

describe("appPrefsKey (active-storage scoped)", () => {
  it("scopes the key per active storage (SWR active-storage rule)", () => {
    expect(appPrefsKey("https://a.example/")).toBe("app-prefs:https://a.example/");
    expect(appPrefsKey("https://a.example/")).not.toBe(appPrefsKey("https://b.example/"));
  });
});

describe("defaultAppPrefs", () => {
  it("has no theme, empty extra, and the default community prefs", () => {
    const d = defaultAppPrefs();
    expect(d.theme).toBeUndefined();
    expect(d.extra).toEqual({});
    expect(d.community.matrixRooms.length).toBeGreaterThan(0);
    expect(d.community.includeDiscourseLatest).toBe(true);
    expect(d.community.readMarker).toEqual({});
  });
});

describe("buildAppPrefsDataset + readAppPrefs (RDF round-trip via real parse/serialise)", () => {
  it("round-trips theme, channels, the latest flag, read markers, and the escape hatch", () => {
    const prefs = richPrefs();
    const ds = buildAppPrefsDataset(PREFS_URL, prefs, undefined);
    const back = readAppPrefs(PREFS_URL, ds);

    expect(back.theme).toBe("dark");
    expect([...back.community.matrixRooms].sort()).toEqual([...prefs.community.matrixRooms].sort());
    expect([...back.community.discourseTopicIds].sort((a, b) => a - b)).toEqual([7, 42]);
    expect(back.community.includeDiscourseLatest).toBe(false);
    expect(back.community.readMarker).toEqual(prefs.community.readMarker);
    expect(back.extra).toEqual(prefs.extra);
  });

  it("survives a Turtle serialise → parse → read trip (real n3.Writer / parseRdf)", async () => {
    const prefs = richPrefs();
    const ds = buildAppPrefsDataset(PREFS_URL, prefs, undefined);
    // Serialise with the SAME serialiser the write path uses.
    const { serializeTurtle } = await import("./pod-data.js");
    const ttl = await serializeTurtle(ds);
    const parsed = await parseRdf(ttl, "text/turtle", { baseIRI: PREFS_URL });
    const back = readAppPrefs(PREFS_URL, parsed);
    expect(back.theme).toBe("dark");
    expect(back.community.includeDiscourseLatest).toBe(false);
    expect(back.community.readMarker).toEqual(prefs.community.readMarker);
    expect(back.extra.lastTab).toBe("files");
  });

  it("marks the subject a pm:AppPreferences and entries pm:Entry (self-describing)", async () => {
    const ds = buildAppPrefsDataset(PREFS_URL, richPrefs(), undefined);
    const { serializeTurtle } = await import("./pod-data.js");
    const ttl = await serializeTurtle(ds);
    expect(ttl).toContain("AppPreferences");
    expect(ttl).toContain("Entry");
    // Never a hand-built/raw literal undefined.
    expect(ttl).not.toMatch(/"undefined"/);
  });

  it("yields defaults for a document with no app-prefs subject", async () => {
    const empty = await parseRdf(
      `@prefix space: <http://www.w3.org/ns/pim/space#>.
       <${PREFS_URL}> a space:ConfigurationFile .`,
      "text/turtle",
      { baseIRI: PREFS_URL },
    );
    const back = readAppPrefs(PREFS_URL, empty);
    expect(back).toEqual(defaultAppPrefs());
  });

  it("treats an explicitly-empty room set as empty (not the defaults) once the subject exists", () => {
    const prefs: AppPrefs = {
      community: {
        matrixRooms: [],
        discourseTopicIds: [],
        includeDiscourseLatest: true,
        readMarker: {},
      },
      extra: {},
    };
    const ds = buildAppPrefsDataset(PREFS_URL, prefs, undefined);
    const back = readAppPrefs(PREFS_URL, ds);
    expect(back.community.matrixRooms).toEqual([]); // user cleared all rooms — honoured
  });

  it("drops corrupt read markers (non-numeric / negative) but keeps valid ones", async () => {
    // Hand-author a doc with a good + bad marker to prove coercion on read.
    const ttl = `@prefix pm: <https://w3id.org/jeswr/pod-manager#>.
      <${SUBJECT}> a pm:AppPreferences ; pm:entry <${PREFS_URL}#e0>, <${PREFS_URL}#e1>, <${PREFS_URL}#e2>.
      <${PREFS_URL}#e0> pm:key "readMarker:good" ; pm:value "5" .
      <${PREFS_URL}#e1> pm:key "readMarker:bad" ; pm:value "not-a-number" .
      <${PREFS_URL}#e2> pm:key "readMarker:neg" ; pm:value "-3" .`;
    const ds = await parseRdf(ttl, "text/turtle", { baseIRI: PREFS_URL });
    const back = readAppPrefs(PREFS_URL, ds);
    expect(back.community.readMarker).toEqual({ good: "5" });
  });

  it("coerces an unknown theme value to undefined", async () => {
    const ttl = `@prefix pm: <https://w3id.org/jeswr/pod-manager#>.
      <${SUBJECT}> a pm:AppPreferences ; pm:theme "neon" .`;
    const ds = await parseRdf(ttl, "text/turtle", { baseIRI: PREFS_URL });
    expect(readAppPrefs(PREFS_URL, ds).theme).toBeUndefined();
  });
});

describe("buildAppPrefsDataset preserves foreign triples (read-modify-write)", () => {
  const FOREIGN = `@prefix space: <http://www.w3.org/ns/pim/space#>.
    @prefix solid: <http://www.w3.org/ns/solid/terms#>.
    @prefix pm: <https://w3id.org/jeswr/pod-manager#>.
    <${PREFS_URL}> a space:ConfigurationFile ;
      solid:privateTypeIndex <${TEST_POD_ROOT}settings/privateTypeIndex.ttl> .
    <${SUBJECT}> a pm:AppPreferences ; pm:theme "light" ;
      pm:entry <${PREFS_URL}#podmanager-entry-0> .
    <${PREFS_URL}#podmanager-entry-0> a pm:Entry ; pm:key "readMarker:old" ; pm:value "1" .`;

  it("keeps G1's solid:privateTypeIndex link + the ConfigurationFile type across a write", async () => {
    const existing = await parseRdf(FOREIGN, "text/turtle", { baseIRI: PREFS_URL });
    const next = buildAppPrefsDataset(PREFS_URL, richPrefs(), existing);
    const { serializeTurtle } = await import("./pod-data.js");
    const ttl = await serializeTurtle(next);
    expect(ttl).toContain("privateTypeIndex");
    expect(ttl).toContain("ConfigurationFile");
    // The app-prefs subject is rewritten to the new value.
    const back = readAppPrefs(PREFS_URL, next);
    expect(back.theme).toBe("dark");
  });

  it("removes a now-absent read marker, leaving NO orphan entry triples", async () => {
    const existing = await parseRdf(FOREIGN, "text/turtle", { baseIRI: PREFS_URL });
    // New prefs with NO read markers — the old `readMarker:old` entry must vanish.
    const cleared: AppPrefs = { ...defaultAppPrefs(), community: defaultAppPrefs().community };
    const next = buildAppPrefsDataset(PREFS_URL, cleared, existing);
    const { serializeTurtle } = await import("./pod-data.js");
    const ttl = await serializeTurtle(next);
    expect(ttl).not.toContain("readMarker:old");
    expect(ttl).not.toContain("podmanager-entry-0"); // the OLD entry subject is gone
  });
});

describe("fetchAppPrefs (read path; never creates a resource)", () => {
  it("returns defaults when the card links no preferences file", async () => {
    const pod = createMemoryPod();
    const before = pod.putCount;
    const prefs = await fetchAppPrefs(TEST_WEBID, pod.fetch);
    expect(prefs).toEqual(defaultAppPrefs());
    expect(pod.putCount).toBe(before); // a read never writes
  });

  it("returns defaults when the linked prefs file is missing (404)", async () => {
    const pod = createMemoryPod();
    // Link a prefs file that does not exist.
    await pod.fetch(TEST_PROFILE_DOC, {
      method: "PUT",
      headers: { "content-type": "text/turtle", "if-match": '"v1"' },
      body: `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
        @prefix pim: <http://www.w3.org/ns/pim/space#>.
        @prefix space: <http://www.w3.org/ns/pim/space#>.
        <${TEST_WEBID}> a foaf:Person ; pim:storage <${TEST_POD_ROOT}> ;
          space:preferencesFile <${PREFS_URL}> .`,
    });
    const prefs = await fetchAppPrefs(TEST_WEBID, pod.fetch);
    expect(prefs).toEqual(defaultAppPrefs());
  });

  it("reads stored app-prefs back from a linked, populated prefs file", async () => {
    const pod = createMemoryPod();
    await writeAppPrefs({
      webId: TEST_WEBID,
      activeStorage: TEST_POD_ROOT,
      prefs: richPrefs(),
      fetchImpl: pod.fetch,
    });
    const prefs = await fetchAppPrefs(TEST_WEBID, pod.fetch);
    expect(prefs.theme).toBe("dark");
    expect([...prefs.community.discourseTopicIds].sort((a, b) => a - b)).toEqual([7, 42]);
    expect(prefs.community.readMarker).toEqual(richPrefs().community.readMarker);
    expect(prefs.extra).toEqual(richPrefs().extra);
  });
});

describe("writeAppPrefs (ensure → conditional write; composes with G1)", () => {
  it("mints + WAC-locks + links a prefs file when none exists, then stores the prefs", async () => {
    const pod = createMemoryPod();
    const { preferencesFile } = await writeAppPrefs({
      webId: TEST_WEBID,
      activeStorage: TEST_POD_ROOT,
      prefs: richPrefs(),
      fetchImpl: pod.fetch,
    });
    expect(preferencesFile).toBe(PREFS_URL);

    // The prefs file exists, is owner-only WAC-locked (G1), and linked from card.
    expect(pod.get(PREFS_URL)).toContain("AppPreferences");
    expect(pod.get(`${PREFS_URL}.acl`)).toBeTruthy();
    const card = await parseRdf(pod.get(TEST_PROFILE_DOC) ?? "", "text/turtle", {
      baseIRI: TEST_PROFILE_DOC,
    });
    expect(preferencesFileLink(TEST_WEBID, card)).toBe(PREFS_URL);
  });

  it("is idempotent — a re-write reuses the existing file and preserves foreign triples", async () => {
    const pod = createMemoryPod();
    await writeAppPrefs({
      webId: TEST_WEBID,
      activeStorage: TEST_POD_ROOT,
      prefs: richPrefs(),
      fetchImpl: pod.fetch,
    });
    // A second write with different prefs reuses the file (no new mint/link).
    const second: AppPrefs = { ...richPrefs(), theme: "light" };
    const { preferencesFile } = await writeAppPrefs({
      webId: TEST_WEBID,
      activeStorage: TEST_POD_ROOT,
      prefs: second,
      fetchImpl: pod.fetch,
    });
    expect(preferencesFile).toBe(PREFS_URL);
    const prefs = await fetchAppPrefs(TEST_WEBID, pod.fetch);
    expect(prefs.theme).toBe("light");
  });

  it("FAILS CLOSED when the existing prefs file is unreadable (403) — never clobbers foreign triples", async () => {
    const pod = createMemoryPod();
    // First, establish + populate the prefs file normally.
    await writeAppPrefs({
      webId: TEST_WEBID,
      activeStorage: TEST_POD_ROOT,
      prefs: richPrefs(),
      fetchImpl: pod.fetch,
    });
    const before = pod.get(PREFS_URL);

    // Now wrap the pod fetch so a GET of the prefs file returns 403 (forbidden) —
    // the write-path re-read must FAIL CLOSED rather than PUT over it blind.
    const forbiddenFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.split("#")[0] === PREFS_URL) {
        return new Response("Forbidden", { status: 403 });
      }
      return pod.fetch(input, init);
    }) as typeof fetch;

    await expect(
      writeAppPrefs({
        webId: TEST_WEBID,
        activeStorage: TEST_POD_ROOT,
        prefs: { ...richPrefs(), theme: "light" },
        fetchImpl: forbiddenFetch,
      }),
    ).rejects.toBeTruthy();
    // The existing document is untouched (no clobber on an unreadable file).
    expect(pod.get(PREFS_URL)).toBe(before);
  });
});

describe("discoverPreferencesFile", () => {
  it("returns the linked file, or undefined when none is linked", async () => {
    const pod = createMemoryPod();
    expect(await discoverPreferencesFile(TEST_WEBID, pod.fetch)).toBeUndefined();
    await writeAppPrefs({
      webId: TEST_WEBID,
      activeStorage: TEST_POD_ROOT,
      prefs: defaultAppPrefs(),
      fetchImpl: pod.fetch,
    });
    expect(await discoverPreferencesFile(TEST_WEBID, pod.fetch)).toBe(PREFS_URL);
  });
});

describe("isUnstoredDefault / legacyHasCustomisation (migration gates)", () => {
  it("a fresh default model is 'unstored default'; any customisation is not", () => {
    expect(isUnstoredDefault(defaultAppPrefs())).toBe(true);
    expect(isUnstoredDefault({ ...defaultAppPrefs(), theme: "dark" })).toBe(false);
    expect(isUnstoredDefault(richPrefs())).toBe(false);
  });

  it("default community prefs are NOT a customisation; a changed set is", () => {
    expect(legacyHasCustomisation(defaultCommunityPrefs())).toBe(false);
    expect(legacyHasCustomisation(richPrefs().community)).toBe(true);
    expect(
      legacyHasCustomisation({ ...defaultCommunityPrefs(), includeDiscourseLatest: false }),
    ).toBe(true);
  });
});

describe("migrateLegacyPrefs (one-time, idempotent)", () => {
  it("migrates legacy localStorage community prefs UP when the pod is empty", async () => {
    const legacy = richPrefs().community;
    const storage = memStorage({
      [communityPrefsKey(TEST_WEBID)]: JSON.stringify(legacy),
    });
    const writes: AppPrefs[] = [];
    const outcome = await migrateLegacyPrefs({
      webId: TEST_WEBID,
      activeStorage: TEST_POD_ROOT,
      podPrefs: defaultAppPrefs(), // pod is empty → migrate
      storage,
      verify: async () => defaultAppPrefs(), // re-confirmed still empty
      write: async (o) => {
        writes.push(o.prefs);
        return { preferencesFile: PREFS_URL };
      },
    });
    expect(outcome.status).toBe("migrated");
    expect(writes).toHaveLength(1);
    expect(writes[0].community.matrixRooms).toEqual(legacy.matrixRooms);
    expect(writes[0].community.readMarker).toEqual(legacy.readMarker);
  });

  it("ABORTS the write when the fresh re-verify shows the pod now has prefs (stale mirror)", async () => {
    // The rendered model (from the durable mirror after a failed revalidation)
    // LOOKS empty, but a fresh re-read shows the pod actually has prefs — the
    // migration must NOT overwrite them (roborev Medium).
    const storage = memStorage({
      [communityPrefsKey(TEST_WEBID)]: JSON.stringify(richPrefs().community),
    });
    let wrote = false;
    const outcome = await migrateLegacyPrefs({
      webId: TEST_WEBID,
      activeStorage: TEST_POD_ROOT,
      podPrefs: defaultAppPrefs(), // mirror says empty…
      storage,
      verify: async () => richPrefs(), // …but the authoritative pod has prefs
      write: async () => {
        wrote = true;
        return { preferencesFile: PREFS_URL };
      },
    });
    expect(outcome).toEqual({ status: "skipped", reason: "pod-has-prefs" });
    expect(wrote).toBe(false);
  });

  it("treats a re-verify FAILURE as 'failed' (never migrate over an unconfirmed pod)", async () => {
    const storage = memStorage({
      [communityPrefsKey(TEST_WEBID)]: JSON.stringify(richPrefs().community),
    });
    let wrote = false;
    const outcome = await migrateLegacyPrefs({
      webId: TEST_WEBID,
      activeStorage: TEST_POD_ROOT,
      podPrefs: defaultAppPrefs(),
      storage,
      verify: async () => {
        throw new Error("pod offline");
      },
      write: async () => {
        wrote = true;
        return { preferencesFile: PREFS_URL };
      },
    });
    expect(outcome.status).toBe("failed");
    expect(wrote).toBe(false);
  });

  it("SKIPS (no write) when the pod already has stored prefs (idempotent)", async () => {
    const storage = memStorage({
      [communityPrefsKey(TEST_WEBID)]: JSON.stringify(richPrefs().community),
    });
    let wrote = false;
    const outcome = await migrateLegacyPrefs({
      webId: TEST_WEBID,
      activeStorage: TEST_POD_ROOT,
      podPrefs: richPrefs(), // pod already has prefs → never overwrite
      storage,
      write: async () => {
        wrote = true;
        return { preferencesFile: PREFS_URL };
      },
    });
    expect(outcome).toEqual({ status: "skipped", reason: "pod-has-prefs" });
    expect(wrote).toBe(false);
  });

  it("SKIPS when legacy localStorage has no customisation (nothing to migrate)", async () => {
    const storage = memStorage(); // no legacy entry → defaults
    let wrote = false;
    const outcome = await migrateLegacyPrefs({
      webId: TEST_WEBID,
      activeStorage: TEST_POD_ROOT,
      podPrefs: defaultAppPrefs(),
      storage,
      write: async () => {
        wrote = true;
        return { preferencesFile: PREFS_URL };
      },
    });
    expect(outcome).toEqual({ status: "skipped", reason: "no-legacy-customisation" });
    expect(wrote).toBe(false);
  });

  it("end-to-end against a memory pod: legacy prefs land in the pod and read back", async () => {
    const pod = createMemoryPod();
    const legacy = richPrefs().community;
    const storage = memStorage({
      [communityPrefsKey(TEST_WEBID)]: JSON.stringify(legacy),
    });
    const outcome = await migrateLegacyPrefs({
      webId: TEST_WEBID,
      activeStorage: TEST_POD_ROOT,
      podPrefs: await fetchAppPrefs(TEST_WEBID, pod.fetch), // empty (no file yet)
      storage,
      verify: (id) => fetchAppPrefs(id, pod.fetch), // re-confirm against the pod
      write: (o) => writeAppPrefs({ ...o, fetchImpl: pod.fetch }),
    });
    expect(outcome.status).toBe("migrated");
    const stored = await fetchAppPrefs(TEST_WEBID, pod.fetch);
    expect([...stored.community.matrixRooms].sort()).toEqual([...legacy.matrixRooms].sort());
    expect(stored.community.readMarker).toEqual(legacy.readMarker);

    // IDEMPOTENT: a second migration with the now-populated pod is a no-op.
    let wrote = false;
    const again = await migrateLegacyPrefs({
      webId: TEST_WEBID,
      activeStorage: TEST_POD_ROOT,
      podPrefs: stored,
      storage,
      write: async () => {
        wrote = true;
        return { preferencesFile: PREFS_URL };
      },
    });
    expect(again).toEqual({ status: "skipped", reason: "pod-has-prefs" });
    expect(wrote).toBe(false);
  });

  it("reports a write failure as 'failed' (not migrated, marker not set)", async () => {
    const storage = memStorage({
      [communityPrefsKey(TEST_WEBID)]: JSON.stringify(richPrefs().community),
    });
    const outcome = await migrateLegacyPrefs({
      webId: TEST_WEBID,
      activeStorage: TEST_POD_ROOT,
      podPrefs: defaultAppPrefs(),
      storage,
      verify: async () => defaultAppPrefs(), // pod confirmed empty…
      write: async () => {
        throw new Error("pod offline"); // …but the write fails
      },
    });
    expect(outcome.status).toBe("failed");
  });
});

describe("persistOptimistic (optimistic write + revert-on-failure)", () => {
  const OTHER = "https://other.example/storage/";

  it("paints the new value in the cache immediately, then keeps it on success", async () => {
    const cache = new SwrCache(null);
    cache.set(TEST_WEBID, appPrefsKey(TEST_POD_ROOT), defaultAppPrefs());
    const next = richPrefs();

    let observedDuringWrite: AppPrefs | undefined;
    await persistOptimistic({
      cache,
      webId: TEST_WEBID,
      activeStorage: TEST_POD_ROOT,
      next,
      write: async () => {
        // The cache already shows `next` BEFORE the pod write resolves (optimistic).
        observedDuringWrite = cache.get<AppPrefs>(TEST_WEBID, appPrefsKey(TEST_POD_ROOT));
        return { preferencesFile: PREFS_URL };
      },
    });
    expect(observedDuringWrite).toEqual(next); // painted before the write resolved
    expect(cache.get<AppPrefs>(TEST_WEBID, appPrefsKey(TEST_POD_ROOT))).toEqual(next); // kept on success
  });

  it("REVERTS the cache to the previous value and re-throws on a write failure", async () => {
    const cache = new SwrCache(null);
    const previous = richPrefs();
    cache.set(TEST_WEBID, appPrefsKey(TEST_POD_ROOT), previous);
    const next: AppPrefs = { ...previous, theme: "light" };

    await expect(
      persistOptimistic({
        cache,
        webId: TEST_WEBID,
        activeStorage: TEST_POD_ROOT,
        next,
        write: async () => {
          throw new Error("pod rejected");
        },
      }),
    ).rejects.toThrow("pod rejected");
    // Reverted to the pre-write value (so the UI can restore it + toast).
    expect(cache.get<AppPrefs>(TEST_WEBID, appPrefsKey(TEST_POD_ROOT))).toEqual(previous);
  });

  it("CONCURRENT writes: an older write's FAILURE never clobbers a newer write (identity-guarded revert)", async () => {
    // The roborev High: write A (older) is in flight; write B (newer) lands and
    // succeeds; then A fails. A's revert must NOT roll back past B.
    const cache = new SwrCache(null);
    const key = appPrefsKey(TEST_POD_ROOT);
    const original = richPrefs();
    cache.set(TEST_WEBID, key, original);

    const a: AppPrefs = { ...original, theme: "light" };
    const b: AppPrefs = { ...original, theme: "system" };

    // Write A: a write that REJECTS later (we control when via a deferred).
    let failA!: () => void;
    const aFailed = new Promise<{ preferencesFile: string }>((_, reject) => {
      failA = () => reject(new Error("A failed late"));
    });
    const pA = persistOptimistic({
      cache,
      webId: TEST_WEBID,
      activeStorage: TEST_POD_ROOT,
      next: a,
      write: () => aFailed,
    });
    // Write B: lands immediately and succeeds (it is the NEWER value now in the slot).
    await persistOptimistic({
      cache,
      webId: TEST_WEBID,
      activeStorage: TEST_POD_ROOT,
      next: b,
      write: async () => ({ preferencesFile: PREFS_URL }),
    });
    expect(cache.get<AppPrefs>(TEST_WEBID, key)).toEqual(b); // B is in the slot

    // Now A finally fails — its revert must be SUPPRESSED (B's value is current).
    failA();
    await expect(pA).rejects.toThrow("A failed late");
    expect(cache.get<AppPrefs>(TEST_WEBID, key)).toEqual(b); // NOT rolled back to A's `previous`
  });

  it("writes into the ACTIVE-STORAGE slot only — a same-WebID storage switch is isolated", async () => {
    const cache = new SwrCache(null);
    // Storage A already has its own prefs cached.
    const aPrefs: AppPrefs = { ...defaultAppPrefs(), theme: "dark" };
    cache.set(TEST_WEBID, appPrefsKey(TEST_POD_ROOT), aPrefs);

    // Write prefs for OTHER storage (same WebID).
    const bPrefs: AppPrefs = { ...defaultAppPrefs(), theme: "light" };
    await persistOptimistic({
      cache,
      webId: TEST_WEBID,
      activeStorage: OTHER,
      next: bPrefs,
      write: async () => ({ preferencesFile: `${OTHER}settings/preferences.ttl` }),
    });

    // A's slot is untouched; B's slot holds B's prefs — keys never collide.
    expect(cache.get<AppPrefs>(TEST_WEBID, appPrefsKey(TEST_POD_ROOT))).toEqual(aPrefs);
    expect(cache.get<AppPrefs>(TEST_WEBID, appPrefsKey(OTHER))).toEqual(bPrefs);
    // Switching to B paints B's value, never A's (deriveSwrInitialState).
    const onB = deriveSwrInitialState<AppPrefs>(cache, TEST_WEBID, appPrefsKey(OTHER));
    expect(onB.data).toEqual(bPrefs);
    const onA = deriveSwrInitialState<AppPrefs>(cache, TEST_WEBID, appPrefsKey(TEST_POD_ROOT));
    expect(onA.data).toEqual(aPrefs);
  });
});

describe("localStorage MIRROR: a durable snapshot paints instantly on cold open", () => {
  /** An in-memory durable store fake (the localStorage mirror under test). */
  class FakeDurable {
    readonly map = new Map<string, unknown>();
    private k(webId: string, key: string) {
      return `${webId} ${key}`;
    }
    read<T>(webId: string, key: string): T | null {
      return this.map.has(this.k(webId, key)) ? (this.map.get(this.k(webId, key)) as T) : null;
    }
    write<T>(webId: string, key: string, value: T): void {
      this.map.set(this.k(webId, key), value);
    }
    clearEntry(webId: string, key: string): void {
      this.map.delete(this.k(webId, key));
    }
    clearWebId(webId: string): void {
      for (const k of [...this.map.keys()]) if (k.startsWith(`${webId} `)) this.map.delete(k);
    }
    clearAll(): void {
      this.map.clear();
    }
  }

  it("a value mirrored to durable storage cold-opens instantly (no spinner) on a fresh cache", () => {
    const durable = new FakeDurable();
    // Session 1: a write mirrors the value to durable (the localStorage mirror).
    const writer = new SwrCache(durable);
    writer.set(TEST_WEBID, appPrefsKey(TEST_POD_ROOT), richPrefs());

    // Session 2 / cold open: a brand-new in-memory cache over the same durable.
    const coldOpen = new SwrCache(durable);
    const first = deriveSwrInitialState<AppPrefs>(coldOpen, TEST_WEBID, appPrefsKey(TEST_POD_ROOT));
    expect(first.loading).toBe(false); // instant paint from the mirror
    expect(first.data).toEqual(richPrefs());
    expect(first.revalidating).toBe(true); // pod still revalidates in the background
  });
});
