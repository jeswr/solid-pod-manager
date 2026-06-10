/**
 * Typed RDF wrappers for everything the Tier-A adapters write — the only way
 * integration data becomes triples (house rule: never hand-build quads).
 * Standard vocabularies only: schema.org + FOAF, matching the category
 * taxonomy's class lists (`src/lib/categories.ts`).
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

export const SCHEMA = "https://schema.org/";
export const FOAF = "http://xmlns.com/foaf/0.1/";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** Class IRIs the adapters stamp + register (kept with the wrappers). */
export const CLASSES = {
  MusicRecording: `${SCHEMA}MusicRecording`,
  MusicPlaylist: `${SCHEMA}MusicPlaylist`,
  SoftwareSourceCode: `${SCHEMA}SoftwareSourceCode`,
  ExerciseAction: `${SCHEMA}ExerciseAction`,
  TravelAction: `${SCHEMA}TravelAction`,
  SocialMediaPosting: `${SCHEMA}SocialMediaPosting`,
  WatchAction: `${SCHEMA}WatchAction`,
  TextDigitalDocument: `${SCHEMA}TextDigitalDocument`,
  DigitalDocument: `${SCHEMA}DigitalDocument`,
  Dataset: `${SCHEMA}Dataset`,
  Group: `${FOAF}Group`,
  OnlineAccount: `${FOAF}OnlineAccount`,
  // Tier-C file imports (export-file integrations).
  Invoice: `${SCHEMA}Invoice`,
  Book: `${SCHEMA}Book`,
  VideoGame: `${SCHEMA}VideoGame`,
  Message: `${SCHEMA}Message`,
  Event: `${SCHEMA}Event`,
  // Tier-B OAuth integrations (photos, videos, work positions).
  ImageObject: `${SCHEMA}ImageObject`,
  VideoObject: `${SCHEMA}VideoObject`,
  Organization: `${SCHEMA}Organization`,
} as const;

/** Shared schema.org basics every imported entity may carry. */
export class PodThing extends TermWrapper {
  /** Live set of `rdf:type` IRIs. */
  get types(): Set<string> {
    return SetFrom.subjectPredicate(this, RDF_TYPE, NamedNodeAs.string, NamedNodeFrom.string);
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
  /** Canonical page on the source platform. */
  get sourceUrl(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}url`, NamedNodeAs.string);
  }
  set sourceUrl(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}url`, v, NamedNodeFrom.string);
  }
  /** The platform's own id for the item (provenance + dedupe). */
  get identifier(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}identifier`, LiteralAs.string);
  }
  set identifier(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}identifier`, v, LiteralFrom.string);
  }
  get dateCreated(): Date | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}dateCreated`, LiteralAs.date);
  }
  set dateCreated(v: Date | undefined) {
    OptionalAs.object(this, `${SCHEMA}dateCreated`, v, LiteralFrom.dateTime);
  }
  get dateModified(): Date | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}dateModified`, LiteralAs.date);
  }
  set dateModified(v: Date | undefined) {
    OptionalAs.object(this, `${SCHEMA}dateModified`, v, LiteralFrom.dateTime);
  }
  get datePublished(): Date | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}datePublished`, LiteralAs.date);
  }
  set datePublished(v: Date | undefined) {
    OptionalAs.object(this, `${SCHEMA}datePublished`, v, LiteralFrom.dateTime);
  }
}

export class MusicRecording extends PodThing {
  mark(): this {
    this.types.add(CLASSES.MusicRecording);
    return this;
  }
  /** Artist display name (schema.org allows Text for byArtist). */
  get byArtist(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}byArtist`, LiteralAs.string);
  }
  set byArtist(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}byArtist`, v, LiteralFrom.string);
  }
  get inAlbum(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}inAlbum`, LiteralAs.string);
  }
  set inAlbum(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}inAlbum`, v, LiteralFrom.string);
  }
  /** ISO-8601 duration (`PT3M52S`). */
  get duration(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}duration`, LiteralAs.string);
  }
  set duration(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}duration`, v, LiteralFrom.string);
  }
}

export class MusicPlaylist extends PodThing {
  mark(): this {
    this.types.add(CLASSES.MusicPlaylist);
    return this;
  }
  get numTracks(): number | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}numTracks`, LiteralAs.number);
  }
  set numTracks(v: number | undefined) {
    OptionalAs.object(this, `${SCHEMA}numTracks`, v, LiteralFrom.integer);
  }
}

