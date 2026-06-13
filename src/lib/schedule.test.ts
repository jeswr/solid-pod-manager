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
});
