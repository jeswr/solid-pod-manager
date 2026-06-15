// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect, vi, afterEach } from "vitest";
import { DataFactory, Store } from "n3";
import { createMemoryPod, TEST_POD_ROOT, TEST_WEBID } from "../integrations/core/testing.js";
import { issuesStore, ISSUE_CLASS, type Issue } from "../issues.js";
import { validateAdvisory } from "./advisory.js";
import type { AdvisoryNotice, AdvisoryHandler } from "./advisory.js";
import * as validatorModule from "./validator.js";

const WF = "http://www.w3.org/2005/01/wf/flow#";
const DCT = "http://purl.org/dc/terms/";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

afterEach(() => vi.restoreAllMocks());

describe("validateAdvisory (the bridge)", () => {
  it("a conforming wf:Task graph surfaces nothing", async () => {
    const ds = new Store();
    const s = DataFactory.namedNode("http://x/u.ttl#it");
    ds.addQuad(s, DataFactory.namedNode(RDF_TYPE), DataFactory.namedNode(`${WF}Task`));
    ds.addQuad(s, DataFactory.namedNode(RDF_TYPE), DataFactory.namedNode(`${WF}Open`));
    ds.addQuad(s, DataFactory.namedNode(`${DCT}title`), DataFactory.literal("Hi"));

    const onAdvisory = vi.fn();
    const out = await validateAdvisory(ds, { forClass: ISSUE_CLASS, url: "http://x/u.ttl", onAdvisory });
    expect(out.conforms).toBe(true);
    expect(onAdvisory).not.toHaveBeenCalled();
  });

  it("a non-conforming graph calls onAdvisory with the violations (advisory, no throw)", async () => {
    const ds = new Store();
    const s = DataFactory.namedNode("http://x/u.ttl#it");
    ds.addQuad(s, DataFactory.namedNode(RDF_TYPE), DataFactory.namedNode(`${WF}Task`));
    ds.addQuad(s, DataFactory.namedNode(RDF_TYPE), DataFactory.namedNode(`${WF}Open`));
    // no dct:title → violation
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const onAdvisory = vi.fn();
    const out = await validateAdvisory(ds, { forClass: ISSUE_CLASS, url: "http://x/u.ttl", onAdvisory });
    expect(out.conforms).toBe(false);
    expect(onAdvisory).toHaveBeenCalledTimes(1);
    const notice = onAdvisory.mock.calls[0][0] as AdvisoryNotice;
    expect(notice.url).toBe("http://x/u.ttl");
    expect(notice.forClass).toBe(ISSUE_CLASS);
    expect(notice.results.some((r) => r.path === `${DCT}title`)).toBe(true);
  });

  it("an un-registered class is a no-op (validation is opt-in per write-type)", async () => {
    const ds = new Store();
    const onAdvisory = vi.fn();
    const out = await validateAdvisory(ds, {
      forClass: "https://example.org/Unknown",
      url: "http://x/u.ttl",
      onAdvisory,
    });
    expect(out.validated).toBe(false);
    expect(onAdvisory).not.toHaveBeenCalled();
  });

  it("a validator error is swallowed — never propagates (advisory cannot break a write)", async () => {
    const ds = new Store();
    ds.addQuad(
      DataFactory.namedNode("http://x/u.ttl#it"),
      DataFactory.namedNode(RDF_TYPE),
      DataFactory.namedNode(`${WF}Task`),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const exploding: AdvisoryHandler = () => {};
    const out = await validateAdvisory(ds, {
      forClass: ISSUE_CLASS,
      url: "http://x/u.ttl",
      onAdvisory: exploding,
      validator: {
        validate: async () => {
          throw new Error("engine blew up");
        },
      },
    });
    // Swallowed: resolves as "not validated", conforms true, no rejection.
    expect(out.validated).toBe(false);
    expect(out.conforms).toBe(true);
  });
});

describe("ProductivityStore write seam — advisory is non-blocking (pss-gc1)", () => {
  function setup() {
    const pod = createMemoryPod();
    const onAdvisory = vi.fn();
    const s = issuesStore({ podRoot: TEST_POD_ROOT, webId: TEST_WEBID, fetchImpl: pod.fetch, onAdvisory });
    return { pod, onAdvisory, s };
  }

  it("a valid issue create surfaces no advisory and writes the item", async () => {
    const { s, onAdvisory } = setup();
    const issue: Issue = { title: "Valid issue", state: "open" };
    const { url } = await s.create(issue, "Valid issue");
    expect(onAdvisory).not.toHaveBeenCalled();
    const read = await s.read(url);
    expect(read?.data.title).toBe("Valid issue");
  });

  it("an invalid issue still WRITES (never blocked) and fires a single advisory warning", async () => {
    const { s, onAdvisory } = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // A title-less issue: buildIssue emits no dct:title → shape violation.
    const issue: Issue = { title: "", state: "open" };

    // The create must NOT throw — the write is never gated by validation.
    const { url } = await s.create(issue);

    // The advisory is fire-and-forget (it runs detached AFTER create resolves),
    // so poll until it surfaces — exactly once — rather than assuming it has
    // already fired by the time the (non-blocking) write resolved.
    await vi.waitFor(() => expect(onAdvisory).toHaveBeenCalledTimes(1));
    const notice = onAdvisory.mock.calls[0][0] as AdvisoryNotice;
    expect(notice.results.some((r) => r.path === `${DCT}title`)).toBe(true);

    // ...and the (non-conforming) item is genuinely persisted in the pod.
    const read = await s.read(url);
    expect(read).toBeDefined();
    expect(read?.data.title).toBe("");
  });

  it("an invalid issue update still WRITES and fires an advisory (never blocked)", async () => {
    const { s, onAdvisory } = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // First create a valid issue, then update it into a non-conforming state.
    const { url } = await s.create({ title: "Originally valid", state: "open" }, "x");
    onAdvisory.mockClear();

    await expect(s.update(url, { title: "", state: "open" })).resolves.toBeDefined();
    // Detached advisory — poll until it fires (the update already resolved).
    await vi.waitFor(() => expect(onAdvisory).toHaveBeenCalledTimes(1));
    const read = await s.read(url);
    expect(read?.data.title).toBe("");
  });

  it("a store WITHOUT validate (opt-out) never validates — even an invalid graph is silent", async () => {
    // Reuse the issues build/parse but turn validation OFF, proving the opt-in flag.
    const pod = createMemoryPod();
    const onAdvisory = vi.fn();
    const { ISSUES_CONFIG } = await import("../issues.js");
    const { createStore } = await import("../productivity-store.js");
    const s = createStore(
      { ...ISSUES_CONFIG, validate: false },
      { podRoot: TEST_POD_ROOT, webId: TEST_WEBID, fetchImpl: pod.fetch, onAdvisory },
    );
    await s.create({ title: "", state: "open" } as Issue);
    expect(onAdvisory).not.toHaveBeenCalled();
  });

  it("a slow/hanging validator does NOT delay the write (advisory is fire-and-forget)", async () => {
    const { s } = setup();
    // A validator that never resolves: if the write awaited the advisory, the
    // create would hang forever. The fire-and-forget contract requires create
    // to resolve as soon as the pod write does, independent of this latency.
    let validateInvoked = false;
    vi.spyOn(validatorModule, "getDefaultValidator").mockReturnValue({
      validate: () =>
        new Promise<validatorModule.ValidationReport>(() => {
          validateInvoked = true;
          /* never resolves */
        }),
    });

    // Resolves promptly despite the hanging validator (a real timeout guards it
    // — vitest fails the test if create does not settle).
    const { url } = await s.create({ title: "", state: "open" } as Issue);
    expect(url.startsWith(`${TEST_POD_ROOT}`)).toBe(true);

    // The (non-conforming) item is genuinely persisted — the write happened.
    const read = await s.read(url);
    expect(read?.data.title).toBe("");

    // And the validator was actually engaged (so we proved it was kicked off,
    // not merely skipped), it just never gates the write.
    await vi.waitFor(() => expect(validateInvoked).toBe(true));
  });
});