export class SoftwareSourceCode extends PodThing {
  mark(): this {
    this.types.add(CLASSES.SoftwareSourceCode);
    return this;
  }
  get programmingLanguage(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}programmingLanguage`, LiteralAs.string);
  }
  set programmingLanguage(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}programmingLanguage`, v, LiteralFrom.string);
  }
  get codeRepository(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}codeRepository`, NamedNodeAs.string);
  }
  set codeRepository(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}codeRepository`, v, NamedNodeFrom.string);
  }
}

/** Shared shape for schema.org Actions with time/distance (Strava, Twitch). */
export class ActionThing extends PodThing {
  get startTime(): Date | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}startTime`, LiteralAs.date);
  }
  set startTime(v: Date | undefined) {
    OptionalAs.object(this, `${SCHEMA}startTime`, v, LiteralFrom.dateTime);
  }
  /** ISO-8601 duration. */
  get duration(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}duration`, LiteralAs.string);
  }
  set duration(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}duration`, v, LiteralFrom.string);
  }
  /** schema:distance is Text-or-Distance — store human text ("5.2 km"). */
  get distance(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}distance`, LiteralAs.string);
  }
  set distance(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}distance`, v, LiteralFrom.string);
  }
}

export class ExerciseAction extends ActionThing {
  mark(): this {
    this.types.add(CLASSES.ExerciseAction);
    return this;
  }
  get exerciseType(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}exerciseType`, LiteralAs.string);
  }
  set exerciseType(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}exerciseType`, v, LiteralFrom.string);
  }
}

export class TravelAction extends ActionThing {
  mark(): this {
    this.types.add(CLASSES.TravelAction);
    return this;
  }
}

export class WatchAction extends ActionThing {
  mark(): this {
    this.types.add(CLASSES.WatchAction);
    return this;
  }
}

export class SocialMediaPosting extends PodThing {
  mark(): this {
    this.types.add(CLASSES.SocialMediaPosting);
    return this;
  }
  get headline(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}headline`, LiteralAs.string);
  }
  set headline(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}headline`, v, LiteralFrom.string);
  }
  /** The community/feed it belongs to (subreddit, channel, …) as text. */
  get isPartOf(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}isPartOf`, LiteralAs.string);
  }
  set isPartOf(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}isPartOf`, v, LiteralFrom.string);
  }
}

export class Group extends PodThing {
  mark(): this {
    this.types.add(CLASSES.Group);
    return this;
  }
}

export class OnlineAccount extends PodThing {
  mark(): this {
    this.types.add(CLASSES.OnlineAccount);
    return this;
  }
  get accountName(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${FOAF}accountName`, LiteralAs.string);
  }
  set accountName(v: string | undefined) {
    OptionalAs.object(this, `${FOAF}accountName`, v, LiteralFrom.string);
  }
  get accountServiceHomepage(): string | undefined {
    return OptionalFrom.subjectPredicate(
      this,
      `${FOAF}accountServiceHomepage`,
      NamedNodeAs.string,
    );
  }
  set accountServiceHomepage(v: string | undefined) {
    OptionalAs.object(this, `${FOAF}accountServiceHomepage`, v, NamedNodeFrom.string);
  }
}

export class DigitalDocument extends PodThing {
  /** Stamp as a generic file (Dropbox) or a text page (Notion). */
  mark(classIri: string = CLASSES.DigitalDocument): this {
    this.types.add(classIri);
    return this;
  }
  get encodingFormat(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}encodingFormat`, LiteralAs.string);
  }
  set encodingFormat(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}encodingFormat`, v, LiteralFrom.string);
  }
  /** schema:contentSize is Text ("1.2 MB"). */
  get contentSize(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}contentSize`, LiteralAs.string);
  }
  set contentSize(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}contentSize`, v, LiteralFrom.string);
  }
}

