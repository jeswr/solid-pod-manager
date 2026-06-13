// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Scheduling / RSVP (Feature 3) — propose an event poll with several time
 * OPTIONS, invite agents (cross-pod, via the SSRF-hardened `sendNotification`),
 * collect RSVP responses, and tally per option.
 *
 * COLLABORATION MODEL (security-critical). Every WRITE is SAME-POD:
 *   - The ORGANISER owns the poll resource in their own pod under `schedule/`
 *     (one resource per poll, Type-Index registered via the shared store engine,
 *     so it surfaces under "My data"). Same-pod CRUD.
 *   - An INVITEE never writes to the organiser's pod (that would be a huge new
 *     cross-pod-write surface). Instead they (a) READ the organiser's poll
 *     read-only — validated like any cross-pod target via `agent-target`'s
 *     `assertValidTargetUrl` + redirect-no-follow, so the auth-patched fetch is
 *     never steered to a private host — and (b) record their own RSVP, then
 *     NOTIFY the organiser via the SSRF-hardened `sendNotification` carrying the
 *     response. The organiser aggregates received RSVPs into their poll.
 * So the only cross-pod surfaces are: the Invite notification, a validated
 * read-only GET of the organiser's poll, and the RSVP-back notification.
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
    rsvps: readRsvps(dataset),
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

/**
 * Read every RSVP action in the dataset, collapsing duplicate
 * `(attendee, option)` pairs LAST-WINS (consistent with {@link tallyRsvps}).
 */
function readRsvps(dataset: import("@rdfjs/types").DatasetCore): Rsvp[] {
  const byKey = new Map<string, Rsvp>();
  for (const q of dataset.match(null, DataFactory.namedNode(RDF_TYPE), DataFactory.namedNode(RSVP_ACTION))) {
    const doc = new RsvpDoc(q.subject.value, dataset, DataFactory);
    const attendee = doc.attendee;
    const option = doc.option;
    const response = doc.response ? RSVP_FROM_IRI[doc.response] : undefined;
    if (!attendee || !option || !response) continue;
    const iso = option.toISOString();
    byKey.set(`${attendee}|${iso}`, { attendee, option: iso, response }); // last wins
  }
  return [...byKey.values()];
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
  return parsePoll(pollUrl, dataset);
}

/**
 * Record an invitee's RSVP. Every write is SAME-POD: we write the response into
 * the INVITEE's OWN pod (under {@link RESPONSES_SLUG}) — never to the
 * organiser's pod — then NOTIFY the organiser via the SSRF-hardened
 * `sendNotification` so they can aggregate it. The notification carries the poll
 * IRI (`as:object`), the chosen option + response in the summary, and the
 * attendee as `as:actor`.
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
  // 1. Same-pod write: one RsvpAction resource per (poll, attendee) in the
  //    attendee's own pod. The name is DETERMINISTIC in the poll URL so a
  //    re-vote OVERWRITES in place (no orphan response files accumulate).
  const container = new URL(RESPONSES_SLUG, args.podRoot).toString();
  const key = stableKey(args.pollUrl);
  const responseUrl = `${container}rsvp-${key}.ttl`;
  // Normalise the option once and reuse for both the write and the notification
  // (so a bad option can't write successfully then throw building the summary).
  const optDate = new Date(args.option);
  const optionIso = Number.isNaN(optDate.getTime()) ? args.option : optDate.toISOString();
  const store = new Store();
  const node = DataFactory.namedNode(`${responseUrl}#it`);
  store.add(DataFactory.quad(node, DataFactory.namedNode(RDF_TYPE), DataFactory.namedNode(RSVP_ACTION)));
  store.add(
    DataFactory.quad(node, DataFactory.namedNode(`${SCHEMA}object`), DataFactory.namedNode(args.pollUrl)),
  );
  store.add(
    DataFactory.quad(node, DataFactory.namedNode(`${SCHEMA}attendee`), DataFactory.namedNode(args.attendeeWebId)),
  );
  store.add(
    DataFactory.quad(
      node,
      DataFactory.namedNode(`${SCHEMA}startDate`),
      DataFactory.literal(optionIso, DataFactory.namedNode("http://www.w3.org/2001/XMLSchema#dateTime")),
    ),
  );
  store.add(
    DataFactory.quad(node, DataFactory.namedNode(`${SCHEMA}rsvpResponse`), DataFactory.namedNode(RSVP_IRI[args.response])),
  );
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
 *   2. Each kept RSVP must have `schema:attendee === actor` and
 *      `schema:object === pollUrl` (re-read from the resource).
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
  // Merge: poll's own rsvps first, then aggregated; last-wins per (attendee, option).
  const byKey = new Map<string, Rsvp>();
  for (const r of [...poll.rsvps, ...fetched.flat()]) {
    byKey.set(`${r.attendee}|${r.option}`, r);
  }
  return [...byKey.values()];
}

/**
 * Read an RSVP response resource that lives in ANOTHER agent's pod, read-only.
 * Same SSRF guard as {@link readPollAt}: validate the URL + redirect:manual.
 *
 * INTEGRITY: returns ONLY the RSVPs whose `schema:object` equals `expectedPoll`
 * AND whose `schema:attendee` equals `expectedAttendee` (the Offer's sender), so
 * an attacker-hosted document cannot inject votes for other people or other
 * polls. The `schema:object` is re-read here (it is not part of {@link Rsvp}).
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
  for (const q of dataset.match(null, DataFactory.namedNode(RDF_TYPE), DataFactory.namedNode(RSVP_ACTION))) {
    const doc = new RsvpDoc(q.subject.value, dataset, DataFactory);
    const object = OptionalFrom.subjectPredicate(doc, `${SCHEMA}object`, NamedNodeAs.string);
    const attendee = doc.attendee;
    const option = doc.option;
    const response = doc.response ? RSVP_FROM_IRI[doc.response] : undefined;
    if (object !== expectedPoll) continue; // RSVP must be for THIS poll
    if (!attendee || attendee !== expectedAttendee) continue; // and BY the sender
    if (!option || !response) continue;
    out.push({ attendee, option: option.toISOString(), response });
  }
  return out;
}
