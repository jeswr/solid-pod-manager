// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Scheduling / RSVP (Feature 3) — propose an event poll with several time
 * OPTIONS, invite agents (cross-pod, via the SSRF-hardened `sendNotification`),
 * collect RSVP responses, and tally per option.
 *
 * INTEROP (PM #94 / G3). PM reads AND writes the STANDARD SolidOS `sched:` poll
 * shape (`http://www.w3.org/ns/pim/schedule#`) so a poll created in PM opens in
 * SolidOS's schedule pane and vice-versa. The shape is verified against (a) the
 * W3C ns doc `http://www.w3.org/ns/pim/schedule#` and (b) SolidOS
 * `solid-panes/src/schedule/schedulePane.ts` + its fixture
 * `test/unit/meeting/Schedule/details.ttl`:
 *
 *   <#it> a sched:SchedulableEvent ;
 *     cal:summary "<title>" ; cal:comment "<desc>" ; dc:author <organiserWebID> ;
 *     sched:availabilityOptions sched:YesNoMaybe ;
 *     sched:ready "<xsd:dateTime>" ;            # when the poll was published
 *     sched:invitee <inviteeWebID> ;            # repeated
 *     sched:results <#it's own doc> ;           # responses are in-document
 *     sched:option <#opt-N> ;                   # repeated; one per proposed time
 *     sched:response <#resp-N> .                # repeated; one per attendee vote
 *   <#opt-N>  cal:dtstart "<datetime>" .
 *   <#resp-N> dc:author <attendeeWebID> ; sched:cell <#cell-N> .
 *   <#cell-N> cal:dtstart "<datetime matching an option>" ;
 *             sched:availabilty sched:Yes|sched:Maybe|sched:No .
 *
 * CRITICAL SPELLING (load-bearing for interop): the running SolidOS pane READS
 * AND WRITES the availability predicate as `sched:availabilty` — MISSPELLED, see
 * `solid-panes/src/schedule/schedulePane.ts` lines 1174 & 1280 — NOT the
 * `sched:availibility` in the W3C ns doc. To interoperate with the LIVE pane PM
 * WRITES `sched:availabilty`; when READING it accepts `sched:availabilty`
 * (primary) and tolerates `sched:availibility` + `sched:response`-as-value as
 * fallback aliases for robustness.
 *
 * RESULTS DOCUMENT. SolidOS stores responses in a SEPARATE results doc linked
 * by `sched:results`. PM keeps its simpler single-resource model (everything in
 * the organiser-owned poll resource) but emits `sched:results <pollUrl>`
 * (self-referential) AND the `sched:response`/`sched:cell` blocks INLINE — so a
 * SolidOS that reads `kb.each(invitation, sched:response)` over its in-memory
 * store finds them regardless of which document the triples came from.
 *
 * COLLABORATION MODEL (security-critical, UNCHANGED). Every WRITE is SAME-POD:
 *   - The ORGANISER owns the poll resource in their own pod under `schedule/`
 *     (Type-Index registered via the shared store engine). Same-pod CRUD.
 *   - An INVITEE never writes to the organiser's pod. They (a) READ the
 *     organiser's poll read-only — validated via `agent-target`'s
 *     `assertValidTargetUrl` + redirect-no-follow so the auth-patched fetch is
 *     never steered to a private host — and (b) record their own RSVP in THEIR
 *     OWN pod, then NOTIFY the organiser via the SSRF-hardened
 *     `sendNotification`. The organiser aggregates received RSVPs into the tally.
 * So the only cross-pod surfaces are: the Invite notification, a validated
 * read-only GET of the organiser's poll, and the RSVP-back notification.
 *
 * Typed `@rdfjs/wrapper` accessors only — never hand-concat Turtle / inline
 * `DataFactory.quad`.
 */
import {
  LiteralAs,
  LiteralFrom,
  NamedNodeAs,
  NamedNodeFrom,
  OptionalAs,
  OptionalFrom,
  SetFrom,
  TermAs,
  TermWrapper,
} from "@rdfjs/wrapper";
import { DataFactory, Store } from "n3";
import { RdfFetchError } from "@jeswr/fetch-rdf";
import { freshRdf } from "./rdf-read.js";
import { assertValidTargetUrl, isValidTargetUrl, noFollowFetch } from "./agent-target.js";
import { sendNotification } from "./notify-send.js";
import { writeResource } from "./pod-data.js";
import { readProfile } from "./profile.js";
import { profileDocUrl } from "./profile-edit.js";
import { isInOwnPods } from "./pod-scope.js";
import {
  createStore,
  type ProductivityStore,
  type StoredItem,
  type StoreConfig,
} from "./productivity-store.js";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

// ── Interop vocabularies (primary-source verified — see file header). ───────
/** Personal Information Model schedule vocab — the SolidOS poll shape. */
const SCHED = "http://www.w3.org/ns/pim/schedule#";
/** iCalendar-in-RDF — summary/comment/location/dtstart. */
const CAL = "http://www.w3.org/2002/12/cal/ical#";
/** Dublin Core (elements) — `dc:author`, as SolidOS uses on poll + responses. */
const DC = "http://purl.org/dc/elements/1.1/";
/** FOAF — invitee nodes (`foaf:agent`/`foaf:mbox`) when not a direct WebID. */
const FOAF = "http://xmlns.com/foaf/0.1/";
/**
 * schema.org — the LEGACY poll shape PM wrote BEFORE this `sched:` interop
 * change (`schema:Event` + repeated `schema:startDate` options + `schema:RsvpAction`
 * subjects). Read-only: {@link parsePoll} falls back to it so polls created by the
 * old build still open + list after upgrade (they re-serialise to `sched:` on the
 * next save). PM never WRITES this shape any more.
 */
const SCHEMA = "https://schema.org/";

/** The RDF class a poll is stamped + registered with (the SolidOS poll class). */
export const POLL_CLASS = `${SCHED}SchedulableEvent`;
/** Container slug under the pod root. */
export const SCHEDULE_SLUG = "schedule/";

const PREFIXES = { sched: SCHED, cal: CAL, dc: DC, foaf: FOAF } as const;

/** The fixed `sched:availabilityOptions` value for a yes/no/maybe poll. */
const AVAILABILITY_OPTIONS = `${SCHED}YesNoMaybe`;

/** RSVP response values (mapped to/from the `sched:Yes|Maybe|No` IRIs). */
export type RsvpResponse = "yes" | "no" | "maybe";
const RSVP_IRI: Record<RsvpResponse, string> = {
  yes: `${SCHED}Yes`,
  no: `${SCHED}No`,
  maybe: `${SCHED}Maybe`,
};
const RSVP_FROM_IRI: Record<string, RsvpResponse> = {
  [`${SCHED}Yes`]: "yes",
  [`${SCHED}No`]: "no",
  [`${SCHED}Maybe`]: "maybe",
};

/**
 * The availability predicate, by precedence. The LIVE SolidOS pane reads+writes
 * the MISSPELLED `sched:availabilty` (schedulePane.ts L1174 & L1280) — we WRITE
 * that one for interop and ACCEPT it first when reading; the W3C-ns-doc
 * `availibility` + the (older) `sched:response`-as-value are tolerated as read
 * fallbacks only. NEVER reorder: `availabilty` must stay the write + primary-read
 * term or PM's polls stop opening in the running pane.
 */
const AVAILABILTY_PRED = `${SCHED}availabilty`; // SolidOS spelling — load-bearing
const AVAILABILITY_READ_ALIASES = [
  AVAILABILTY_PRED,
  `${SCHED}availibility`, // the W3C ns-doc spelling (read tolerance)
  `${SCHED}response`, // legacy: response value carried directly on the cell
] as const;

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
  /** Title — `cal:summary`. */
  name: string;
  /** Notes — `cal:comment`. */
  description?: string;
  /** Organiser WebID — `dc:author`. */
  organizer?: string;
  /** Proposed time options (ISO strings) — `sched:option`→`cal:dtstart`. */
  options: string[];
  /** Collected RSVPs (one per attendee per option). */
  rsvps: Rsvp[];
  /** Invited attendee WebIDs — `sched:invitee`. */
  invitees: string[];
}