/** A structured collection (Notion database) — schema:Dataset. */
export class DataCollection extends PodThing {
  mark(): this {
    this.types.add(CLASSES.Dataset);
    return this;
  }
}

/**
 * A financial document — order receipts (Amazon), trip fares (Uber) and bank
 * transactions (statements, ChatGPT-of-money). schema:Invoice lands in the
 * Finance category. Amounts are stored as human text on schema:totalPaymentDue
 * (schema allows Text-or-PriceSpecification) plus a structured currency code,
 * which is faithful without minting a nested MonetaryAmount node per row.
 */
export class Invoice extends PodThing {
  mark(): this {
    this.types.add(CLASSES.Invoice);
    return this;
  }
  /** Vendor / counterparty as plain text (schema:provider is Org|Person). */
  get provider(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}provider`, LiteralAs.string);
  }
  set provider(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}provider`, v, LiteralFrom.string);
  }
  /** Human-readable total ("£42.50", "-$12.00" for a debit). */
  get totalPaymentDue(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}totalPaymentDue`, LiteralAs.string);
  }
  set totalPaymentDue(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}totalPaymentDue`, v, LiteralFrom.string);
  }
  /** ISO 4217 currency code, when the export states one. */
  get priceCurrency(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}priceCurrency`, LiteralAs.string);
  }
  set priceCurrency(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}priceCurrency`, v, LiteralFrom.string);
  }
  /** Order/payment status text, where the export carries one. */
  get paymentStatus(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}paymentStatus`, LiteralAs.string);
  }
  set paymentStatus(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}paymentStatus`, v, LiteralFrom.string);
  }
}

