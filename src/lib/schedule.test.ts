// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
import { describe, it, expect } from "vitest";
import {
  buildPoll,
  parsePoll,
  tallyRsvps,
  winningOption,
  POLL_CLASS,
  type Poll,
  type Rsvp,
} from "./schedule.js";

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
});
