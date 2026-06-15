// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect, vi } from "vitest";
import { Parser } from "n3";
import {
  buildPoll,
  parsePoll,
  tallyRsvps,
  winningOption,
  readPollAt,
  respondToPoll,
  aggregatePollRsvps,
  readRsvpResourceAt,
  POLL_CLASS,
  type Poll,
  type Rsvp,
} from "./schedule.js";
import { InvalidTargetError } from "./errors.js";
import { serializeTurtle } from "./pod-data.js";

const URL = "https://alice.example/schedule/p1.ttl";
const ALICE = "https://alice.example/profile/card#me";
const BOB = "https://bob.example/profile/card#me";
const CAROL = "https://carol.example/profile/card#me";
const OPT_A = "2026-07-01T18:00:00.000Z";
const OPT_B = "2026-07-02T18:00:00.000Z";

describe("buildPoll / parsePoll round-trip", () => {
  it("preserves name/description/organizer/options/invitees/rsvps and stamps schema:Event", () => {
    const poll: Poll = {
      name: "Team dinner",
      description: "Pick a night",
      organizer: ALICE,
      options: [OPT_A, OPT_B],
      invitees: [BOB, CAROL],
      rsvps: [
        { attendee: BOB, option: OPT_A, response: "yes" },
        { attendee: CAROL, option: OPT_B, response: "maybe" },
      ],
    };
    const ds = buildPoll(URL, poll);
    const round = parsePoll(URL, ds);
    expect(round?.name).toBe("Team dinner");
    expect(round?.description).toBe("Pick a night");
    expect(round?.organizer).toBe(ALICE);
    expect(round?.options.sort()).toEqual([OPT_A, OPT_B].sort());
    expect(round?.invitees.sort()).toEqual([BOB, CAROL].sort());
    expect(round?.rsvps).toEqual(
      expect.arrayContaining([
        { attendee: BOB, option: OPT_A, response: "yes" },
        { attendee: CAROL, option: OPT_B, response: "maybe" },
      ]),
    );
    const hasType = [...ds].some(
      (q) => q.predicate.value.endsWith("#type") && q.object.value === POLL_CLASS,
    );
    expect(hasType).toBe(true);
  });

  it("drops non-WebID organizer/invitees/attendees", () => {
    const ds = buildPoll(URL, {
      name: "x",
      organizer: "not a webid",
      options: [OPT_A],
      invitees: ["nope"],
      rsvps: [{ attendee: "nope", option: OPT_A, response: "yes" }],
    });
    const round = parsePoll(URL, ds);
    expect(round?.organizer).toBeUndefined();
    expect(round?.invitees).toEqual([]);
    expect(round?.rsvps).toEqual([]);
  });

  it("returns undefined for a non-poll document", () => {
    const ds = buildPoll(URL, { name: "x", options: [], invitees: [], rsvps: [] });
    expect(parsePoll("https://alice.example/schedule/other.ttl", ds)).toBeUndefined();
  });
});

describe("tallyRsvps (pure)", () => {
  const rsvps: Rsvp[] = [
    { attendee: BOB, option: OPT_A, response: "yes" },
    { attendee: CAROL, option: OPT_A, response: "yes" },
    { attendee: BOB, option: OPT_B, response: "no" },
    { attendee: CAROL, option: OPT_B, response: "maybe" },
  ];

  it("counts yes/no/maybe per option, with empty options at zero", () => {
    const OPT_C = "2026-07-03T18:00:00.000Z";
    const t = tallyRsvps([OPT_A, OPT_B, OPT_C], rsvps);
    const a = t.find((x) => x.option === OPT_A)!;
    const b = t.find((x) => x.option === OPT_B)!;
    const c = t.find((x) => x.option === OPT_C)!;
    expect(a).toMatchObject({ yes: 2, no: 0, maybe: 0 });
    expect(b).toMatchObject({ yes: 0, no: 1, maybe: 1 });
    expect(c).toMatchObject({ yes: 0, no: 0, maybe: 0 });
  });

  it("counts a changed vote once (last response for an attendee+option wins)", () => {
    const changed: Rsvp[] = [
      { attendee: BOB, option: OPT_A, response: "no" },
      { attendee: BOB, option: OPT_A, response: "yes" }, // BOB changed their mind
    ];
    const t = tallyRsvps([OPT_A], changed);
    expect(t[0]).toMatchObject({ option: OPT_A, yes: 1, no: 0, maybe: 0 });
  });

  it("winningOption picks most-yes, breaking ties by fewest-no then time", () => {
    const t = tallyRsvps([OPT_A, OPT_B], rsvps);
    expect(winningOption(t)?.option).toBe(OPT_A); // 2 yes vs 0 yes
    expect(winningOption([])).toBeUndefined();
  });

  it("winningOption tiebreak: equal yes → fewest no, then earliest time", () => {
    // Both options have 1 yes; OPT_A also has 1 no, OPT_B has 0 no → OPT_B wins.
    const tie = tallyRsvps([OPT_A, OPT_B], [
      { attendee: BOB, option: OPT_A, response: "yes" },
      { attendee: CAROL, option: OPT_A, response: "no" },
      { attendee: BOB, option: OPT_B, response: "yes" },
    ]);
    expect(winningOption(tie)?.option).toBe(OPT_B);

    // Equal yes AND equal no → earliest time wins (OPT_A < OPT_B).
    const tie2 = tallyRsvps([OPT_A, OPT_B], [
      { attendee: BOB, option: OPT_A, response: "yes" },
      { attendee: CAROL, option: OPT_B, response: "yes" },
    ]);
    expect(winningOption(tie2)?.option).toBe(OPT_A);
  });
});