/** A book in a reading library (Goodreads) — schema:Book → Documents. */
export class Book extends PodThing {
  mark(): this {
    this.types.add(CLASSES.Book);
    return this;
  }
  get author(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}author`, LiteralAs.string);
  }
  set author(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}author`, v, LiteralFrom.string);
  }
  get isbn(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}isbn`, LiteralAs.string);
  }
  set isbn(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}isbn`, v, LiteralFrom.string);
  }
  /** The reader's own rating, 1–5 (schema:Rating value as a number). */
  get ratingValue(): number | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}ratingValue`, LiteralAs.number);
  }
  set ratingValue(v: number | undefined) {
    OptionalAs.object(this, `${SCHEMA}ratingValue`, v, LiteralFrom.double);
  }
  /** Reading status text ("read", "currently-reading", "to-read"). */
  get readingStatus(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}actionStatus`, LiteralAs.string);
  }
  set readingStatus(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}actionStatus`, v, LiteralFrom.string);
  }
}

/** A game in a library (Steam) — schema:VideoGame → Media. */
export class VideoGame extends PodThing {
  mark(): this {
    this.types.add(CLASSES.VideoGame);
    return this;
  }
  /** Total playtime as ISO-8601 duration (schema:timeRequired). */
  get timeRequired(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}timeRequired`, LiteralAs.string);
  }
  set timeRequired(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}timeRequired`, v, LiteralFrom.string);
  }
}

/**
 * A chat message (WhatsApp) — schema:Message → Social & interests. The sender
 * is stored as plain text on schema:sender (schema allows Audience|Organization
 * |Person; we keep a literal name from the export, never an invented IRI).
 */
export class Message extends PodThing {
  mark(): this {
    this.types.add(CLASSES.Message);
    return this;
  }
  get text(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}text`, LiteralAs.string);
  }
  set text(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}text`, v, LiteralFrom.string);
  }
  get sender(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}sender`, LiteralAs.string);
  }
  set sender(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}sender`, v, LiteralFrom.string);
  }
}

/** A text document / conversation (ChatGPT, Takeout notes) — schema:TextDigitalDocument. */
export class TextDocument extends PodThing {
  mark(): this {
    this.types.add(CLASSES.TextDigitalDocument);
    return this;
  }
  get text(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}text`, LiteralAs.string);
  }
  set text(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}text`, v, LiteralFrom.string);
  }
}

/** A calendar event (Google Calendar, Takeout activity) — schema:Event → Calendar. */
export class CalendarEvent extends PodThing {
  mark(): this {
    this.types.add(CLASSES.Event);
    return this;
  }
  get startDate(): Date | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}startDate`, LiteralAs.date);
  }
  set startDate(v: Date | undefined) {
    OptionalAs.object(this, `${SCHEMA}startDate`, v, LiteralFrom.dateTime);
  }
  get endDate(): Date | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}endDate`, LiteralAs.date);
  }
  set endDate(v: Date | undefined) {
    OptionalAs.object(this, `${SCHEMA}endDate`, v, LiteralFrom.dateTime);
  }
  /** Free-text location (schema:location allows Text). */
  get location(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}location`, LiteralAs.string);
  }
  set location(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}location`, v, LiteralFrom.string);
  }
}

/**
 * A media object (photo or video) — schema:ImageObject / schema:VideoObject →
 * Media. Carries a content URL (the platform-hosted asset) and, where the API
 * states one, dimensions and a human-readable duration (videos).
 */
export class MediaItem extends PodThing {
  /** Stamp as a photo ({@link CLASSES.ImageObject}) or video ({@link CLASSES.VideoObject}). */
  mark(classIri: string = CLASSES.ImageObject): this {
    this.types.add(classIri);
    return this;
  }
  /** The hosted asset URL (schema:contentUrl). */
  get contentUrl(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}contentUrl`, NamedNodeAs.string);
  }
  set contentUrl(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}contentUrl`, v, NamedNodeFrom.string);
  }
  get encodingFormat(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}encodingFormat`, LiteralAs.string);
  }
  set encodingFormat(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}encodingFormat`, v, LiteralFrom.string);
  }
  get width(): number | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}width`, LiteralAs.number);
  }
  set width(v: number | undefined) {
    OptionalAs.object(this, `${SCHEMA}width`, v, LiteralFrom.integer);
  }
  get height(): number | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}height`, LiteralAs.number);
  }
  set height(v: number | undefined) {
    OptionalAs.object(this, `${SCHEMA}height`, v, LiteralFrom.integer);
  }
  /** ISO-8601 duration (videos). */
  get duration(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}duration`, LiteralAs.string);
  }
  set duration(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}duration`, v, LiteralFrom.string);
  }
}

/**
 * An organisation or organisational unit (Slack workspace + its channels) —
 * `schema:Organization` → Work & education. Channels are modelled as member
 * organisations (a faithful, no-invented-IRI mapping that lands in the right
 * category, since `foaf:Group` is claimed by Social).
 */
export class Organisation extends PodThing {
  mark(): this {
    this.types.add(CLASSES.Organization);
    return this;
  }
}

/**
 * A work position the user held (LinkedIn) — modelled as the employer
 * `schema:Organization` carrying the role title (schema:jobTitle, allowed as a
 * Text on the role) and the dates worked. Lands in Work & education.
 */
export class WorkPosition extends PodThing {
  mark(): this {
    this.types.add(CLASSES.Organization);
    return this;
  }
  /** The role/title held at this organisation. */
  get jobTitle(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}jobTitle`, LiteralAs.string);
  }
  set jobTitle(v: string | undefined) {
    OptionalAs.object(this, `${SCHEMA}jobTitle`, v, LiteralFrom.string);
  }
  get startDate(): Date | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}startDate`, LiteralAs.date);
  }
  set startDate(v: Date | undefined) {
    OptionalAs.object(this, `${SCHEMA}startDate`, v, LiteralFrom.dateTime);
  }
  get endDate(): Date | undefined {
    return OptionalFrom.subjectPredicate(this, `${SCHEMA}endDate`, LiteralAs.date);
  }
  set endDate(v: Date | undefined) {
    OptionalAs.object(this, `${SCHEMA}endDate`, v, LiteralFrom.dateTime);
  }
}

/** Default Turtle prefixes for readable imported documents. */
export const VOCAB_PREFIXES = {
  schema: SCHEMA,
  foaf: FOAF,
} as const;