/**
 * Parse a literal term's lexical value to a Date LENIENTLY, regardless of
 * datatype. The SolidOS fixture carries date-only `cal:dtstart "2016-06-23"`
 * literals (typed `xsd:string` once parsed), which the strict `LiteralAs.date`
 * REJECTS (it only accepts `xsd:date`/`xsd:dateTime`). So we read the raw value
 * via `LiteralAs.string` (datatype-agnostic) and parse it ourselves. Returns
 * `undefined` for an unparseable value.
 */
function lenientDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Normalise any datetime-ish string to a canonical ISO string (join key). */
function normaliseIso(value: string | undefined): string | undefined {
  return lenientDate(value)?.toISOString();
}

/**
 * Find the subject TERM of `classIri` in `dataset`, PREFERRING `${itemUrl}#it`
 * (PM's own minted subject) when it is one, else the first matching subject.
 *
 * Why discover rather than assume `#it` (roborev Medium): a FOREIGN SolidOS poll
 * mints its own event subject (`<#event>`, `<#id1467…>`), not `#it`, so a
 * hard-coded `${itemUrl}#it` would fail to parse it. Preferring `#it` keeps PM's
 * own same-pod store contract (subject is always `#it`, written back by the
 * store) deterministic, while still reading any foreign subject. Returns the
 * RDF/JS term (NamedNode/BlankNode — blank-node safe) or `undefined`.
 */
function findSubjectOfClass(
  itemUrl: string,
  classIri: string,
  dataset: import("@rdfjs/types").DatasetCore,
): import("@rdfjs/types").Term | undefined {
  const preferred = `${itemUrl}#it`;
  let first: import("@rdfjs/types").Term | undefined;
  for (const q of dataset.match(
    null,
    DataFactory.namedNode(RDF_TYPE),
    DataFactory.namedNode(classIri),
  )) {
    if (q.subject.termType === "NamedNode" && q.subject.value === preferred) return q.subject;
    if (!first) first = q.subject;
  }
  return first;
}

/** One `sched:option` node — a proposed time (`cal:dtstart`). */
class OptionDoc extends TermWrapper {
  /** Raw `cal:dtstart` lexical value (datatype-agnostic; lenient parse later). */
  get dtstartRaw(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${CAL}dtstart`, LiteralAs.string);
  }
  set dtstart(v: Date | undefined) {
    OptionalAs.object(this, `${CAL}dtstart`, v, LiteralFrom.dateTime);
  }
}

/** One `sched:cell` node — a (time, availability) pair within a response. */
class CellDoc extends TermWrapper {
  get dtstartRaw(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${CAL}dtstart`, LiteralAs.string);
  }
  set dtstart(v: Date | undefined) {
    OptionalAs.object(this, `${CAL}dtstart`, v, LiteralFrom.dateTime);
  }
  /**
   * The cell's availability IRI, accepting SolidOS's misspelled `availabilty`
   * first, then the ns-doc `availibility`, then a legacy `sched:response` value.
   */
  get availability(): string | undefined {
    for (const pred of AVAILABILITY_READ_ALIASES) {
      const v = OptionalFrom.subjectPredicate(this, pred, NamedNodeAs.string);
      if (v) return v;
    }
    return undefined;
  }
  set availability(v: string | undefined) {
    // WRITE the SolidOS spelling so the live pane reads our cells.
    OptionalAs.object(this, AVAILABILTY_PRED, v, NamedNodeFrom.string);
  }
}

/** One `sched:response` node — one attendee's vote set (cells). */
class ResponseDoc extends TermWrapper {
  get author(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${DC}author`, NamedNodeAs.string);
  }
  set author(v: string | undefined) {
    OptionalAs.object(this, `${DC}author`, v, NamedNodeFrom.string);
  }
  /** The cells (time/availability pairs) of this response. */
  get cells(): Set<CellDoc> {
    return SetFrom.subjectPredicate(this, `${SCHED}cell`, TermAs.instance(CellDoc), TermAs.term);
  }
  /** The poll this response is bound to (`sched:results`/back-link — see notes). */
  get forPoll(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHED}results`, NamedNodeAs.string);
  }
  set forPoll(v: string | undefined) {
    OptionalAs.object(this, `${SCHED}results`, v, NamedNodeFrom.string);
  }
}

