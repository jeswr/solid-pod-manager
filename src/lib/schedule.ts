// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Scheduling / RSVP (Feature 3) — propose an event poll with several time
 * OPTIONS, invite agents (cross-pod, via the SSRF-hardened `sendNotification`),
 * collect RSVP responses, and tally per option.
 *
 * The poll resource lives in the ORGANISER's own pod under `schedule/`, one
 * resource per poll, registered in the Type Index via the shared store engine
 * (so it surfaces under "My data"). Same-pod CRUD for the poll + responses; the
 * only cross-pod surface is inviting an attendee (an inbox notification, strict
 * validated).
 *
 * Vocab (schema.org, consistent with `calendar.ts`'s `schema:Event`):
 *   - poll          → `schema:Event` + `schema:name`, `schema:description`,
 *                     `schema:organizer` (WebID)
 *   - time options  → `schema:potentialAction`? No — we model candidate times as
 *                     repeated `schema:startDate` literals on the poll, each a
 *                     proposed option (xsd:dateTime). Simple + readable.
 *   - RSVP          → per attendee per option, stored as a plain shape and
 *                     tallied by a PURE function ({@link tallyRsvps}) using
 *                     `schema:RsvpResponseYes/No/Maybe` response values.
 *
 * Typed `@rdfjs/wrapper` accessors only — never hand-concat Turtle.
 */
import {
  LiteralAs,
  LiteralFrom,
  NamedNodeAs,
  NamedNodeFrom,
  OptionalAs,
  OptionalFrom,
  SetFrom,
  TermWrapper,
} from "@rdfjs/wrapper";
import { DataFactory, Store } from "n3";
import {
  createStore,
  type ProductivityStore,
  type StoredItem,
  type StoreConfig,
} from "./productivity-store.js";

const SCHEMA = "https://schema.org/";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** The RDF class a poll is stamped + registered with (shares the Calendar bucket). */
export const POLL_CLASS = `${SCHEMA}Event`;
/** Container slug under the pod root. */
export const SCHEDULE_SLUG = "schedule/";

const PREFIXES = { schema: SCHEMA } as const;

/** RSVP response values (schema.org enumeration tails). */
export type RsvpResponse = "yes" | "no" | "maybe";
const RSVP_IRI: Record<RsvpResponse, string> = {
  yes: `${SCHEMA}RsvpResponseYes`,
  no: `${SCHEMA}RsvpResponseNo`,
  maybe: `${SCHEMA}RsvpResponseMaybe`,
};
const RSVP_FROM_IRI: Record<string, RsvpResponse> = {
  [`${SCHEMA}RsvpResponseYes`]: "yes",
  [`${SCHEMA}RsvpResponseNo`]: "no",
  [`${SCHEMA}RsvpResponseMaybe`]: "maybe",
};

/** One person's RSVP to one time option. */
export interface Rsvp {
  /** Attendee WebID. */
  attendee: string;
  /** The option (proposed start time) this RSVP is for, as an ISO string. */
  option: string;
  /** Their response. */
  response: RsvpResponse;
}

/** A poll as the UI consumes it (plain, serialisable). */
export interface Poll {
  /** Title — `schema:name`. */
  name: string;
  /** Notes — `schema:description`. */
  description?: string;
  /** Organiser WebID — `schema:organizer`. */
  organizer?: string;
  /** Proposed time options (ISO strings) — repeated `schema:startDate`. */
  options: string[];
  /** Collected RSVPs (one per attendee per option). */
  rsvps: Rsvp[];
  /** Invited attendee WebIDs — `schema:invitee`. */
  invitees: string[];
}

/** Typed view of the poll subject. */
class PollDoc extends TermWrapper {
  get types(): Set<string> {
    return SetFrom.subjectPredicate(this, RDF_TYPE, NamedNodeAs.string, NamedNodeFrom.string);
  }
  mark(): this {
    this.types.add(POLL_CLASS);
    return this;
  }
  get name(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}name`, LiteralAs.string);
  }
  set name(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}name`, v, LiteralFrom.string);
  }
  get description(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}description`, LiteralAs.string);
  }
  set description(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}description`, v, LiteralFrom.string);
  }
  get organizer(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}organizer`, NamedNodeAs.string);
  }
  set organizer(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}organizer`, v, NamedNodeFrom.string);
  }
  /** Proposed start-time options as date literals. */
  get startDates(): Set<Date> {
    return SetFrom.subjectPredicate(this, `${SCHEMA}startDate`, LiteralAs.date, LiteralFrom.dateTime);
  }
  /** Invited attendee WebIDs. */
  get invitees(): Set<string> {
    return SetFrom.subjectPredicate(this, `${SCHEMA}invitee`, NamedNodeAs.string, NamedNodeFrom.string);
  }
}

