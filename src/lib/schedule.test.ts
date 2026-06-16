// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect, vi } from "vitest";
import { Parser, Store } from "n3";

/** Parse Turtle into a real DatasetCore (n3 Store) — as `freshRdf` does. */
function parseToStore(ttl: string): Store {
  return new Store(new Parser().parse(ttl));
}
import {
  buildPoll,
  parsePoll,
  tallyRsvps,
  winningOption,
  readPollAt,
  respondToPoll,
  aggregatePollRsvps,
  readRsvpResourceAt,
  readLinkedResultsResponses,
  inspectLinkedResults,
  mergeRsvpsWithinOptions,
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

// Interop vocab term IRIs (assert the EXACT predicates/classes SolidOS uses).
const SCHED = "http://www.w3.org/ns/pim/schedule#";
const CAL = "http://www.w3.org/2002/12/cal/ical#";

describe("buildPoll / parsePoll round-trip (SolidOS sched: shape)", () => {
  it("preserves name/description/organizer/options/invitees/rsvps and stamps sched:SchedulableEvent", () => {
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
  });

  it("round-trips a mailto: invitee back as a foaf:mbox node (not dropped on save)", () => {
    // A SolidOS poll's foaf:mbox invitee parses to a mailto: id; buildPoll must
    // serialise it back as sched:invitee [ foaf:mbox <mailto:…> ] (roborev Medium),
    // so saving a parsed SolidOS poll doesn't lose mail-only invitees.
    const MBOX = "mailto:dana@example.com";
    const ds = buildPoll(URL, {
      name: "mixed invitees",
      options: [OPT_A],
      invitees: [BOB, MBOX],
      rsvps: [],
    });
    // The WebID is a direct sched:invitee link; the mailto is on a foaf:mbox node.
    const hasMbox = [...ds].some(
      (q) => q.predicate.value === "http://xmlns.com/foaf/0.1/mbox" && q.object.value === MBOX,
    );
    expect(hasMbox).toBe(true);
    const round = parsePoll(URL, ds);
    expect(round?.invitees.sort()).toEqual([BOB, MBOX].sort());
  });

  it("emits the EXACT SolidOS interop triples (class, cal:summary, sched:option→cal:dtstart, response→cell→availabilty sched:Yes)", () => {
    const ds = buildPoll(URL, {
      name: "Team dinner",
      organizer: ALICE,
      options: [OPT_A],
      invitees: [BOB],
      rsvps: [{ attendee: BOB, option: OPT_A, response: "yes" }],
    });
    const quads = [...ds];
    const has = (p: string, o: string) => quads.some((q) => q.predicate.value === p && q.object.value === o);
    const hasPred = (p: string) => quads.some((q) => q.predicate.value === p);

    // a sched:SchedulableEvent
    expect(quads.some((q) => q.predicate.value.endsWith("#type") && q.object.value === POLL_CLASS)).toBe(
      true,
    );
    // cal:summary "Team dinner"
    expect(has(`${CAL}summary`, "Team dinner")).toBe(true);
    // sched:availabilityOptions sched:YesNoMaybe + sched:ready present
    expect(has(`${SCHED}availabilityOptions`, `${SCHED}YesNoMaybe`)).toBe(true);
    expect(hasPred(`${SCHED}ready`)).toBe(true);
    // self-referential sched:results <pollUrl>
    expect(has(`${SCHED}results`, URL)).toBe(true);

    // sched:option → cal:dtstart
    const optLink = quads.find((q) => q.predicate.value === `${SCHED}option`);
    expect(optLink, "a sched:option link").toBeDefined();
    const optNode = optLink!.object.value;
    const dtstart = quads.find((q) => q.subject.value === optNode && q.predicate.value === `${CAL}dtstart`);
    expect(dtstart, "option node has cal:dtstart").toBeDefined();
    expect(new Date(dtstart!.object.value).toISOString()).toBe(OPT_A);

    // sched:response → dc:author + sched:cell → cal:dtstart + sched:availabilty sched:Yes
    const respLink = quads.find((q) => q.predicate.value === `${SCHED}response`);
    expect(respLink, "a sched:response link").toBeDefined();
    const respNode = respLink!.object.value;
    expect(
      quads.some(
        (q) =>
          q.subject.value === respNode &&
          q.predicate.value === "http://purl.org/dc/elements/1.1/author" &&
          q.object.value === BOB,
      ),
    ).toBe(true);
    const cellLink = quads.find((q) => q.subject.value === respNode && q.predicate.value === `${SCHED}cell`);
    expect(cellLink, "response node has a sched:cell").toBeDefined();
    const cellNode = cellLink!.object.value;
    // The MISSPELLED sched:availabilty is load-bearing for the live SolidOS pane.
    expect(
      quads.some(
        (q) =>
          q.subject.value === cellNode &&
          q.predicate.value === `${SCHED}availabilty` &&
          q.object.value === `${SCHED}Yes`,
      ),
      "cell carries the misspelled sched:availabilty → sched:Yes",
    ).toBe(true);
    expect(
      quads.some((q) => q.subject.value === cellNode && q.predicate.value === `${CAL}dtstart`),
      "cell carries cal:dtstart",
    ).toBe(true);
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

  it("returns undefined for a document holding no poll of either shape", () => {
    // No sched:SchedulableEvent and no schema:Event anywhere → not a poll.
    const ds = parseToStore(
      `<${URL}#it> a <https://schema.org/CreativeWork> ; <https://schema.org/name> "x" .`,
    );
    expect(parsePoll(URL, ds)).toBeUndefined();
  });

  it("discovers the poll subject regardless of the itemUrl argument (foreign read)", () => {
    // A poll built at URL parses even when read under a DIFFERENT itemUrl, because
    // parsePoll discovers the sched:SchedulableEvent subject rather than assuming
    // `${itemUrl}#it` (this is what enables reading any foreign SolidOS poll).
    const ds = buildPoll(URL, { name: "x", options: [], invitees: [], rsvps: [] });
    expect(parsePoll("https://alice.example/schedule/other.ttl", ds)?.name).toBe("x");
  });

  it("tally is correct from sched:Yes/Maybe/No cells after a round-trip", () => {
    const ds = buildPoll(URL, {
      name: "p",
      organizer: ALICE,
      options: [OPT_A, OPT_B],
      invitees: [],
      rsvps: [
        { attendee: BOB, option: OPT_A, response: "yes" },
        { attendee: CAROL, option: OPT_A, response: "maybe" },
        { attendee: BOB, option: OPT_B, response: "no" },
      ],
    });
    const round = parsePoll(URL, ds)!;
    const t = tallyRsvps(round.options, round.rsvps);
    expect(t.find((x) => x.option === OPT_A)).toMatchObject({ yes: 1, maybe: 1, no: 0 });
    expect(t.find((x) => x.option === OPT_B)).toMatchObject({ yes: 0, maybe: 0, no: 1 });
  });
});

describe("parsePoll — a hand-written SolidOS-shaped poll (interop READ)", () => {
  // Mirrors SolidOS solid-panes test/unit/meeting/Schedule/details.ttl: a poll
  // subject with cal:summary, sched:invitee NODES (foaf:mbox/foaf:agent),
  // sched:option→cal:dtstart (one DATE-ONLY to prove lenient parsing), and an
  // inline results block (sched:response→dc:author + sched:cell→cal:dtstart +
  // the MISSPELLED sched:availabilty).
  const SOLIDOS_TTL = `
    @prefix sched: <${SCHED}> .
    @prefix cal: <${CAL}> .
    @prefix dc: <http://purl.org/dc/elements/1.1/> .
    @prefix foaf: <http://xmlns.com/foaf/0.1/> .
    @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

    <${URL}#it> a sched:SchedulableEvent ;
      cal:summary "Project kickoff" ;
      cal:comment "When can everyone meet?" ;
      dc:author <${ALICE}> ;
      sched:availabilityOptions sched:YesNoMaybe ;
      sched:ready "2016-06-20T10:00:00Z"^^xsd:dateTime ;
      sched:invitee <${URL}#inv-bob> , <${BOB}> ;
      sched:option <${URL}#opt-1> , <${URL}#opt-2> ;
      sched:response <${URL}#r-bob> .

    <${URL}#inv-bob> foaf:agent <${CAROL}> ; foaf:mbox <mailto:bob@example.com> .
    <${URL}#opt-1> cal:dtstart "2016-06-23"^^xsd:date .
    <${URL}#opt-2> cal:dtstart "2026-07-01T18:00:00.000Z"^^xsd:dateTime .

    <${URL}#r-bob> dc:author <${BOB}> ; sched:results <${URL}> ; sched:cell <${URL}#c-bob-1> .
    <${URL}#c-bob-1> cal:dtstart "2026-07-01T18:00:00.000Z"^^xsd:dateTime ;
      sched:availabilty sched:Yes .`;

  it("reads name, options (incl. a date-only cal:dtstart), invitees (direct + node), and a correct tally", () => {
    const ds = parseToStore(SOLIDOS_TTL);
    const poll = parsePoll(URL, ds);
    expect(poll?.name).toBe("Project kickoff");
    expect(poll?.description).toBe("When can everyone meet?");
    expect(poll?.organizer).toBe(ALICE);

    // The date-only "2016-06-23" parsed leniently to an ISO instant + the dateTime option.
    expect(poll?.options).toContain("2026-07-01T18:00:00.000Z");
    expect(poll?.options.some((o) => o.startsWith("2016-06-23"))).toBe(true);
    expect(poll?.options.length).toBe(2);

    // Invitees: the direct WebID + the foaf:agent of the invitee node.
    expect(poll?.invitees).toEqual(expect.arrayContaining([BOB, CAROL]));

    // The misspelled sched:availabilty → tally one yes for the dateTime option.
    const t = tallyRsvps(poll!.options, poll!.rsvps);
    expect(t.find((x) => x.option === "2026-07-01T18:00:00.000Z")).toMatchObject({ yes: 1 });
    expect(poll?.rsvps).toEqual([
      { attendee: BOB, option: "2026-07-01T18:00:00.000Z", response: "yes" },
    ]);
  });

  it("tolerates the W3C ns-doc spelling sched:availibility as a read fallback", () => {
    const ttl = `
      @prefix sched: <${SCHED}> .
      @prefix cal: <${CAL}> .
      @prefix dc: <http://purl.org/dc/elements/1.1/> .
      <${URL}#it> a sched:SchedulableEvent ; cal:summary "x" ;
        sched:option <${URL}#o> ; sched:response <${URL}#r> .
      <${URL}#o> cal:dtstart "${OPT_A}" .
      <${URL}#r> dc:author <${BOB}> ; sched:results <${URL}> ; sched:cell <${URL}#c> .
      <${URL}#c> cal:dtstart "${OPT_A}" ; sched:availibility sched:Maybe .`;
    const poll = parsePoll(URL, parseToStore(ttl));
    expect(poll?.rsvps).toEqual([{ attendee: BOB, option: OPT_A, response: "maybe" }]);
  });

  it("discovers a foreign poll subject that is NOT #it (e.g. SolidOS <#event>)", () => {
    // SolidOS mints its own event subject (details.ttl uses <#event>), so parsePoll
    // must discover the sched:SchedulableEvent subject, not assume `${itemUrl}#it`.
    const ttl = `
      @prefix sched: <${SCHED}> .
      @prefix cal: <${CAL}> .
      @prefix dc: <http://purl.org/dc/elements/1.1/> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      <${URL}#event> a sched:SchedulableEvent ; cal:summary "Foreign subject" ;
        dc:author <${ALICE}> ; sched:option <${URL}#o> ; sched:response <${URL}#r> .
      <${URL}#o> cal:dtstart "${OPT_A}"^^xsd:dateTime .
      <${URL}#r> dc:author <${BOB}> ; sched:results <${URL}> ; sched:cell <${URL}#c> .
      <${URL}#c> cal:dtstart "${OPT_A}"^^xsd:dateTime ; sched:availabilty sched:Yes .`;
    const poll = parsePoll(URL, parseToStore(ttl));
    expect(poll?.name).toBe("Foreign subject");
    expect(poll?.organizer).toBe(ALICE);
    expect(poll?.options).toEqual([OPT_A]);
    expect(poll?.rsvps).toEqual([{ attendee: BOB, option: OPT_A, response: "yes" }]);
  });
});

describe("parsePoll — backwards-compat with the legacy schema.org shape", () => {
  // A poll PM wrote BEFORE this interop change: schema:Event + repeated
  // schema:startDate options + schema:RsvpAction subjects. After upgrade,
  // parsePoll must still read it (else list() silently drops it — roborev Medium).
  const LEGACY_TTL = `
    @prefix schema: <https://schema.org/> .
    @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
    <${URL}#it> a schema:Event ;
      schema:name "Old poll" ;
      schema:description "legacy" ;
      schema:organizer <${ALICE}> ;
      schema:startDate "${OPT_A}"^^xsd:dateTime , "${OPT_B}"^^xsd:dateTime ;
      schema:invitee <${BOB}> .
    <${URL}#rsvp-0> a schema:RsvpAction ;
      schema:object <${URL}> ;
      schema:attendee <${BOB}> ;
      schema:startDate "${OPT_A}"^^xsd:dateTime ;
      schema:rsvpResponse schema:RsvpResponseYes .`;

  it("reads a legacy schema:Event poll (name/options/invitees/rsvps) so it isn't dropped", () => {
    const poll = parsePoll(URL, parseToStore(LEGACY_TTL));
    expect(poll?.name).toBe("Old poll");
    expect(poll?.description).toBe("legacy");
    expect(poll?.organizer).toBe(ALICE);
    expect(poll?.options.sort()).toEqual([OPT_A, OPT_B].sort());
    expect(poll?.invitees).toEqual([BOB]);
    expect(poll?.rsvps).toEqual([{ attendee: BOB, option: OPT_A, response: "yes" }]);
    // The tally is correct off the legacy RSVPs.
    expect(tallyRsvps(poll!.options, poll!.rsvps).find((x) => x.option === OPT_A)).toMatchObject({
      yes: 1,
    });
  });

  it("re-serialises a legacy poll to the sched: shape on the next save (round-trips forward)", () => {
    const legacy = parsePoll(URL, parseToStore(LEGACY_TTL))!;
    const reSaved = buildPoll(URL, legacy);
    const round = parsePoll(URL, reSaved);
    // Now stamped sched:SchedulableEvent, with the data preserved.
    expect([...reSaved].some((q) => q.predicate.value.endsWith("#type") && q.object.value === POLL_CLASS)).toBe(
      true,
    );
    expect(round?.name).toBe("Old poll");
    expect(round?.rsvps).toEqual([{ attendee: BOB, option: OPT_A, response: "yes" }]);
  });

  it("returns undefined for a document that is neither a sched: nor a legacy poll", () => {
    const ttl = `<${URL}#it> a <https://schema.org/CreativeWork> ; <https://schema.org/name> "nope" .`;
    expect(parsePoll(URL, parseToStore(ttl))).toBeUndefined();
  });

  it("collapses duplicate legacy (attendee, option) RSVPs to ONE (matches tally)", () => {
    // Two legacy RsvpActions for the same (bob, OPT_A) must NOT accumulate as two
    // entries (roborev Low): parsePoll de-dupes per (attendee, option) the same
    // way readResponses/tallyRsvps do, so the raw rsvps and the tally agree.
    const ttl = `
      @prefix schema: <https://schema.org/> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      <${URL}#it> a schema:Event ; schema:name "dupes" ;
        schema:startDate "${OPT_A}"^^xsd:dateTime .
      <${URL}#rsvp-0> a schema:RsvpAction ; schema:object <${URL}> ;
        schema:attendee <${BOB}> ; schema:startDate "${OPT_A}"^^xsd:dateTime ;
        schema:rsvpResponse schema:RsvpResponseNo .
      <${URL}#rsvp-1> a schema:RsvpAction ; schema:object <${URL}> ;
        schema:attendee <${BOB}> ; schema:startDate "${OPT_A}"^^xsd:dateTime ;
        schema:rsvpResponse schema:RsvpResponseYes .`;
    const poll = parsePoll(URL, parseToStore(ttl))!;
    // Exactly one collapsed entry for the pair (not two).
    expect(poll.rsvps.filter((r) => r.attendee === BOB && r.option === OPT_A)).toHaveLength(1);
    // The tally counts that single collapsed vote exactly once.
    const t = tallyRsvps(poll.options, poll.rsvps).find((x) => x.option === OPT_A)!;
    expect(t.yes + t.no + t.maybe).toBe(1);
  });

  it("excludes a legacy RsvpAction bound to a DIFFERENT poll (schema:object filter)", () => {
    // A stray RsvpAction in the same resource whose schema:object is another poll
    // must NOT count toward this poll's tally (roborev Low). Bob's matching vote
    // counts; the unrelated Carol vote (object=OTHER) does not.
    const ttl = `
      @prefix schema: <https://schema.org/> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      <${URL}#it> a schema:Event ; schema:name "bound" ;
        schema:startDate "${OPT_A}"^^xsd:dateTime .
      <${URL}#rsvp-0> a schema:RsvpAction ; schema:object <${URL}> ;
        schema:attendee <${BOB}> ; schema:startDate "${OPT_A}"^^xsd:dateTime ;
        schema:rsvpResponse schema:RsvpResponseYes .
      <${URL}#stray> a schema:RsvpAction ; schema:object <https://x.example/OTHER.ttl> ;
        schema:attendee <${CAROL}> ; schema:startDate "${OPT_A}"^^xsd:dateTime ;
        schema:rsvpResponse schema:RsvpResponseNo .`;
    const poll = parsePoll(URL, parseToStore(ttl))!;
    expect(poll.rsvps).toEqual([{ attendee: BOB, option: OPT_A, response: "yes" }]);
    expect(poll.rsvps.some((r) => r.attendee === CAROL)).toBe(false);
  });
});

describe("buildPoll — sched:results binding is the poll RESOURCE URL (not #it)", () => {
  it("binds inline responses' sched:results to the poll resource URL so aggregation matches", () => {
    const poll: Poll = {
      name: "p",
      organizer: ALICE,
      options: [OPT_A],
      invitees: [BOB],
      rsvps: [{ attendee: BOB, option: OPT_A, response: "yes" }],
    };
    const ds = buildPoll(URL, poll);
    const results = [...ds].filter((q) => q.predicate.value === `${SCHED}results`).map((q) => q.object.value);
    // Both the poll-level self-reference AND each response node bind to <URL>
    // (the resource URL), never <URL#it>. A mismatch breaks readRsvpResourceAt's
    // forPoll === expectedPoll check (roborev finding).
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const r of results) expect(r).toBe(URL);
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

describe("mergeRsvpsWithinOptions (pure) — drops off-list options", () => {
  const OPT_C = "2026-07-03T18:00:00.000Z";
  it("keeps base as-is and merges only extra RSVPs for DECLARED options (last-wins)", () => {
    const base: Rsvp[] = [{ attendee: BOB, option: OPT_A, response: "yes" }];
    const extra: Rsvp[] = [
      { attendee: CAROL, option: OPT_B, response: "maybe" }, // in-list → kept
      { attendee: CAROL, option: OPT_C, response: "yes" }, // OFF-list → dropped
      { attendee: BOB, option: OPT_A, response: "no" }, // in-list, last-wins over base
    ];
    const out = mergeRsvpsWithinOptions(base, extra, [OPT_A, OPT_B]);
    expect(out).toEqual(
      expect.arrayContaining([
        { attendee: BOB, option: OPT_A, response: "no" },
        { attendee: CAROL, option: OPT_B, response: "maybe" },
      ]),
    );
    expect(out.some((r) => r.option === OPT_C)).toBe(false); // phantom option rejected
    expect(out).toHaveLength(2);
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

  it("merges responses from a SEPARATE sched:results document (SolidOS shape)", async () => {
    // A SolidOS poll keeps responses in a distinct results.ttl linked by
    // sched:results. readPollAt must fetch (SSRF-guarded) + merge them, else the
    // tally is silently empty (roborev Medium).
    const RESULTS_URL = "https://carol.example/schedule/p1-results.ttl";
    const pollTtl = `
      @prefix sched: <${SCHED}> .
      @prefix cal: <${CAL}> .
      @prefix dc: <http://purl.org/dc/elements/1.1/> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      <${POLL_URL}#it> a sched:SchedulableEvent ; cal:summary "Separate results" ;
        dc:author <${CAROL}> ; sched:results <${RESULTS_URL}> ;
        sched:option <${POLL_URL}#o> .
      <${POLL_URL}#o> cal:dtstart "${OPT_A}"^^xsd:dateTime .`;
    // Responses live in the results doc, linked FROM the poll subject.
    const resultsTtl = `
      @prefix sched: <${SCHED}> .
      @prefix cal: <${CAL}> .
      @prefix dc: <http://purl.org/dc/elements/1.1/> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      <${POLL_URL}#it> sched:response <${RESULTS_URL}#r> .
      <${RESULTS_URL}#r> dc:author <${BOB}> ; sched:cell <${RESULTS_URL}#c> .
      <${RESULTS_URL}#c> cal:dtstart "${OPT_A}"^^xsd:dateTime ; sched:availabilty sched:Yes .`;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual"); // both reads SSRF-guarded
      if (String(input) === POLL_URL) {
        return new Response(pollTtl, { status: 200, headers: { "content-type": "text/turtle" } });
      }
      if (String(input) === RESULTS_URL) {
        return new Response(resultsTtl, { status: 200, headers: { "content-type": "text/turtle" } });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const poll = await readPollAt(POLL_URL, fetchImpl);
    expect(poll?.name).toBe("Separate results");
    expect(poll?.rsvps).toEqual([{ attendee: BOB, option: OPT_A, response: "yes" }]);
    expect(tallyRsvps(poll!.options, poll!.rsvps).find((x) => x.option === OPT_A)).toMatchObject({ yes: 1 });
  });

  it("does not fetch an UNSAFE sched:results URL, and a bad results doc never sinks the read", async () => {
    const pollTtl = `
      @prefix sched: <${SCHED}> .
      @prefix cal: <${CAL}> .
      @prefix dc: <http://purl.org/dc/elements/1.1/> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      <${POLL_URL}#it> a sched:SchedulableEvent ; cal:summary "Evil results" ;
        dc:author <${CAROL}> ; sched:results <http://127.0.0.1/steal.ttl> ;
        sched:option <${POLL_URL}#o> .
      <${POLL_URL}#o> cal:dtstart "${OPT_A}"^^xsd:dateTime .`;
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input));
      if (String(input) === POLL_URL) {
        return new Response(pollTtl, { status: 200, headers: { "content-type": "text/turtle" } });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const poll = await readPollAt(POLL_URL, fetchImpl);
    expect(poll?.name).toBe("Evil results"); // poll still read
    expect(requested).not.toContain("http://127.0.0.1/steal.ttl"); // loopback never fetched
  });
});

describe("readLinkedResultsResponses — separate sched:results doc (organiser + foreign paths)", () => {
  const POLL_URL = "https://carol.example/schedule/p1.ttl";
  const RESULTS_URL = "https://carol.example/schedule/p1-results.ttl";

  function pollWithSeparateResults(resultsLink: string): string {
    return `
      @prefix sched: <${SCHED}> .
      @prefix cal: <${CAL}> .
      @prefix dc: <http://purl.org/dc/elements/1.1/> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      <${POLL_URL}#event> a sched:SchedulableEvent ; cal:summary "p" ;
        dc:author <${CAROL}> ; sched:results <${resultsLink}> ;
        sched:option <${POLL_URL}#o> .
      <${POLL_URL}#o> cal:dtstart "${OPT_A}"^^xsd:dateTime .`;
  }
  const RESULTS_TTL = `
    @prefix sched: <${SCHED}> .
    @prefix cal: <${CAL}> .
    @prefix dc: <http://purl.org/dc/elements/1.1/> .
    @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
    <${POLL_URL}#event> sched:response <${RESULTS_URL}#r> .
    <${RESULTS_URL}#r> dc:author <${BOB}> ; sched:cell <${RESULTS_URL}#c> .
    <${RESULTS_URL}#c> cal:dtstart "${OPT_A}"^^xsd:dateTime ; sched:availabilty sched:Yes .`;

  it("fetches + reads responses from a non-self results doc (own-pod organiser path: no preloaded dataset)", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual"); // SSRF-guarded
      if (String(input) === POLL_URL) {
        return new Response(pollWithSeparateResults(RESULTS_URL), {
          status: 200,
          headers: { "content-type": "text/turtle" },
        });
      }
      if (String(input) === RESULTS_URL) {
        return new Response(RESULTS_TTL, { status: 200, headers: { "content-type": "text/turtle" } });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    // No preloaded dataset → it fetches the poll doc itself, then the results doc.
    const extra = await readLinkedResultsResponses(POLL_URL, fetchImpl);
    expect(extra).toEqual([{ attendee: BOB, option: OPT_A, response: "yes" }]);
  });

  it("is a no-op for a self-referential results link (PM-authored poll)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(pollWithSeparateResults(POLL_URL), { status: 200, headers: { "content-type": "text/turtle" } }),
    ) as unknown as typeof fetch;
    // sched:results === the poll URL → nothing separate to fetch; returns [].
    expect(await readLinkedResultsResponses(POLL_URL, fetchImpl)).toEqual([]);
    // Only the poll doc was fetched (no second GET).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never fetches an UNSAFE results URL (SSRF guard)", async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input));
      if (String(input) === POLL_URL) {
        return new Response(pollWithSeparateResults("http://127.0.0.1/steal.ttl"), {
          status: 200,
          headers: { "content-type": "text/turtle" },
        });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    expect(await readLinkedResultsResponses(POLL_URL, fetchImpl)).toEqual([]);
    expect(requested).not.toContain("http://127.0.0.1/steal.ttl");
  });

  describe("inspectLinkedResults — discriminate no-doc / read-ok / read-failed (save-path guard)", () => {
    const mk = (pollTtl: string, resultsStatus: number, resultsBody = RESULTS_TTL) =>
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === POLL_URL) {
          return new Response(pollTtl, { status: 200, headers: { "content-type": "text/turtle" } });
        }
        if (String(input) === RESULTS_URL) {
          return new Response(resultsStatus === 200 ? resultsBody : "x", {
            status: resultsStatus,
            headers: { "content-type": "text/turtle" },
          });
        }
        return new Response("nf", { status: 404 });
      }) as unknown as typeof fetch;

    it("self-referential poll → hasSeparate:false, readFailed:false", async () => {
      const out = await inspectLinkedResults(POLL_URL, mk(pollWithSeparateResults(POLL_URL), 200));
      expect(out).toMatchObject({ hasSeparate: false, readFailed: false, responses: [] });
    });

    it("separate doc reads OK → hasSeparate:true, readFailed:false, responses merged", async () => {
      const out = await inspectLinkedResults(POLL_URL, mk(pollWithSeparateResults(RESULTS_URL), 200));
      expect(out.hasSeparate).toBe(true);
      expect(out.readFailed).toBe(false);
      expect(out.responses).toEqual([{ attendee: BOB, option: OPT_A, response: "yes" }]);
    });

    it("separate doc is 404 (not yet created) → readFailed:false (safe to save)", async () => {
      const out = await inspectLinkedResults(POLL_URL, mk(pollWithSeparateResults(RESULTS_URL), 404));
      expect(out).toMatchObject({ hasSeparate: true, readFailed: false, responses: [] });
    });

    it("separate doc EXISTS but errors (403) → readFailed:true (save must abort, roborev High)", async () => {
      const out = await inspectLinkedResults(POLL_URL, mk(pollWithSeparateResults(RESULTS_URL), 403));
      expect(out).toMatchObject({ hasSeparate: true, readFailed: true, responses: [] });
    });

    it("trusted (save) mode reads a SAME-ORIGIN results doc on a LOCAL origin (roborev Medium)", async () => {
      // A local CSS/dev poll (http://localhost:3000) the cross-pod validator would
      // reject. In trusted mode the same-origin results doc is read directly.
      const LOCAL_POLL = "http://localhost:3000/schedule/p1.ttl";
      const LOCAL_RESULTS = "http://localhost:3000/schedule/p1-results.ttl";
      const pollTtl = `
        @prefix sched: <${SCHED}> .
        @prefix cal: <${CAL}> .
        @prefix dc: <http://purl.org/dc/elements/1.1/> .
        @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
        <${LOCAL_POLL}#event> a sched:SchedulableEvent ; cal:summary "local" ;
          dc:author <${CAROL}> ; sched:results <${LOCAL_RESULTS}> ;
          sched:option <${LOCAL_POLL}#o> .
        <${LOCAL_POLL}#o> cal:dtstart "${OPT_A}"^^xsd:dateTime .`;
      const resultsTtl = `
        @prefix sched: <${SCHED}> .
        @prefix cal: <${CAL}> .
        @prefix dc: <http://purl.org/dc/elements/1.1/> .
        @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
        <${LOCAL_POLL}#event> sched:response <${LOCAL_RESULTS}#r> .
        <${LOCAL_RESULTS}#r> dc:author <${BOB}> ; sched:cell <${LOCAL_RESULTS}#c> .
        <${LOCAL_RESULTS}#c> cal:dtstart "${OPT_A}"^^xsd:dateTime ; sched:availabilty sched:Yes .`;
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === LOCAL_POLL) return new Response(pollTtl, { status: 200, headers: { "content-type": "text/turtle" } });
        if (String(input) === LOCAL_RESULTS) return new Response(resultsTtl, { status: 200, headers: { "content-type": "text/turtle" } });
        return new Response("nf", { status: 404 });
      }) as unknown as typeof fetch;
      const out = await inspectLinkedResults(LOCAL_POLL, { trusted: true, fetchImpl });
      expect(out).toMatchObject({ hasSeparate: true, readFailed: false });
      expect(out.responses).toEqual([{ attendee: BOB, option: OPT_A, response: "yes" }]);
    });

    it("trusted mode: poll fetch failure → readFailed:true (blocks save); read mode → no-op", async () => {
      const failFetch = vi.fn(async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
      expect(await inspectLinkedResults(POLL_URL, { trusted: true, fetchImpl: failFetch })).toMatchObject({
        readFailed: true,
      });
      // Read mode (default) is best-effort: a failure is a no-op, never blocks.
      expect(await inspectLinkedResults(POLL_URL, { fetchImpl: failFetch })).toMatchObject({
        hasSeparate: false,
        readFailed: false,
      });
    });

    it("a MALFORMED sched:results (a literal, not a named node) never throws (roborev Low)", async () => {
      // sched:results as a string literal would make NamedNodeAs.string throw if
      // read naively; inspectLinkedResults must swallow it and return safely.
      const pollTtl = `
        @prefix sched: <${SCHED}> .
        @prefix cal: <${CAL}> .
        @prefix dc: <http://purl.org/dc/elements/1.1/> .
        @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
        <${POLL_URL}#event> a sched:SchedulableEvent ; cal:summary "bad results" ;
          dc:author <${CAROL}> ; sched:results "not a node" ;
          sched:option <${POLL_URL}#o> .
        <${POLL_URL}#o> cal:dtstart "${OPT_A}"^^xsd:dateTime .`;
      const fetchImpl = vi.fn(async () =>
        new Response(pollTtl, { status: 200, headers: { "content-type": "text/turtle" } }),
      ) as unknown as typeof fetch;
      // Must not throw; read mode → no-op, trusted mode → treated as can't-inspect.
      await expect(inspectLinkedResults(POLL_URL, { fetchImpl })).resolves.toBeDefined();
      await expect(inspectLinkedResults(POLL_URL, { trusted: true, fetchImpl })).resolves.toBeDefined();
    });
  });
});

describe("respondToPoll — same-pod write + notify organiser", () => {
  const POLL_URL = "https://carol.example/schedule/p1.ttl";
  const ATTENDEE_POD = "https://bob.example/";
  const ORG_DOC = "https://carol.example/profile/card";
  const ORG_INBOX = "https://carol.example/inbox/";

  it("writes the RSVP to the attendee's OWN pod (sched: response shape) and notifies the organiser", async () => {
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
    // And it carries the sched: response shape: a cell with the misspelled
    // sched:availabilty → sched:Yes, authored by BOB, bound to the poll.
    const quads = new Parser().parse(put?.body as string);
    expect(
      quads.some((q) => q.predicate.value === `${SCHED}availabilty` && q.object.value === `${SCHED}Yes`),
    ).toBe(true);
    expect(
      quads.some(
        (q) => q.predicate.value === "http://purl.org/dc/elements/1.1/author" && q.object.value === BOB,
      ),
    ).toBe(true);
    expect(quads.some((q) => q.predicate.value === `${SCHED}results` && q.object.value === POLL_URL)).toBe(
      true,
    );

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

  it("rejects an UNPARSEABLE option BEFORE any write or notify (roborev Low)", async () => {
    // A bad option would make writeResponse emit no triples yet still PUT + notify
    // "success" — a silent no-op. respondToPoll must fail closed first.
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 })) as unknown as typeof fetch;
    await expect(
      respondToPoll(
        {
          pollUrl: POLL_URL,
          organizerWebId: CAROL,
          attendeeWebId: BOB,
          podRoot: ATTENDEE_POD,
          option: "not a date",
          response: "yes",
        },
        fetchImpl,
      ),
    ).rejects.toBeInstanceOf(RangeError);
    expect(fetchImpl).not.toHaveBeenCalled(); // nothing written, nothing notified
  });
});

describe("aggregatePollRsvps — organiser-side loop closure", () => {
  const POLL_URL = "https://carol.example/schedule/p1.ttl";
  const BOB_RESP = "https://bob.example/schedule-responses/rsvp-x.ttl";

  // A SolidOS-shaped response resource (sched:response→dc:author + sched:cell→
  // cal:dtstart + sched:availabilty), bound to a poll via sched:results.
  function rsvpTtl(opts: { subject: string; object: string; attendee: string; option: string }): string {
    return `
      @prefix sched: <${SCHED}> .
      @prefix cal: <${CAL}> .
      @prefix dc: <http://purl.org/dc/elements/1.1/> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      <${opts.subject}#resp-0> dc:author <${opts.attendee}> ;
        sched:results <${opts.object}> ;
        sched:cell <${opts.subject}#cell-0> .
      <${opts.subject}#cell-0> cal:dtstart "${opts.option}"^^xsd:dateTime ;
        sched:availabilty sched:Yes .`;
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

  it("drops an aggregated response for an OPTION the poll doesn't declare (roborev Medium)", async () => {
    // Bob's response is genuine + bound correctly, but votes for OPT_B which is NOT
    // a declared option of this poll — it must not mint a phantom tally row.
    const respTtl = rsvpTtl({ subject: BOB_RESP, object: POLL_URL, attendee: BOB, option: OPT_B });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
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
    expect(merged).toEqual([]); // OPT_B is off-list → rejected
    expect(tallyRsvps(poll.options, merged).some((t) => t.option === OPT_B)).toBe(false);
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

  it("drops a response whose sched:results binds a different poll", async () => {
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

  it("readRsvpResourceAt reads a BLANK-NODE sched:response (term not coerced to NamedNode)", async () => {
    // SolidOS commonly uses blank-node response/cell subjects. Passing q.subject.value
    // would coerce the blank node to a NamedNode and miss it (roborev finding).
    const blankTtl = `
      @prefix sched: <${SCHED}> .
      @prefix cal: <${CAL}> .
      @prefix dc: <http://purl.org/dc/elements/1.1/> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      [ dc:author <${BOB}> ; sched:results <${POLL_URL}> ;
        sched:cell [ cal:dtstart "${OPT_A}"^^xsd:dateTime ; sched:availabilty sched:Yes ] ] .`;
    const fetchImpl = vi.fn(async () =>
      new Response(blankTtl, { status: 200, headers: { "content-type": "text/turtle" } }),
    ) as unknown as typeof fetch;
    const got = await readRsvpResourceAt(BOB_RESP, POLL_URL, BOB, fetchImpl);
    expect(got).toEqual([{ attendee: BOB, option: OPT_A, response: "yes" }]);
  });

  it("readRsvpResourceAt reads a LEGACY schema:RsvpAction response with the SAME integrity binds", async () => {
    // A vote written by the PRE-interop build (schema:RsvpAction). Must still be
    // read after the organiser upgrades — and still bound to THIS poll BY the sender.
    const legacyTtl = (object: string, attendee: string) => `
      @prefix schema: <https://schema.org/> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      <${BOB_RESP}#it> a schema:RsvpAction ;
        schema:object <${object}> ;
        schema:attendee <${attendee}> ;
        schema:startDate "${OPT_A}"^^xsd:dateTime ;
        schema:rsvpResponse schema:RsvpResponseYes .`;
    const mk = (ttl: string) =>
      vi.fn(async () => new Response(ttl, { status: 200, headers: { "content-type": "text/turtle" } })) as unknown as typeof fetch;

    // Happy path: read the legacy vote.
    expect(await readRsvpResourceAt(BOB_RESP, POLL_URL, BOB, mk(legacyTtl(POLL_URL, BOB)))).toEqual([
      { attendee: BOB, option: OPT_A, response: "yes" },
    ]);
    // Integrity: a legacy action for a DIFFERENT poll is dropped.
    expect(
      await readRsvpResourceAt(BOB_RESP, POLL_URL, BOB, mk(legacyTtl("https://carol.example/schedule/OTHER.ttl", BOB))),
    ).toEqual([]);
    // Integrity: a legacy action claiming a DIFFERENT attendee is dropped.
    expect(await readRsvpResourceAt(BOB_RESP, POLL_URL, BOB, mk(legacyTtl(POLL_URL, CAROL)))).toEqual([]);
  });
});