describe("readPollAt — validated read-only foreign poll fetch", () => {
  const POLL_URL = "https://carol.example/schedule/p1.ttl";

  it("validates the URL and reads a foreign poll read-only", async () => {
    const ds = buildPoll(POLL_URL, {
      name: "Foreign poll",
      organizer: CAROL,
      options: [OPT_A],
      invitees: [BOB],
      rsvps: [],
    });
    const turtle = await serializeTurtle(ds);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      // The read must force redirect:manual (token-leak guard).
      expect(init?.redirect).toBe("manual");
      if (String(input) === POLL_URL) {
        return new Response(turtle, { status: 200, headers: { "content-type": "text/turtle" } });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const poll = await readPollAt(POLL_URL, fetchImpl);
    expect(poll?.name).toBe("Foreign poll");
  });

  it("refuses to fetch a poll URL on an unsafe host (SSRF guard)", async () => {
    const fetchImpl = vi.fn(async () => new Response("x", { status: 200 })) as unknown as typeof fetch;
    await expect(readPollAt("https://127.0.0.1/schedule/p.ttl", fetchImpl)).rejects.toBeInstanceOf(
      InvalidTargetError,
    );
    await expect(readPollAt("http://carol.example/p.ttl", fetchImpl)).rejects.toBeInstanceOf(
      InvalidTargetError,
    ); // http is bad-scheme
    expect(fetchImpl).not.toHaveBeenCalled(); // never fetched
  });
});

describe("respondToPoll — same-pod write + notify organiser", () => {
  const POLL_URL = "https://carol.example/schedule/p1.ttl";
  const ATTENDEE_POD = "https://bob.example/";
  const ORG_DOC = "https://carol.example/profile/card";
  const ORG_INBOX = "https://carol.example/inbox/";

  it("writes the RSVP to the attendee's OWN pod and notifies the organiser", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string });
      if (url === ORG_DOC) {
        return new Response(
          `@prefix ldp: <http://www.w3.org/ns/ldp#> . <${CAROL}> ldp:inbox <${ORG_INBOX}> .`,
          { status: 200, headers: { "content-type": "text/turtle" } },
        );
      }
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;

    const { responseUrl } = await respondToPoll(
      {
        pollUrl: POLL_URL,
        organizerWebId: CAROL,
        attendeeWebId: BOB,
        podRoot: ATTENDEE_POD,
        option: OPT_A,
        response: "yes",
        pollName: "Team dinner",
      },
      fetchImpl,
    );

    // The RSVP resource was written in the ATTENDEE's own pod (never carol's).
    expect(responseUrl.startsWith("https://bob.example/schedule-responses/")).toBe(true);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe(responseUrl);
    // And it is a valid RsvpAction.
    const quads = new Parser().parse(put?.body as string);
    expect(
      quads.some(
        (q) => q.predicate.value.endsWith("#type") && q.object.value === "https://schema.org/RsvpAction",
      ),
    ).toBe(true);

    // The organiser was notified via their (validated) inbox.
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe(ORG_INBOX);
    // No write ever targeted the organiser's pod beyond the inbox POST.
    expect(calls.some((c) => c.method === "PUT" && c.url.startsWith("https://carol.example/"))).toBe(
      false,
    );
  });

  it("re-voting overwrites in place (deterministic response URL per poll)", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input) === ORG_DOC) {
        return new Response(
          `@prefix ldp: <http://www.w3.org/ns/ldp#> . <${CAROL}> ldp:inbox <${ORG_INBOX}> .`,
          { status: 200, headers: { "content-type": "text/turtle" } },
        );
      }
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const base = {
      pollUrl: POLL_URL,
      organizerWebId: CAROL,
      attendeeWebId: BOB,
      podRoot: ATTENDEE_POD,
      option: OPT_A,
      pollName: "x",
    };
    const a = await respondToPoll({ ...base, response: "yes" }, fetchImpl);
    const b = await respondToPoll({ ...base, response: "no" }, fetchImpl);
    expect(a.responseUrl).toBe(b.responseUrl); // same resource → overwrite, no orphans
  });
});