/** Typed view of the poll subject (`sched:SchedulableEvent`). */
class PollDoc extends TermWrapper {
  get types(): Set<string> {
    return SetFrom.subjectPredicate(this, RDF_TYPE, NamedNodeAs.string, NamedNodeFrom.string);
  }
  mark(): this {
    this.types.add(POLL_CLASS);
    return this;
  }
  get name(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${CAL}summary`, LiteralAs.string);
  }
  set name(v: string | undefined) {
    OptionalAs.object(this, `${CAL}summary`, v, LiteralFrom.string);
  }
  get description(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${CAL}comment`, LiteralAs.string);
  }
  set description(v: string | undefined) {
    OptionalAs.object(this, `${CAL}comment`, v, LiteralFrom.string);
  }
  get organizer(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${DC}author`, NamedNodeAs.string);
  }
  set organizer(v: string | undefined) {
    OptionalAs.object(this, `${DC}author`, v, NamedNodeFrom.string);
  }
  /** `sched:availabilityOptions` — fixed to `sched:YesNoMaybe`. */
  set availabilityOptions(v: string | undefined) {
    OptionalAs.object(this, `${SCHED}availabilityOptions`, v, NamedNodeFrom.string);
  }
  /** `sched:ready` — when the poll was published (xsd:dateTime). */
  set ready(v: Date | undefined) {
    OptionalAs.object(this, `${SCHED}ready`, v, LiteralFrom.dateTime);
  }
  /** `sched:results` — the doc holding responses (self-referential for PM, but a
   *  SolidOS-authored poll may point at a SEPARATE results document). */
  get results(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHED}results`, NamedNodeAs.string);
  }
  set results(v: string | undefined) {
    OptionalAs.object(this, `${SCHED}results`, v, NamedNodeFrom.string);
  }
  /** Invited attendee WebIDs as DIRECT `sched:invitee` named-node links. */
  get inviteeLinks(): Set<string> {
    return SetFrom.subjectPredicate(this, `${SCHED}invitee`, NamedNodeAs.string, NamedNodeFrom.string);
  }
  /** Invitee NODES (for the SolidOS `foaf:agent`/`foaf:mbox` shape). */
  get inviteeNodes(): Set<TermWrapper> {
    return SetFrom.subjectPredicate(this, `${SCHED}invitee`, TermAs.is, TermAs.term);
  }
  /** Invitee nodes typed as {@link InviteeDoc}, for WRITING the mailto form. */
  get inviteeDocNodes(): Set<InviteeDoc> {
    return SetFrom.subjectPredicate(this, `${SCHED}invitee`, TermAs.instance(InviteeDoc), TermAs.term);
  }
  /** Proposed-time option nodes (`sched:option`). */
  get optionNodes(): Set<OptionDoc> {
    return SetFrom.subjectPredicate(this, `${SCHED}option`, TermAs.instance(OptionDoc), TermAs.term);
  }
  /** Response nodes (`sched:response`) — one per attendee vote. */
  get responseNodes(): Set<ResponseDoc> {
    return SetFrom.subjectPredicate(this, `${SCHED}response`, TermAs.instance(ResponseDoc), TermAs.term);
  }
}

/** One invitee node carrying the SolidOS `foaf:agent`/`foaf:mbox` shape. */
class InviteeDoc extends TermWrapper {
  /** A WebID via `foaf:agent` (PM's node form) — if present. */
  get agent(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${FOAF}agent`, NamedNodeAs.string);
  }
  /** A `foaf:mbox` (mailto:) — SolidOS's invitee form; surfaced as the id. */
  get mbox(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${FOAF}mbox`, NamedNodeAs.string);
  }
  set mbox(v: string | undefined) {
    OptionalAs.object(this, `${FOAF}mbox`, v, NamedNodeFrom.string);
  }
}

