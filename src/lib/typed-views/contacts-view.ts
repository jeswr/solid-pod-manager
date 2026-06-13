// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Contacts typed-view (design: `docs/typed-data-views.md` §2.2, §4, P1).
 *
 * Targets the real vcard shape this app writes (`src/lib/contacts.ts`):
 * `vcard:Individual` with `vcard:fn`, `vcard:hasEmail` (a `mailto:` IRI),
 * `vcard:hasTelephone` (a `tel:` IRI), `vcard:note`. WebID-style profiles
 * (`foaf:Person` with `foaf:name`/`vcard:hasPhoto`) are the avatar-bearing
 * sibling — handled by reusing `ProfileAgent`'s `displayName`/`avatarUrl`
 * fallback chains verbatim.
 *
 * Pure: extracts a plain `{ items: ContactCard[] }` model the React card
 * renders as a profile-card list — avatar + name + email/phone actions, no raw
 * triples and no raw URLs.
 */
import type { DatasetCore, Quad } from "@rdfjs/types";
import { DataFactory } from "n3";
import { ProfileAgent } from "../profile-agent.js";
import { stripScheme } from "../contacts.js";
import type { TypedViewer, ViewerContext } from "./types.js";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const VCARD = "http://www.w3.org/2006/vcard/ns#";
const FOAF = "http://xmlns.com/foaf/0.1/";

/** The class a first-party contact is stamped with (`contacts.ts CONTACT_CLASS`). */
const CONTACT_CLASS = `${VCARD}Individual`;
/** Avatar-bearing sibling shape. */
const PERSON_CLASS = `${FOAF}Person`;
/** Signature predicate that identifies an (even untyped) contact subject. */
const VCARD_FN = `${VCARD}fn`;

/** A single contact ready to render — plain + serialisable, no RDF terms. */
export interface ContactCard {
  /** The subject IRI (stable React key; never shown raw). */
  id: string;
  /** Display name via the `ProfileAgent` fallback chain; never empty. */
  name: string;
  /** Remote avatar IRI if the subject carries one (profiles do; contacts rarely). */
  avatarUrl?: string;
  /** Bare email for display (no `mailto:`). */
  email?: string;
  /** The raw `mailto:` IRI for a "Send email" action. */
  emailUri?: string;
  /** Bare phone for display (no `tel:`). */
  phone?: string;
  /** The raw `tel:` IRI for a "Call" action. */
  phoneUri?: string;
  /** Free-text note. */
  note?: string;
}

/** The Contacts view-model: a list of cards over every matching subject. */
export interface ContactsModel {
  items: ContactCard[];
}

/**
 * Does any subject in the resource look like a contact? Matches on
 * `vcard:Individual`/`foaf:Person` type (primary), or — for untyped data — the
 * presence of the `vcard:fn` signature predicate (the shape rescue, §4.3).
 */
function hasContactSubject(ctx: ViewerContext): boolean {
  if (ctx.types.has(CONTACT_CLASS) || ctx.types.has(PERSON_CLASS)) return true;
  for (const quad of ctx.dataset as Iterable<Quad>) {
    if (quad.predicate.value === VCARD_FN) return true;
  }
  return false;
}

/** Collect the subject IRIs that are contacts (typed or `vcard:fn`-shaped). */
function contactSubjects(dataset: DatasetCore): string[] {
  const subjects = new Set<string>();
  for (const quad of dataset as Iterable<Quad>) {
    if (quad.subject.termType !== "NamedNode") continue; // skip blank nodes
    const p = quad.predicate.value;
    const o = quad.object.value;
    if (p === RDF_TYPE && (o === CONTACT_CLASS || o === PERSON_CLASS)) {
      subjects.add(quad.subject.value);
    } else if (p === VCARD_FN) {
      subjects.add(quad.subject.value);
    }
  }
  return [...subjects];
}

/** Read the raw `vcard:hasEmail` / `vcard:hasTelephone` IRIs off a subject. */
function objectIri(
  dataset: DatasetCore,
  subject: string,
  predicate: string,
): string | undefined {
  for (const quad of dataset as Iterable<Quad>) {
    if (
      quad.subject.value === subject &&
      quad.predicate.value === predicate &&
      quad.object.termType === "NamedNode"
    ) {
      return quad.object.value;
    }
  }
  return undefined;
}

/** Free-text note off a subject (`vcard:note`). */
function objectLiteral(
  dataset: DatasetCore,
  subject: string,
  predicate: string,
): string | undefined {
  for (const quad of dataset as Iterable<Quad>) {
    if (
      quad.subject.value === subject &&
      quad.predicate.value === predicate &&
      quad.object.termType === "Literal"
    ) {
      return quad.object.value;
    }
  }
  return undefined;
}

/** Extract one card from a contact subject, reusing `ProfileAgent` for name/avatar. */
function extractCard(dataset: DatasetCore, subject: string): ContactCard {
  const agent = new ProfileAgent(subject, dataset, DataFactory);
  const emailUri = objectIri(dataset, subject, `${VCARD}hasEmail`);
  const phoneUri = objectIri(dataset, subject, `${VCARD}hasTelephone`);
  return {
    id: subject,
    name: agent.displayName, // foaf:name → schema:name → vcard:fn → … → the IRI
    avatarUrl: agent.avatarUrl,
    email: stripScheme(emailUri),
    emailUri,
    phone: stripScheme(phoneUri),
    phoneUri,
    note: objectLiteral(dataset, subject, `${VCARD}note`),
  };
}

/** The Contacts {@link TypedViewer}. Priority 70 — a very specific shape (§4.4). */
export const contactsViewer: TypedViewer<ContactsModel> = {
  id: "contacts",
  priority: 70,
  matches: hasContactSubject,
  extract(ctx) {
    const items = contactSubjects(ctx.dataset).map((s) => extractCard(ctx.dataset, s));
    // Stable, human order: by name, then IRI as a deterministic tie-break.
    items.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { items };
  },
};