describe("aggregatePollRsvps — organiser-side loop closure", () => {
  const POLL_URL = "https://carol.example/schedule/p1.ttl";
  const BOB_RESP = "https://bob.example/schedule-responses/rsvp-x.ttl";

  function rsvpTtl(opts: { subject: string; object: string; attendee: string; option: string }): string {
    return `
      @prefix schema: <https://schema.org/> .
      <${opts.subject}#it> a schema:RsvpAction ;
        schema:object <${opts.object}> ;
        schema:attendee <${opts.attendee}> ;
        schema:startDate "${opts.option}"^^<http://www.w3.org/2001/XMLSchema#dateTime> ;
        schema:rsvpResponse schema:RsvpResponseYes .`;
  }

  it("merges RSVPs from validated Offer-linked response resources", async () => {
    const respTtl = rsvpTtl({ subject: BOB_RESP, object: POLL_URL, attendee: BOB, option: OPT_A });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual"); // validated read-only
      if (String(input) === BOB_RESP) {
        return new Response(respTtl, { status: 200, headers: { "content-type": "text/turtle" } });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const poll: Poll = { name: "p", options: [OPT_A], invitees: [BOB], rsvps: [], organizer: CAROL };
    const merged = await aggregatePollRsvps(
      poll,
      POLL_URL,
      [{ actor: BOB, object: POLL_URL, content: BOB_RESP }],
      fetchImpl,
    );
    expect(merged).toEqual([{ attendee: BOB, option: OPT_A, response: "yes" }]);
  });

  it("anti-ballot-stuffing: drops a response whose attendee != the Offer sender", async () => {
    // Bob's Offer links a resource that claims CAROL voted — must be rejected.
    const spoof = rsvpTtl({ subject: BOB_RESP, object: POLL_URL, attendee: CAROL, option: OPT_A });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === BOB_RESP) {
        return new Response(spoof, { status: 200, headers: { "content-type": "text/turtle" } });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const poll: Poll = { name: "p", options: [OPT_A], invitees: [], rsvps: [], organizer: CAROL };
    const merged = await aggregatePollRsvps(
      poll,
      POLL_URL,
      [{ actor: BOB, object: POLL_URL, content: BOB_RESP }],
      fetchImpl,
    );
    expect(merged).toEqual([]); // CAROL-impersonation rejected
  });

  it("drops a response whose schema:object is a different poll", async () => {
    const wrongPoll = rsvpTtl({
      subject: BOB_RESP,
      object: "https://carol.example/schedule/OTHER.ttl",
      attendee: BOB,
      option: OPT_A,
    });
    const fetchImpl = vi.fn(async () =>
      new Response(wrongPoll, { status: 200, headers: { "content-type": "text/turtle" } }),
    ) as unknown as typeof fetch;
    const poll: Poll = { name: "p", options: [OPT_A], invitees: [], rsvps: [], organizer: CAROL };
    const merged = await aggregatePollRsvps(poll, POLL_URL, [{ actor: BOB, object: POLL_URL, content: BOB_RESP }], fetchImpl);
    expect(merged).toEqual([]);
  });

  it("anti-impersonation: drops an Offer whose content is not in the actor's pod", async () => {
    // Attacker (bob) POSTs an Offer claiming actor=CAROL but hosts the response
    // in bob's own pod. CAROL's profile advertises only carol.example storage, so
    // the bob-hosted content does NOT belong to CAROL → rejected, never fetched.
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === "https://carol.example/profile/card") {
        return new Response(
          `@prefix pim: <http://www.w3.org/ns/pim/space#> . <${CAROL}> pim:storage <https://carol.example/> .`,
          { status: 200, headers: { "content-type": "text/turtle" } },
        );
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const poll: Poll = { name: "p", options: [OPT_A], invitees: [], rsvps: [], organizer: CAROL };
    const merged = await aggregatePollRsvps(
      poll,
      POLL_URL,
      [{ actor: CAROL, object: POLL_URL, content: BOB_RESP }], // CAROL actor, bob-hosted content
      fetchImpl,
    );
    expect(merged).toEqual([]);
    expect(requested).not.toContain(BOB_RESP); // the bob-hosted response never fetched
  });

  it("accepts a response in the actor's advertised pim:storage even on a different WebID origin", async () => {
    // Dan's WebID is on idp.example but his pod is on pods.example (the common
    // split-origin Solid config). A response under his advertised storage counts.
    const DAN = "https://idp.example/dan#me";
    const DAN_DOC = "https://idp.example/dan";
    const DAN_STORAGE = "https://pods.example/dan/";
    const DAN_RESP = "https://pods.example/dan/schedule-responses/r.ttl";
    const respTtl = rsvpTtl({ subject: DAN_RESP, object: POLL_URL, attendee: DAN, option: OPT_A });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === DAN_DOC) {
        return new Response(
          `@prefix pim: <http://www.w3.org/ns/pim/space#> . <${DAN}> pim:storage <${DAN_STORAGE}> .`,
          { status: 200, headers: { "content-type": "text/turtle" } },
        );
      }
      if (url === DAN_RESP) {
        return new Response(respTtl, { status: 200, headers: { "content-type": "text/turtle" } });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const poll: Poll = { name: "p", options: [OPT_A], invitees: [DAN], rsvps: [], organizer: CAROL };
    const merged = await aggregatePollRsvps(
      poll,
      POLL_URL,
      [{ actor: DAN, object: POLL_URL, content: DAN_RESP }],
      fetchImpl,
    );
    expect(merged).toEqual([{ attendee: DAN, option: OPT_A, response: "yes" }]);
  });

  it("SSRF backstop: even if the actor advertises loopback storage, the content body is never fetched", async () => {
    // Defence-in-depth: the actor's profile claims a 127.0.0.1 storage and the
    // content is "within" it, so contentBelongsToActor returns true — but the
    // final assertValidTargetUrl in readRsvpResourceAt must still block the GET.
    const EVIL = "https://idp.example/eve#me";
    const EVIL_DOC = "https://idp.example/eve";
    const LOOPBACK_RESP = "http://127.0.0.1/eve/r.ttl";
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input));
      if (String(input) === EVIL_DOC) {
        return new Response(
          `@prefix pim: <http://www.w3.org/ns/pim/space#> . <${EVIL}> pim:storage <http://127.0.0.1/> .`,
          { status: 200, headers: { "content-type": "text/turtle" } },
        );
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const poll: Poll = { name: "p", options: [OPT_A], invitees: [], rsvps: [], organizer: CAROL };
    const merged = await aggregatePollRsvps(
      poll,
      POLL_URL,
      [{ actor: EVIL, object: POLL_URL, content: LOOPBACK_RESP }],
      fetchImpl,
    );
    expect(merged).toEqual([]);
    expect(requested).not.toContain(LOOPBACK_RESP); // blocked by the final target guard
  });

  it("does not follow a WebID-doc redirect to a private host during storage discovery", async () => {
    // A malicious actor's profile 303s to a loopback host. Storage discovery uses
    // redirect:manual (noFollowFetch) so the redirect is NOT followed — the
    // loopback URL is never requested, storage resolves empty, and a bob-hosted
    // content (different origin from the actor) is therefore dropped.
    const EVIL = "https://idp.example/eve#me";
    const EVIL_DOC = "https://idp.example/eve";
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === EVIL_DOC) {
        return new Response(null, { status: 303, headers: { location: "http://127.0.0.1/eve" } });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const poll: Poll = { name: "p", options: [OPT_A], invitees: [], rsvps: [], organizer: CAROL };
    const merged = await aggregatePollRsvps(
      poll,
      POLL_URL,
      [{ actor: EVIL, object: POLL_URL, content: BOB_RESP }],
      fetchImpl,
    );
    expect(merged).toEqual([]);
    expect(requested).not.toContain("http://127.0.0.1/eve"); // redirect to private refused
  });

  it("ignores Offers for a different poll and never fetches an unsafe response URL", async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input));
      // bob's profile advertises bob.example storage.
      if (String(input) === "https://bob.example/profile/card") {
        return new Response(
          `@prefix pim: <http://www.w3.org/ns/pim/space#> . <${BOB}> pim:storage <https://bob.example/> .`,
          { status: 200, headers: { "content-type": "text/turtle" } },
        );
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const poll: Poll = { name: "p", options: [OPT_A], invitees: [], rsvps: [], organizer: CAROL };
    const merged = await aggregatePollRsvps(
      poll,
      POLL_URL,
      [
        // Wrong poll → filtered out before any fetch.
        { actor: BOB, object: "https://carol.example/schedule/OTHER.ttl", content: BOB_RESP },
        // Unsafe content host (not in bob's storage, not same-origin as actor) → dropped.
        { actor: BOB, object: POLL_URL, content: "https://127.0.0.1/steal.ttl" },
      ],
      fetchImpl,
    );
    expect(merged).toEqual([]); // nothing aggregated
    expect(requested).not.toContain("https://127.0.0.1/steal.ttl");
    expect(requested).not.toContain(BOB_RESP);
  });

  it("readRsvpResourceAt refuses an unsafe URL before fetching", async () => {
    const fetchImpl = vi.fn(async () => new Response("x", { status: 200 })) as unknown as typeof fetch;
    await expect(
      readRsvpResourceAt("https://10.0.0.1/x.ttl", POLL_URL, BOB, fetchImpl),
    ).rejects.toBeInstanceOf(InvalidTargetError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