/** True for a `mailto:` IRI (the SolidOS `foaf:mbox` invitee form). */
function isMailto(value: string | undefined): boolean {
  return !!value && value.toLowerCase().startsWith("mailto:");
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

/**
 * Resolve an invitee `sched:invitee` object to an id string, accepting BOTH a
 * direct WebID NamedNode (PM's form) AND an invitee node carrying
 * `foaf:agent`/`foaf:mbox` (SolidOS's form). Returns the WebID/mbox or
 * `undefined` when neither is present.
 */
function inviteeId(node: TermWrapper, dataset: import("@rdfjs/types").DatasetCore): string | undefined {
  // An invitee NODE (named or blank) carrying the SolidOS foaf:agent/foaf:mbox
  // shape takes precedence — the node's own IRI is an internal anchor, not the
  // person. (A blank node, or a named node that has its own foaf:* properties.)
  const inv = new InviteeDoc(node as unknown as import("@rdfjs/types").Term, dataset, DataFactory);
  const fromNode = inv.agent ?? inv.mbox;
  if (fromNode) return fromNode;
  // Otherwise PM's direct form: the `sched:invitee` object IS the WebID.
  if (node.termType === "NamedNode" && isWebId(node.value)) return node.value;
  return undefined;
}

/**
 * Read every response node in the poll dataset into flat {@link Rsvp}s, keyed by
 * `dc:author` (attendee) + each cell's normalised `cal:dtstart`, collapsing
 * duplicate `(attendee, option)` pairs LAST-WINS (consistent with
 * {@link tallyRsvps}). Pure over the parsed dataset.
 */
function readResponses(doc: PollDoc): Rsvp[] {
  const byKey = new Map<string, Rsvp>();
  for (const resp of doc.responseNodes) {
    const attendee = resp.author;
    if (!attendee) continue;
    for (const cell of resp.cells) {
      const iso = normaliseIso(cell.dtstartRaw);
      const avail = cell.availability;
      const response = avail ? RSVP_FROM_IRI[avail] : undefined;
      if (!iso || !response) continue;
      byKey.set(`${attendee}|${iso}`, { attendee, option: iso, response }); // last wins
    }
  }
  return [...byKey.values()];
}

/**
 * Parse a poll document (the SolidOS `sched:SchedulableEvent` shape) into a
 * {@link Poll}. Returns `undefined` if the document holds no such subject.
 *
 * Options come from `sched:option`→`cal:dtstart` (normalised to ISO so they
 * join with response cells even across serialisers / date-only literals);
 * invitees from `sched:invitee` (direct WebID or `foaf:agent`/`foaf:mbox`
 * node); responses from `sched:response`→(`dc:author`, `sched:cell`).
 */
export function parsePoll(
  itemUrl: string,
  dataset: import("@rdfjs/types").DatasetCore,
): Poll | undefined {
  // DISCOVER the poll subject (roborev Medium): PM's own polls use `${itemUrl}#it`,
  // but a foreign SolidOS poll mints its own subject (e.g. `<#event>`). Prefer
  // `#it`, fall back to the first `sched:SchedulableEvent`.
  const subjectTerm = findSubjectOfClass(itemUrl, POLL_CLASS, dataset);
  if (!subjectTerm) {
    // BACKWARDS-COMPAT (roborev Medium): a poll created by the PRE-interop build
    // is a `schema:Event`, not a `sched:SchedulableEvent`. Without this fallback
    // `list()` would silently drop every already-created poll after upgrade. Read
    // the legacy shape so it still opens; the next save re-serialises it to
    // `sched:`. Returns `undefined` only when the doc is neither shape.
    return parseLegacyPoll(itemUrl, dataset);
  }
  const doc = new PollDoc(subjectTerm, dataset, DataFactory);

  const options = [...doc.optionNodes]
    .map((o) => normaliseIso(o.dtstartRaw))
    .filter((s): s is string => Boolean(s));
  // De-dupe + sort so the list is stable regardless of node order.
  const uniqueOptions = [...new Set(options)].sort();

  const invitees: string[] = [];
  for (const node of doc.inviteeNodes) {
    const id = inviteeId(node, dataset);
    if (id) invitees.push(id);
  }

  return {
    name: doc.name ?? "",
    description: doc.description,
    organizer: doc.organizer,
    options: uniqueOptions,
    invitees: [...new Set(invitees)],
    rsvps: readResponses(doc),
  };
}

// ── Legacy (pre-interop) schema.org read path ───────────────────────────────

/** The legacy poll class + RSVP class PM used before the `sched:` switch. */
const LEGACY_POLL_CLASS = `${SCHEMA}Event`;
const LEGACY_RSVP_ACTION = `${SCHEMA}RsvpAction`;
const LEGACY_RSVP_FROM_IRI: Record<string, RsvpResponse> = {
  [`${SCHEMA}RsvpResponseYes`]: "yes",
  [`${SCHEMA}RsvpResponseNo`]: "no",
  [`${SCHEMA}RsvpResponseMaybe`]: "maybe",
};

/** Typed view of the legacy `schema:Event` poll subject (read-only). */
class LegacyPollDoc extends TermWrapper {
  get types(): Set<string> {
    return SetFrom.subjectPredicate(this, RDF_TYPE, NamedNodeAs.string, NamedNodeFrom.string);
  }
  get name(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}name`, LiteralAs.string);
  }
  get description(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}description`, LiteralAs.string);
  }
  get organizer(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}organizer`, NamedNodeAs.string);
  }
  /** Proposed start-time options as repeated `schema:startDate` literals. */
  get startDatesRaw(): Set<string> {
    return SetFrom.subjectPredicate(this, `${SCHEMA}startDate`, LiteralAs.string, LiteralFrom.string);
  }
  get invitees(): Set<string> {
    return SetFrom.subjectPredicate(this, `${SCHEMA}invitee`, NamedNodeAs.string, NamedNodeFrom.string);
  }
}

/** Typed view of one legacy `schema:RsvpAction` subject (read-only). */
class LegacyRsvpDoc extends TermWrapper {
  get attendee(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}attendee`, NamedNodeAs.string);
  }
  get optionRaw(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}startDate`, LiteralAs.string);
  }
  get response(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}rsvpResponse`, NamedNodeAs.string);
  }
  /** The poll this legacy action is bound to (`schema:object`). */
  get forPoll(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}object`, NamedNodeAs.string);
  }
}

/**
 * Read the LEGACY `schema:Event` poll shape PM wrote before this change. Returns
 * `undefined` when the document is not a legacy poll either (so a stray file is
 * skipped). Typed accessors only. The next save re-serialises to `sched:`.
 */
function parseLegacyPoll(
  itemUrl: string,
  dataset: import("@rdfjs/types").DatasetCore,
): Poll | undefined {
  // Discover the legacy `schema:Event` subject (prefer `#it`), same rationale as
  // parsePoll — though PM's own legacy polls always used `#it`.
  const subjectTerm = findSubjectOfClass(itemUrl, LEGACY_POLL_CLASS, dataset);
  if (!subjectTerm) return undefined;
  const doc = new LegacyPollDoc(subjectTerm, dataset, DataFactory);

  const options = [...doc.startDatesRaw]
    .map((s) => normaliseIso(s))
    .filter((s): s is string => Boolean(s));

  // The poll IRIs a legacy RsvpAction may bind to via `schema:object`: PM wrote
  // the poll RESOURCE URL, but tolerate the `#it` subject form too.
  const pollIris = new Set([itemUrl, `${itemUrl}#it`, subjectTerm.value]);
  // Collapse duplicate `(attendee, option)` pairs LAST-WINS, matching
  // `readResponses`/`tallyRsvps` (roborev Low) so the UI-selected response and the
  // tally agree even before the poll is re-saved to the `sched:` shape.
  const byKey = new Map<string, Rsvp>();
  for (const q of dataset.match(
    null,
    DataFactory.namedNode(RDF_TYPE),
    DataFactory.namedNode(LEGACY_RSVP_ACTION),
  )) {
    // Pass the TERM (blank-node safe), not `.value` — see readRsvpResourceAt.
    const r = new LegacyRsvpDoc(q.subject, dataset, DataFactory);
    const attendee = r.attendee;
    const option = normaliseIso(r.optionRaw);
    const response = r.response ? LEGACY_RSVP_FROM_IRI[r.response] : undefined;
    // Bind to THIS poll (roborev Low): an unrelated RsvpAction in the same
    // resource (different `schema:object`) must not leak into this tally. A
    // legacy action with NO `schema:object` is accepted (PM's own in-doc votes
    // sometimes omitted it and there's only ever one poll per resource).
    if (r.forPoll && !pollIris.has(r.forPoll)) continue;
    if (!attendee || !option || !response) continue;
    byKey.set(`${attendee}|${option}`, { attendee, option, response }); // last wins
  }

  return {
    name: doc.name ?? "",
    description: doc.description,
    organizer: doc.organizer,
    options: [...new Set(options)].sort(),
    invitees: [...doc.invitees],
    rsvps: [...byKey.values()],
  };
}

/**
 * Write one response block (`sched:response`→`dc:author` + `sched:cell`→
 * `cal:dtstart`+`sched:availabilty`) into `store`, linked from `pollSubject`,
 * via typed accessors only. Centralises the response shape used by both
 * {@link buildPoll} (the organiser's aggregated copy) and {@link respondToPoll}
 * (the invitee's own-pod response). `idx` makes the node IRIs unique+stable.
 */
function writeResponse(
  store: Store,
  baseUrl: string,
  pollSubject: string,
  pollBinding: string,
  idx: number,
  rsvp: Rsvp,
): void {
  const optDate = lenientDate(rsvp.option);
  if (!optDate) return;
  const pollDoc = new PollDoc(pollSubject, store, DataFactory);
  const respSubject = `${baseUrl}#resp-${idx}`;
  const cellSubject = `${baseUrl}#cell-${idx}`;
  pollDoc.responseNodes.add(new ResponseDoc(respSubject, store, DataFactory));

  const resp = new ResponseDoc(respSubject, store, DataFactory);
  resp.author = rsvp.attendee;
  // Bind the response to THIS poll for organiser-side integrity re-derivation.
  // The binding is the poll RESOURCE URL (matching `doc.results` and the
  // `expectedPoll` checked in `readRsvpResourceAt`), NEVER the `#it` subject —
  // both the inline (buildPoll) and own-pod (respondToPoll) paths must agree, or
  // the cross-pod aggregation binding check (`forPoll === expectedPoll`) drops it.
  resp.forPoll = pollBinding;
  resp.cells.add(new CellDoc(cellSubject, store, DataFactory));

  const cell = new CellDoc(cellSubject, store, DataFactory);
  cell.dtstart = optDate;
  cell.availability = RSVP_IRI[rsvp.response];
}