/** True for an absolute http(s) WebID. */
function isWebId(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Parse a poll document (poll + its RSVP blank/aux subjects) into a {@link Poll}. */
export function parsePoll(
  itemUrl: string,
  dataset: import("@rdfjs/types").DatasetCore,
): Poll | undefined {
  const subject = `${itemUrl}#it`;
  const doc = new PollDoc(subject, dataset, DataFactory);
  if (!doc.types.has(POLL_CLASS)) return undefined;
  const options = [...doc.startDates].map((d) => d.toISOString()).sort();
  return {
    name: doc.name ?? "",
    description: doc.description,
    organizer: doc.organizer,
    options,
    invitees: [...doc.invitees],
    rsvps: readRsvps(subject, dataset),
  };
}

/** RSVPs are modelled as `schema:RsvpAction` subjects linked to the poll. */
const RSVP_ACTION = `${SCHEMA}RsvpAction`;

/** Typed view of one RSVP action subject. */
class RsvpDoc extends TermWrapper {
  get attendee(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}attendee`, NamedNodeAs.string);
  }
  get option(): Date | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}startDate`, LiteralAs.date);
  }
  get response(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}rsvpResponse`, NamedNodeAs.string);
  }
}

/** Read every RSVP action attached to the poll (by `schema:object` → poll). */
function readRsvps(
  pollSubject: string,
  dataset: import("@rdfjs/types").DatasetCore,
): Rsvp[] {
  const out: Rsvp[] = [];
  const seen = new Set<string>();
  for (const q of dataset.match(null, DataFactory.namedNode(RDF_TYPE), DataFactory.namedNode(RSVP_ACTION))) {
    const doc = new RsvpDoc(q.subject.value, dataset, DataFactory);
    const attendee = doc.attendee;
    const option = doc.option;
    const response = doc.response ? RSVP_FROM_IRI[doc.response] : undefined;
    if (!attendee || !option || !response) continue;
    const key = `${attendee}|${option.toISOString()}`;
    if (seen.has(key)) continue; // one RSVP per attendee per option (last wins on write)
    seen.add(key);
    out.push({ attendee, option: option.toISOString(), response });
  }
  void pollSubject;
  return out;
}

/**
 * Serialise a {@link Poll} into a fresh dataset rooted at `${itemUrl}#it`.
 * RSVP actions become `schema:RsvpAction` subjects (one per attendee+option),
 * each via typed accessors.
 */
export function buildPoll(itemUrl: string, poll: Poll): Store {
  const store = new Store();
  const subject = `${itemUrl}#it`;
  const doc = new PollDoc(subject, store, DataFactory).mark();
  doc.name = poll.name || undefined;
  doc.description = poll.description || undefined;
  doc.organizer = isWebId(poll.organizer) ? poll.organizer : undefined;
  const startDates = doc.startDates;
  for (const opt of poll.options) {
    const d = new Date(opt);
    if (!Number.isNaN(d.getTime())) startDates.add(d);
  }
  const invitees = doc.invitees;
  for (const inv of poll.invitees) if (isWebId(inv)) invitees.add(inv);

  // RSVP actions: one subject per (attendee, option), typed accessors only.
  let i = 0;
  for (const r of poll.rsvps) {
    if (!isWebId(r.attendee)) continue;
    const optDate = new Date(r.option);
    if (Number.isNaN(optDate.getTime())) continue;
    const rsvpSubject = `${itemUrl}#rsvp-${i++}`;
    const node = DataFactory.namedNode(rsvpSubject);
    store.add(DataFactory.quad(node, DataFactory.namedNode(RDF_TYPE), DataFactory.namedNode(RSVP_ACTION)));
    store.add(DataFactory.quad(node, DataFactory.namedNode(`${SCHEMA}object`), DataFactory.namedNode(subject)));
    store.add(
      DataFactory.quad(node, DataFactory.namedNode(`${SCHEMA}attendee`), DataFactory.namedNode(r.attendee)),
    );
    store.add(
      DataFactory.quad(
        node,
        DataFactory.namedNode(`${SCHEMA}startDate`),
        DataFactory.literal(optDate.toISOString(), DataFactory.namedNode("http://www.w3.org/2001/XMLSchema#dateTime")),
      ),
    );
    store.add(
      DataFactory.quad(node, DataFactory.namedNode(`${SCHEMA}rsvpResponse`), DataFactory.namedNode(RSVP_IRI[r.response])),
    );
  }
  return store;
}

/** Per-option RSVP tally. */
export interface OptionTally {
  option: string;
  yes: number;
  no: number;
  maybe: number;
}

/**
 * Tally RSVPs per option (PURE — unit-testable). Counts each (attendee, option)
 * once using the LATEST response for that pair (last in array wins), so a
 * changed vote does not double-count. Options come from the poll so an option
 * with no responses still appears with zeroes.
 */
export function tallyRsvps(options: readonly string[], rsvps: readonly Rsvp[]): OptionTally[] {
  // Collapse to one response per (attendee, option): last wins.
  const latest = new Map<string, Rsvp>();
  for (const r of rsvps) latest.set(`${r.attendee}|${r.option}`, r);

  const byOption = new Map<string, OptionTally>();
  for (const option of options) byOption.set(option, { option, yes: 0, no: 0, maybe: 0 });

  for (const r of latest.values()) {
    let t = byOption.get(r.option);
    if (!t) {
      t = { option: r.option, yes: 0, no: 0, maybe: 0 };
      byOption.set(r.option, t);
    }
    t[r.response] += 1;
  }
  return [...byOption.values()].sort((a, b) => a.option.localeCompare(b.option));
}

/** The option with the most "yes" votes (ties broken by fewest "no", then time). */
export function winningOption(tallies: readonly OptionTally[]): OptionTally | undefined {
  if (tallies.length === 0) return undefined;
  return [...tallies].sort((a, b) => {
    if (b.yes !== a.yes) return b.yes - a.yes;
    if (a.no !== b.no) return a.no - b.no;
    return a.option.localeCompare(b.option);
  })[0];
}

/** The store config — wires the typed parse/build into the shared CRUD. */
export const SCHEDULE_CONFIG: StoreConfig<Poll> = {
  containerSlug: SCHEDULE_SLUG,
  forClass: POLL_CLASS,
  prefixes: PREFIXES,
  parse: parsePoll,
  build: buildPoll,
};

/** Build a Schedule store bound to the active pod + WebID. */
export function scheduleStore(opts: {
  podRoot: string;
  webId: string;
  fetchImpl?: typeof fetch;
}): ProductivityStore<Poll> {
  return createStore(SCHEDULE_CONFIG, opts);
}

/** Re-export for the list UI. */
export type PollItem = StoredItem<Poll>;
