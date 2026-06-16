// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Profile typed-view (design: `docs/typed-data-views.md` §4; extends P1).
 *
 * A WebID/profile document (`foaf:Person`) is the richest "who you are" shape PM
 * understands — name, avatar, nickname, a short bio, and a homepage. The
 * Contacts card (priority 70) renders a `foaf:Person` as a minimal contact ROW
 * (name + avatar + email/phone), but a profile document deserves the fuller
 * profile snippet. So this viewer sits at priority **80** — ABOVE Contacts.
 *
 * **Primary-subject scoping (roborev SEC/correctness).** Many documents embed a
 * `foaf:Person` that is NOT the document's subject — a `schema:author`, an
 * artist, an issue `wf:assignee`. Matching *any* embedded person at priority 80
 * would hijack such a document and render it as a Profile card instead of its
 * real typed view. So this viewer matches ONLY when the person is the resource's
 * **primary subject**: the document URL itself or a fragment of it (`#me`,
 * `#it`, …) — the WebID-profile convention. An embedded foreign-IRI person never
 * matches, so e.g. an Issue with an assignee still selects the Issue card. A
 * plain `vcard:Individual` contact also never matches (disjoint class) and still
 * falls to Contacts.
 *
 * **Scheme alignment (roborev correctness).** `ProfileAgent` reads the
 * `http://schema.org/` predicate scheme, so this viewer matches `foaf:Person`
 * (canonical, always readable via `foaf:name`) and `http://schema.org/Person`
 * (the scheme the agent reads), NOT `https://schema.org/Person` — which would
 * match but then lose its `https://schema.org/*` fields. A profile minted with
 * the https scheme keeps the generic table until ProfileAgent reads both schemes
 * (a follow-up in @solid/object, the agent's home).
 *
 * Read goes through `ProfileAgent` (the bundled `@solid/object` reference class)
 * — never hand-built quads. `ProfileAgent.displayName` always returns a
 * non-empty string (it falls back to the WebID IRI), so the card never shows a
 * blank name.
 *
 * Pure: extracts a plain `{ items: ProfileSnippet[] }` model the React card
 * renders as an avatar + name + bio + a "Visit homepage" action; the homepage is
 * surfaced as a safe outbound link, never as a raw data row (§5).
 */
import type { DatasetCore, Quad } from "@rdfjs/types";
import { DataFactory } from "n3";
import { ProfileAgent } from "../profile-agent.js";
import { safeLinkHref } from "../pod-scope.js";
import type { TypedViewer, ViewerContext } from "./types.js";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const FOAF = "http://xmlns.com/foaf/0.1/";
/** ProfileAgent reads the `http://schema.org/` scheme — match only what it reads. */
const SCHEMA_HTTP = "http://schema.org/";

/**
 * The person classes a profile subject may carry. `https://schema.org/Person` is
 * deliberately EXCLUDED: `ProfileAgent` only reads `http://schema.org/`
 * predicates, so matching the https scheme would render a fieldless profile.
 */
const PERSON_CLASSES = new Set<string>([`${FOAF}Person`, `${SCHEMA_HTTP}Person`]);

/** A single profile ready to render — plain + serialisable, no RDF terms. */
export interface ProfileSnippet {
  /** The WebID/subject IRI (stable React key; shown compactly, never auto-linked). */
  id: string;
  /** Display name via the `ProfileAgent` fallback chain; never empty. */
  name: string;
  /** Remote avatar IRI if the subject carries one. */
  avatarUrl?: string;
  /** Nickname (`foaf:nick`/`vcard:nickname`). */
  nickname?: string;
  /** Short bio (`vcard:note`/`schema:description`). */
  bio?: string;
  /** A safe http(s) homepage href for a "Visit homepage" action; else undefined. */
  homepage?: string;
}

/** The Profile view-model: a list of snippets over every matching subject. */
export interface ProfileModel {
  items: ProfileSnippet[];
}

/**
 * Is `subject` the resource's PRIMARY subject — the document URL itself or a
 * fragment of it? A WebID profile is `<doc>#me`; a first-party single-resource
 * document is `<doc>#it` or `<doc>`. An embedded person carried under a foreign
 * IRI (an author/artist/assignee) is NOT primary and so never matches.
 */
function isPrimarySubject(subject: string, url: string): boolean {
  if (subject === url) return true;
  const hash = url.indexOf("#");
  const docUrl = hash === -1 ? url : url.slice(0, hash);
  if (subject === docUrl) return true;
  // A fragment OF this document: same path before '#'.
  const subHash = subject.indexOf("#");
  if (subHash === -1) return false;
  return subject.slice(0, subHash) === docUrl;
}

/** Does the resource's primary subject carry a person class? */
function hasProfileSubject(ctx: ViewerContext): boolean {
  for (const quad of ctx.dataset as Iterable<Quad>) {
    if (
      quad.predicate.value === RDF_TYPE &&
      quad.subject.termType === "NamedNode" &&
      quad.object.termType === "NamedNode" &&
      PERSON_CLASSES.has(quad.object.value) &&
      isPrimarySubject(quad.subject.value, ctx.url)
    ) {
      return true;
    }
  }
  return false;
}

/** Collect the PRIMARY-subject IRIs that are profiles (typed person subjects). */
function profileSubjects(dataset: DatasetCore, url: string): string[] {
  const subjects = new Set<string>();
  for (const quad of dataset as Iterable<Quad>) {
    if (quad.subject.termType !== "NamedNode") continue; // skip blank nodes
    if (
      quad.predicate.value === RDF_TYPE &&
      quad.object.termType === "NamedNode" &&
      PERSON_CLASSES.has(quad.object.value) &&
      isPrimarySubject(quad.subject.value, url)
    ) {
      subjects.add(quad.subject.value);
    }
  }
  return [...subjects];
}

/** The first safe http(s) homepage URL, or undefined. */
function safeHomepage(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const safe = safeLinkHref(raw);
  if (!safe) return undefined;
  try {
    const proto = new URL(safe).protocol;
    if (proto === "http:" || proto === "https:") return safe;
  } catch {
    // not a navigable absolute URL — skip
  }
  return undefined;
}

/** Extract one snippet from a profile subject, reusing `ProfileAgent` chains. */
function extractProfile(dataset: DatasetCore, subject: string): ProfileSnippet {
  const agent = new ProfileAgent(subject, dataset, DataFactory);
  return {
    id: subject,
    name: agent.displayName, // never empty — falls back to the WebID IRI
    avatarUrl: agent.avatarUrl,
    nickname: agent.nickname,
    bio: agent.bio,
    homepage: safeHomepage(agent.homepage),
  };
}

/**
 * The Profile {@link TypedViewer}. Priority **80** — above Contacts (70) so a
 * profile document gets the richer snippet card; a plain vcard contact (which
 * this viewer doesn't match) still falls to Contacts (§4.4).
 */
export const profileViewer: TypedViewer<ProfileModel> = {
  id: "profile",
  priority: 80,
  matches: hasProfileSubject,
  extract(ctx) {
    const items = profileSubjects(ctx.dataset, ctx.url).map((s) =>
      extractProfile(ctx.dataset, s),
    );
    // Stable, human order: by name, then IRI as a deterministic tie-break.
    items.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { items };
  },
};