/**
 * Serialise a {@link Poll} into a fresh dataset rooted at `${itemUrl}#it`, in
 * the SolidOS `sched:` shape. Options become `sched:option` nodes with
 * `cal:dtstart`; RSVPs become `sched:response`→`sched:cell` blocks (one cell per
 * vote). Emits `sched:availabilityOptions`, `sched:ready` (now), and a
 * self-referential `sched:results <pollUrl>` so a results-doc-insisting reader
 * still finds the in-document responses. Typed accessors only.
 */
export function buildPoll(itemUrl: string, poll: Poll): Store {
  const store = new Store();
  const subject = `${itemUrl}#it`;
  const doc = new PollDoc(subject, store, DataFactory).mark();
  doc.name = poll.name || undefined;
  doc.description = poll.description || undefined;
  doc.organizer = isWebId(poll.organizer) ? poll.organizer : undefined;
  doc.availabilityOptions = AVAILABILITY_OPTIONS;
  doc.ready = new Date();
  doc.results = itemUrl; // self-referential: responses live in THIS document

  // Time options — one `sched:option` node per distinct, parseable time.
  const optionLinks = doc.optionNodes;
  let oi = 0;
  const seenOpt = new Set<string>();
  for (const opt of poll.options) {
    const d = lenientDate(opt);
    if (!d) continue;
    const iso = d.toISOString();
    if (seenOpt.has(iso)) continue;
    seenOpt.add(iso);
    const optSubject = `${itemUrl}#opt-${oi++}`;
    optionLinks.add(new OptionDoc(optSubject, store, DataFactory));
    const optDoc = new OptionDoc(optSubject, store, DataFactory);
    optDoc.dtstart = d;
  }

  // Invitees — WebIDs as direct `sched:invitee <webid>` links (PM's clean form);
  // mailto: invitees (parsed from a SolidOS poll's `foaf:mbox` nodes) round-trip
  // back as `sched:invitee [ foaf:mbox <mailto:…> ]` nodes so they aren't dropped
  // on save (roborev Medium).
  const inviteeLinks = doc.inviteeLinks;
  let mi = 0;
  for (const inv of poll.invitees) {
    if (isWebId(inv)) {
      inviteeLinks.add(inv);
    } else if (isMailto(inv)) {
      const node = new InviteeDoc(`${itemUrl}#inv-${mi++}`, store, DataFactory);
      node.mbox = inv;
      doc.inviteeDocNodes.add(node);
    }
  }

  // Responses — `sched:response`→`sched:cell` blocks, one cell per vote.
  let ri = 0;
  for (const r of poll.rsvps) {
    if (!isWebId(r.attendee)) continue;
    if (!lenientDate(r.option)) continue;
    // subject = the poll `#it` subject (for the `sched:response` link);
    // binding = the poll RESOURCE URL (the `sched:results` value, matching
    // `doc.results` above and the cross-pod `expectedPoll` check).
    writeResponse(store, itemUrl, subject, itemUrl, ri++, r);
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

/**
 * Merge `extra` RSVPs into `base`, last-wins per (attendee, option), DROPPING any
 * `extra` whose option is not one of the poll's declared `options`. Used wherever
 * UNTRUSTED RSVPs (a separate `sched:results` doc, cross-pod aggregation) are
 * folded into a poll so a forged/foreign datetime can't mint a phantom tally row
 * (roborev Medium). `base` (the organiser's own poll rsvps) is kept as-is.
 */
export function mergeRsvpsWithinOptions(
  base: readonly Rsvp[],
  extra: readonly Rsvp[],
  options: readonly string[],
): Rsvp[] {
  const allowed = new Set(options.map((o) => normaliseIso(o)).filter(Boolean));
  const byKey = new Map<string, Rsvp>();
  for (const r of base) byKey.set(`${r.attendee}|${r.option}`, r);
  for (const r of extra) {
    if (!allowed.has(normaliseIso(r.option))) continue; // off-list → reject
    byKey.set(`${r.attendee}|${r.option}`, r);
  }
  return [...byKey.values()];
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

// ── Cross-pod respond path (invitee side) ──────────────────────────────────

/** Container in the INVITEE's own pod where their RSVP responses are stored. */
export const RESPONSES_SLUG = "schedule-responses/";

/**
 * Read a poll that lives in ANOTHER agent's pod (the organiser's), read-only.
 *
 * SECURITY: the poll URL arrives via an Invite notification's `as:object`, so it
 * is attacker-influenceable. Before fetching it with the auth-patched global
 * `fetch` we run it through the SAME strict validator the POST path uses
 * (`assertValidTargetUrl`: https-only, no userinfo, no loopback/private/metadata
 * host) and force `redirect: "manual"` (via `noFollowFetch`) so a 401/redirect
 * can't steer our token to a private host. Returns the parsed {@link Poll}.
 *
 * @throws InvalidTargetError when the poll URL is not a safe target.
 */
export async function readPollAt(
  pollUrl: string,
  fetchImpl?: typeof fetch,
): Promise<Poll | undefined> {
  assertValidTargetUrl(pollUrl); // fail closed before any authenticated GET
  const guarded = noFollowFetch(fetchImpl);
  const { dataset } = await freshRdf(pollUrl, guarded);
  const poll = parsePoll(pollUrl, dataset);
  if (!poll) return undefined;

  // Merge any responses in a SEPARATE `sched:results` document (see
  // {@link readLinkedResultsResponses}). Re-uses the already-fetched poll dataset
  // so we don't GET the poll twice on the foreign-read path. Off-list options in
  // that (untrusted) doc are dropped (roborev Medium).
  const extra = await readLinkedResultsResponses(pollUrl, fetchImpl, dataset);
  if (extra.length === 0) return poll;
  return { ...poll, rsvps: mergeRsvpsWithinOptions(poll.rsvps, extra, poll.options) };
}

/**
 * Read the responses held in a poll's SEPARATE `sched:results` document, if it
 * links one that DIFFERS from the poll resource itself.
 *
 * SolidOS stores RSVPs in a distinct `results.ttl` linked by `sched:results`; PM's
 * own polls are self-referential (responses inline, `sched:results <pollUrl>`), so
 * for a PM-authored poll this is a no-op (returns `[]`). It fires for a SolidOS-
 * authored poll — whether read cross-pod ({@link readPollAt}) OR sitting in the
 * user's OWN pod and read through the store (the organiser detail path merges the
 * result so the tally isn't silently empty — roborev Medium).
 *
 * SECURITY: the `sched:results` URL comes from the fetched poll document and is
 * therefore attacker-influenceable, so it goes through the SAME SSRF guard as
 * every cross-pod read — `isValidTargetUrl` + `noFollowFetch` (redirect:manual) —
 * before any authenticated GET. Best-effort: a missing/unreadable/unsafe results
 * doc yields `[]`, never throws, so it can't sink the poll read.
 *
 * @param pollDataset - the already-fetched poll dataset, to avoid a second GET of
 *   the poll document; omitted ⇒ this fetches the poll doc itself (SSRF-guarded).
 */
export async function readLinkedResultsResponses(
  pollUrl: string,
  fetchImplOrOptions?: typeof fetch | InspectLinkedResultsOptions,
  pollDataset?: import("@rdfjs/types").DatasetCore,
): Promise<Rsvp[]> {
  return (await inspectLinkedResults(pollUrl, fetchImplOrOptions, pollDataset)).responses;
}

/**
 * The outcome of inspecting a poll's `sched:results` link:
 *   - `hasSeparate`  — the poll links a SEPARATE (non-self, safe) results document.
 *   - `responses`    — the responses successfully read from it (`[]` otherwise).
 *   - `readFailed`   — a separate doc is linked AND it EXISTS but could not be
 *                      read/parsed (a non-404 error: 403/network/parse). A 404 is
 *                      NOT a failure — SolidOS creates `results.ttl` lazily, so an
 *                      absent doc legitimately means "no responses yet".
 *
 * The SAVE path consumes `readFailed` to AVOID silently orphaning an existing
 * external results document (roborev High): when a separate doc exists but the
 * merge failed, the organiser save must abort rather than rewrite the poll
 * self-referential and lose those votes. The READ paths only consume `responses`.
 */
export interface LinkedResultsOutcome {
  hasSeparate: boolean;
  responses: Rsvp[];
  readFailed: boolean;
}

/** Options for {@link inspectLinkedResults}. */
export interface InspectLinkedResultsOptions {
  fetchImpl?: typeof fetch;
  /** Already-fetched poll dataset, to skip re-GETting the poll document. */
  pollDataset?: import("@rdfjs/types").DatasetCore;
  /**
   * SAVE-PATH mode (`trusted: true`). The organiser save path passes its OWN
   * same-pod, scope-guarded poll URL — which is NOT a cross-pod target and may be
   * a LOCAL/dev origin (`http://localhost:3000/…`) the cross-pod validator
   * rejects. In trusted mode we therefore:
   *   - do NOT gate `pollUrl` through the cross-pod `isValidTargetUrl` (the
   *     loopback/http gate is a cross-pod-SSRF guard, irrelevant to the user's own
   *     pod) — but the RESULTS URL (document content) is STILL SSRF-guarded; and
   *   - treat ANY inability to inspect (poll fetch error, OR a results link we
   *     can't safely resolve/read) as `readFailed: true`, so the save ABORTS
   *     rather than risk orphaning an external results doc (roborev: local-path
   *     gap + "save paths must treat inability-to-inspect as a read failure").
   * The READ paths (`readPollAt`, the detail tally) leave this `false`/unset:
   * best-effort, cross-pod-validated, a failure just yields no extra responses.
   */
  trusted?: boolean;
}

/** See {@link LinkedResultsOutcome}. SSRF-guarded; never throws. */
export async function inspectLinkedResults(
  pollUrl: string,
  fetchImplOrOptions?: typeof fetch | InspectLinkedResultsOptions,
  pollDatasetArg?: import("@rdfjs/types").DatasetCore,
): Promise<LinkedResultsOutcome> {
  // Back-compat positional signature `(pollUrl, fetchImpl?, pollDataset?)` AND a
  // richer options object (for `trusted`).
  const opts: InspectLinkedResultsOptions =
    typeof fetchImplOrOptions === "function" || fetchImplOrOptions === undefined
      ? { fetchImpl: fetchImplOrOptions, pollDataset: pollDatasetArg }
      : fetchImplOrOptions;
  const trusted = opts.trusted ?? false;
  const none: LinkedResultsOutcome = { hasSeparate: false, responses: [], readFailed: false };
  // Inability to inspect is a hard failure in trusted (save) mode, a no-op in read mode.
  const cannotInspect: LinkedResultsOutcome = { hasSeparate: false, responses: [], readFailed: trusted };

  // CROSS-POD READ mode gates the poll URL; TRUSTED (same-pod save) mode does not
  // (the poll is the user's own resource, possibly a local/dev origin).
  if (!trusted && !isValidTargetUrl(pollUrl)) return none;
  const guarded = noFollowFetch(opts.fetchImpl);

  let dataset = opts.pollDataset;
  if (!dataset) {
    try {
      ({ dataset } = await freshRdf(pollUrl, guarded));
    } catch {
      return cannotInspect; // can't read the poll → block the save (trusted), else no-op
    }
  }

  let resultsUrl: string | undefined;
  let subjectTerm: import("@rdfjs/types").Term | undefined;
  try {
    subjectTerm = findSubjectOfClass(pollUrl, POLL_CLASS, dataset);
    if (!subjectTerm) return none; // not a sched poll → nothing linked
    // Defensive extraction (roborev Low): a malformed `sched:results` (e.g. a
    // literal, not a named node) must not throw and sink the read.
    resultsUrl = new PollDoc(subjectTerm, dataset, DataFactory).results;
  } catch {
    return cannotInspect;
  }

  // Self-referential (PM) or no link → nothing separate to fetch.
  if (!resultsUrl || resultsUrl === pollUrl) return none;
  // The results URL is DOCUMENT CONTENT (attacker-influenceable), so it is SSRF-
  // guarded — EXCEPT a same-origin results doc in trusted (save) mode, which is
  // within the user's OWN pod (incl. a local/dev origin the cross-pod validator
  // would otherwise reject). A cross-origin results URL is always SSRF-guarded.
  // An unsafe results URL we cannot safely read is a read failure for the save
  // path (block), a no-op for the read path.
  const resultsSafe = trusted
    ? sameOrigin(resultsUrl, pollUrl) || isValidTargetUrl(resultsUrl)
    : isValidTargetUrl(resultsUrl);
  if (!resultsSafe) return cannotInspect;
  try {
    const { dataset: resultsDs } = await freshRdf(resultsUrl, guarded);
    // The results doc links responses from the SAME poll subject (SolidOS:
    // `<#event> sched:response <#resp>`), so read over that discovered subject.
    const responses = readResponses(new PollDoc(subjectTerm, resultsDs, DataFactory));
    return { hasSeparate: true, responses, readFailed: false };
  } catch (e) {
    // A 404 = the lazily-created results doc doesn't exist yet → no responses,
    // NOT a failure (safe to rewrite). Any OTHER error (403/network/parse) on an
    // EXISTING linked doc is a read failure the save path must treat as fatal.
    const missing = e instanceof RdfFetchError && e.status === 404;
    return { hasSeparate: true, responses: [], readFailed: !missing };
  }
}

/**
 * Record an invitee's RSVP. Every write is SAME-POD: we write the response into
 * the INVITEE's OWN pod (under {@link RESPONSES_SLUG}) — never to the
 * organiser's pod — then NOTIFY the organiser via the SSRF-hardened
 * `sendNotification` so they can aggregate it. The response resource carries the
 * SolidOS `sched:response`/`sched:cell` shape AND a `sched:results <pollUrl>`
 * back-link so the organiser can verify it is FOR this poll BY this attendee.
 *
 * @returns the URL of the response resource written in the invitee's own pod.
 */
export async function respondToPoll(
  args: {
    pollUrl: string;
    organizerWebId: string;
    attendeeWebId: string;
    podRoot: string;
    option: string; // ISO start-time of the chosen option
    response: RsvpResponse;
    pollName?: string;
  },
  fetchImpl?: typeof fetch,
): Promise<{ responseUrl: string }> {
  // VALIDATE the option up front (roborev Low): an unparseable option would make
  // `writeResponse` emit NO response triples, yet we'd still PUT an empty resource
  // and send a "success" notification — a silent no-op the caller thinks worked.
  // Fail closed before any write/notify so the caller surfaces a real error.
  const optDate = lenientDate(args.option);
  if (!optDate) {
    throw new RangeError(`respondToPoll: unparseable option "${args.option}"`);
  }
  const optionIso = optDate.toISOString();

  // 1. Same-pod write: one response resource per (poll, attendee) in the
  //    attendee's own pod. The name is DETERMINISTIC in the poll URL so a
  //    re-vote OVERWRITES in place (no orphan response files accumulate).
  const container = new URL(RESPONSES_SLUG, args.podRoot).toString();
  const key = stableKey(args.pollUrl);
  const responseUrl = `${container}rsvp-${key}.ttl`;
  const store = new Store();
  // Typed response write (house rule: no inline DataFactory.quad). The response
  // node's `sched:results` binds it to the poll for organiser-side verification.
  // In the standalone response resource the poll subject and binding are BOTH the
  // poll RESOURCE URL (the doc holds no poll `#it` subject of its own).
  writeResponse(store, responseUrl, args.pollUrl, args.pollUrl, 0, {
    attendee: args.attendeeWebId,
    option: optionIso,
    response: args.response,
  });
  await writeResource(responseUrl, store, { fetchImpl, prefixes: PREFIXES });

  // 2. Notify the organiser (strict-validated cross-pod). Best-effort: the RSVP
  //    is already persisted in the attendee's pod even if delivery fails. The
  //    `content` carries the response resource URL so the organiser can fetch +
  //    aggregate it (see {@link aggregatePollRsvps}).
  await sendNotification(
    {
      recipientWebId: args.organizerWebId,
      actorWebId: args.attendeeWebId,
      type: "Offer",
      object: args.pollUrl,
      summary: `RSVP ${args.response} for ${optionIso}`,
      content: responseUrl,
    },
    fetchImpl,
  );

  return { responseUrl };
}

/**
 * A stable, URI-safe, COLLISION-FREE key for a poll URL (for deterministic
 * response filenames so a re-vote overwrites in place). We encode the full URL
 * (not a narrow hash) so two distinct polls can never collide onto one response
 * resource: lower-case base16 of the UTF-8 bytes, capped to keep names sane —
 * with a short hash suffix guaranteeing uniqueness even past the cap.
 */
function stableKey(url: string): string {
  const bytes = new TextEncoder().encode(url);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  // Cap the readable prefix but append a hash of the FULL url so distinct urls
  // sharing a prefix still differ.
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (Math.imul(31, h) + url.charCodeAt(i)) | 0;
  return `${hex.slice(0, 48)}-${(h >>> 0).toString(36)}`;
}

/** True iff two absolute URLs share an origin (scheme+host+port). */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Resolve the storage roots an actor advertises (`pim:storage`) — the pods they
 * legitimately control. Used to WIDEN the membership check (a response may live
 * in the actor's declared storage even on a different origin from the WebID).
 *
 * The actor WebID is attacker-influenceable (it is the self-asserted `as:actor`
 * of an inbox Offer). We validate the host (`isValidTargetUrl`) and fetch with
 * `redirect: "manual"` (`noFollowFetch`) so the auth-patched fetch is NEVER
 * steered to a private host on a malicious 303 — fail closed.
 *
 * BROWSER/INTEROP LIMITATION (deliberate, security-first): a browser
 * `redirect: "manual"` response is OPAQUE (no readable `Location`), so we cannot
 * safely follow it client-side without DNS-pinning (unavailable in `fetch`).
 * Therefore an actor whose WebID document 303-redirects, OR who advertises
 * storage only in an extended profile doc, will not have storage resolved here —
 * such a response is then accepted ONLY if it is same-origin with the actor's
 * WebID (see {@link contentBelongsToActor}). This can drop a legitimate
 * split-origin+redirecting vote, which we accept as the safe tradeoff over the
 * SSRF that hop-following on an attacker-influenced URL would introduce. Returns
 * `[]` on any non-200 / failure.
 */
async function actorStorages(webId: string, fetchImpl?: typeof fetch): Promise<string[]> {
  let docUrl: string;
  try {
    docUrl = profileDocUrl(webId);
  } catch {
    return [];
  }
  if (!isValidTargetUrl(docUrl)) return [];
  try {
    const { dataset } = await freshRdf(docUrl, noFollowFetch(fetchImpl));
    return readProfile(webId, dataset).storages;
  } catch {
    return [];
  }
}

/**
 * True iff `content` legitimately belongs to `actor`: it is same-origin with the
 * actor's WebID OR within one of the actor's advertised `pim:storage` roots.
 * Covers both the WebID==pod-origin case and the common Solid case where the
 * WebID host differs from the pod host.
 */
function contentBelongsToActor(content: string, actor: string, storages: readonly string[]): boolean {
  if (sameOrigin(content, actor)) return true;
  return isInOwnPods(content, storages);
}

/** An inbox Offer relevant to aggregation: its sender (actor), object, content. */
export interface PollOffer {
  /** The notification sender WebID (`as:actor`) — the ONLY attendee it can vote as. */
  actor?: string;
  /** `as:object` — the poll IRI the Offer is about. */
  object?: string;
  /** `as:content` — the response resource URL in the sender's pod. */
  content?: string;
}

/**
 * Organiser-side aggregation (closes the cross-pod RSVP loop).
 *
 * For each `Offer` whose `object` is THIS poll, fetch its response resource (the
 * `content` URL) read-only — STRICT-validated via {@link readRsvpResourceAt},
 * since that URL is attacker-influenceable — and merge the resulting RSVPs.
 *
 * INTEGRITY (anti-ballot-stuffing + anti-impersonation). Both the inbox Offer
 * (its `as:actor` is self-asserted — anyone can POST to the inbox) AND the
 * response resource it links (attacker-hosted bytes) are untrusted. We bind on
 * BOTH ends so a forged vote is impossible unless the attacker actually controls
 * the victim's pod:
 *   1. The response resource's ORIGIN must equal the Offer actor's ORIGIN — the
 *      response must live in the actor's OWN pod. This stops an attacker POSTing
 *      `actor=<victim>, content=<attacker-pod>` (the actor is forgeable, but the
 *      attacker cannot host a resource on the victim's origin).
 *   2. Each kept RSVP must have `dc:author === actor` and its response node's
 *      `sched:results === pollUrl` (re-read from the resource).
 * Duplicate `(attendee, option)` pairs collapse last-wins; the caller passes
 * offers most-recent-last. Duplicate `(actor, content)` Offers are de-duped.
 *
 * @returns the poll's `rsvps` augmented with the validated aggregated responses.
 */
export async function aggregatePollRsvps(
  poll: Poll,
  pollUrl: string,
  offers: readonly PollOffer[],
  fetchImpl?: typeof fetch,
): Promise<Rsvp[]> {
  // Candidate Offers: for THIS poll, with an actor + an http(s) content URL.
  const candidates = offers.filter(
    (o): o is PollOffer & { actor: string; content: string } =>
      o.object === pollUrl && !!o.actor && !!o.content && /^https?:/i.test(o.content),
  );
  // De-dupe by (actor, content) — repeated/retried Offers must not refetch.
  const byPair = new Map<string, PollOffer & { actor: string; content: string }>();
  for (const o of candidates) byPair.set(`${o.actor}|${o.content}`, o);

  // Resolve each distinct actor's storages ONCE (the impersonation guard binds
  // the response resource to a pod the actor actually controls).
  const actors = [...new Set([...byPair.values()].map((o) => o.actor))];
  const storagesByActor = new Map<string, string[]>();
  await Promise.all(
    actors.map(async (a) => {
      storagesByActor.set(a, await actorStorages(a, fetchImpl));
    }),
  );

  const fetched = await Promise.all(
    [...byPair.values()].map(async (o) => {
      // The response must belong to the actor (same WebID origin OR within one of
      // the actor's advertised pim:storage roots) — else it is a forgery attempt.
      if (!contentBelongsToActor(o.content, o.actor, storagesByActor.get(o.actor) ?? [])) {
        return [] as Rsvp[];
      }
      try {
        // Bind to the sender: only RSVPs FOR this poll BY this actor survive.
        return await readRsvpResourceAt(o.content, pollUrl, o.actor, fetchImpl);
      } catch {
        return [] as Rsvp[];
      }
    }),
  );
  // Merge poll's own rsvps + the aggregated cross-pod ones, last-wins per
  // (attendee, option), DROPPING any aggregated RSVP for an option the poll does
  // not declare (roborev Medium — a forged-but-valid response carrying a fresh
  // datetime must not mint a phantom tally row).
  return mergeRsvpsWithinOptions(poll.rsvps, fetched.flat(), poll.options);
}

/**
 * Read an RSVP response resource that lives in ANOTHER agent's pod, read-only.
 * Same SSRF guard as {@link readPollAt}: validate the URL + redirect:manual.
 *
 * INTEGRITY: returns ONLY the RSVPs whose response node's `sched:results` equals
 * `expectedPoll` AND whose `dc:author` equals `expectedAttendee` (the Offer's
 * sender), so an attacker-hosted document cannot inject votes for other people
 * or other polls. The poll-binding (`sched:results`) is re-read here (it is not
 * part of {@link Rsvp}).
 */
export async function readRsvpResourceAt(
  url: string,
  expectedPoll: string,
  expectedAttendee: string,
  fetchImpl?: typeof fetch,
): Promise<Rsvp[]> {
  assertValidTargetUrl(url);
  const { dataset } = await freshRdf(url, noFollowFetch(fetchImpl));
  const out: Rsvp[] = [];
  // The response resource holds `sched:response` nodes directly (not under a
  // poll subject in this doc), so walk every ResponseDoc by its dc:author.
  // Pass the RDF/JS TERM (not `.value`): a blank-node subject coerced to a string
  // becomes a NamedNode lookup and the blank-node response is silently missed.
  for (const q of dataset.match(null, DataFactory.namedNode(`${DC}author`), null)) {
    const resp = new ResponseDoc(q.subject, dataset, DataFactory);
    const attendee = resp.author;
    if (resp.forPoll !== expectedPoll) continue; // RSVP must be for THIS poll
    if (!attendee || attendee !== expectedAttendee) continue; // and BY the sender
    for (const cell of resp.cells) {
      const iso = normaliseIso(cell.dtstartRaw);
      const avail = cell.availability;
      const response = avail ? RSVP_FROM_IRI[avail] : undefined;
      if (!iso || !response) continue;
      out.push({ attendee, option: iso, response });
    }
  }
  // BACKWARDS-COMPAT (roborev Medium): an invitee who voted with the PRE-interop
  // build wrote a `schema:RsvpAction` response resource in their own pod. After
  // the ORGANISER upgrades, aggregation must still read those pending votes —
  // enforcing the SAME integrity binds (schema:object === expectedPoll AND
  // schema:attendee === expectedAttendee) so a legacy resource can't inject votes
  // for other people/polls either. Only consulted when no `sched:` response
  // matched above (a doc is one shape or the other).
  if (out.length === 0) {
    out.push(...readLegacyRsvpResource(dataset, expectedPoll, expectedAttendee));
  }
  return out;
}

/**
 * Read the LEGACY `schema:RsvpAction` response shape from a foreign response
 * resource, with the SAME integrity binds as the `sched:` path: each action must
 * have `schema:object === expectedPoll` (for THIS poll) and
 * `schema:attendee === expectedAttendee` (BY the Offer's sender). Pure over the
 * parsed dataset; typed accessors only.
 */
function readLegacyRsvpResource(
  dataset: import("@rdfjs/types").DatasetCore,
  expectedPoll: string,
  expectedAttendee: string,
): Rsvp[] {
  const out: Rsvp[] = [];
  for (const q of dataset.match(
    null,
    DataFactory.namedNode(RDF_TYPE),
    DataFactory.namedNode(LEGACY_RSVP_ACTION),
  )) {
    // Pass the TERM (blank-node safe — old responses used `<resourceUrl>#it`,
    // but a foreign serialiser may have written a blank node).
    const r = new LegacyRsvpDoc(q.subject, dataset, DataFactory);
    const attendee = r.attendee;
    const option = normaliseIso(r.optionRaw);
    const response = r.response ? LEGACY_RSVP_FROM_IRI[r.response] : undefined;
    if (r.forPoll !== expectedPoll) continue; // for THIS poll
    if (!attendee || attendee !== expectedAttendee) continue; // by the sender
    if (!option || !response) continue;
    out.push({ attendee, option, response });
  }
  return out;
}
