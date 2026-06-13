// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Profile editing — read + edit the user's WebID profile *document* (the card).
 *
 * The read side (`profile.ts` + `ProfileAgent`) renders a profile as it appears
 * to others; this module adds the **write** side: a bounded set of editable
 * display fields, written back via a read-modify-write that preserves every
 * triple this app does not own (house rule: never clobber the document, never
 * hand-build quads — all mutation goes through typed `@rdfjs/wrapper`
 * accessors).
 *
 * What we edit (the WebID subject of the card):
 *   - name        — `vcard:fn` + `foaf:name` (kept in step so both ecosystems read it)
 *   - nickname    — `foaf:nick`
 *   - photo       — `vcard:hasPhoto` (IRI)
 *   - role        — `vcard:role`
 *   - organisation— `vcard:organization-name`
 *   - pronouns    — `solid:preferredPronouns` (free-text)
 *   - description — `vcard:note`
 *   - homepage    — `foaf:homepage` (IRI)
 *
 * What we DELIBERATELY do not edit:
 *   - the WebID itself / identity claims. Per ADR-0004 the `webid` is an
 *     admin-controlled Keycloak attribute, not a user-writable profile triple;
 *     this editor never mints or rewrites the WebID subject IRI.
 *   - `pim:storage`, `solid:oidcIssuer`, `solid:*TypeIndex`, `ldp:inbox` —
 *     power-user pointers managed elsewhere (type-index UI / server). The
 *     read-modify-write preserves them untouched.
 *
 * `foaf:knows` (the social graph) is handled in `social.ts`, which shares the
 * same read-modify-write discipline against the card.
 */
import {
  LiteralAs,
  LiteralFrom,
  NamedNodeAs,
  NamedNodeFrom,
  OptionalAs,
  OptionalFrom,
  TermWrapper,
} from "@rdfjs/wrapper";
import { DataFactory } from "n3";
import { freshRdf } from "./rdf-read.js";
import { writeResource } from "./pod-data.js";

const FOAF = "http://xmlns.com/foaf/0.1/";
const VCARD = "http://www.w3.org/2006/vcard/ns#";
const SOLID = "http://www.w3.org/ns/solid/terms#";

/** Turtle prefixes for a readable profile document. */
export const PROFILE_PREFIXES = {
  foaf: FOAF,
  vcard: VCARD,
  solid: SOLID,
} as const;

/** The editable profile fields, as the UI works with them (plain strings). */
export interface EditableProfile {
  name: string;
  nickname?: string;
  /** Photo IRI (`vcard:hasPhoto`). */
  photo?: string;
  role?: string;
  organisation?: string;
  pronouns?: string;
  description?: string;
  /** Homepage IRI (`foaf:homepage`). */
  homepage?: string;
}

/**
 * Typed read/write view of the WebID subject in the profile card. Only the
 * editable fields are exposed; everything else on the subject is left alone.
 */
export class ProfileCard extends TermWrapper {
  get vcardFn(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${VCARD}fn`, LiteralAs.string);
  }
  set vcardFn(v: string | undefined) {
    OptionalAs.object(this, `${VCARD}fn`, v, LiteralFrom.string);
  }
  get foafName(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${FOAF}name`, LiteralAs.string);
  }
  set foafName(v: string | undefined) {
    OptionalAs.object(this, `${FOAF}name`, v, LiteralFrom.string);
  }
  get nickname(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${FOAF}nick`, LiteralAs.string);
  }
  set nickname(v: string | undefined) {
    OptionalAs.object(this, `${FOAF}nick`, v, LiteralFrom.string);
  }
  get photo(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${VCARD}hasPhoto`, NamedNodeAs.string);
  }
  set photo(v: string | undefined) {
    OptionalAs.object(this, `${VCARD}hasPhoto`, v, NamedNodeFrom.string);
  }
  get role(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${VCARD}role`, LiteralAs.string);
  }
  set role(v: string | undefined) {
    OptionalAs.object(this, `${VCARD}role`, v, LiteralFrom.string);
  }
  get organisation(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${VCARD}organization-name`, LiteralAs.string);
  }
  set organisation(v: string | undefined) {
    OptionalAs.object(this, `${VCARD}organization-name`, v, LiteralFrom.string);
  }
  get pronouns(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${SOLID}preferredPronouns`, LiteralAs.string);
  }
  set pronouns(v: string | undefined) {
    OptionalAs.object(this, `${SOLID}preferredPronouns`, v, LiteralFrom.string);
  }
  get description(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${VCARD}note`, LiteralAs.string);
  }
  set description(v: string | undefined) {
    OptionalAs.object(this, `${VCARD}note`, v, LiteralFrom.string);
  }
  get homepage(): string | undefined {
    return OptionalFrom.subjectPredicate(this, `${FOAF}homepage`, NamedNodeAs.string);
  }
  set homepage(v: string | undefined) {
    OptionalAs.object(this, `${FOAF}homepage`, v, NamedNodeFrom.string);
  }
}

/** Trim to `undefined` so empty form fields clear the triple rather than writing "". */
function clean(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/** The profile *document* URL a WebID lives in (fragment stripped). */
export function profileDocUrl(webId: string): string {
  const u = new URL(webId);
  u.hash = "";
  return u.toString();
}

/** Read the editable fields off an already-parsed profile dataset (pure). */
export function readEditableProfile(
  webId: string,
  dataset: import("@rdfjs/types").DatasetCore,
): EditableProfile {
  const card = new ProfileCard(webId, dataset, DataFactory);
  // Name display follows the read fallback chain (vcard:fn → foaf:name) so the
  // form is pre-filled even on a card that only carries one of them.
  return {
    name: card.vcardFn ?? card.foafName ?? "",
    nickname: card.nickname,
    photo: card.photo,
    role: card.role,
    organisation: card.organisation,
    pronouns: card.pronouns,
    description: card.description,
    homepage: card.homepage,
  };
}

/**
 * Apply the editable fields onto the WebID subject of a profile dataset,
 * in place. Empty fields clear their triple; name is written to BOTH `vcard:fn`
 * and `foaf:name` so every reader (Solid + FOAF apps) sees it. Pure mutation —
 * the caller owns the I/O.
 */
export function applyEditableProfile(
  webId: string,
  dataset: import("@rdfjs/types").DatasetCore,
  edit: EditableProfile,
): void {
  const card = new ProfileCard(webId, dataset, DataFactory);
  const name = clean(edit.name);
  card.vcardFn = name;
  card.foafName = name;
  card.nickname = clean(edit.nickname);
  card.photo = clean(edit.photo);
  card.role = clean(edit.role);
  card.organisation = clean(edit.organisation);
  card.pronouns = clean(edit.pronouns);
  card.description = clean(edit.description);
  card.homepage = clean(edit.homepage);
}

/**
 * Fetch the profile card, returning the editable fields + the document URL +
 * ETag (for a later conditional write).
 *
 * @param fetchImpl - test-only override; **omit in production** so the
 *   auth-patched global fetch runs (AGENTS.md §Reading data).
 */
export async function fetchEditableProfile(
  webId: string,
  fetchImpl?: typeof fetch,
): Promise<{ profile: EditableProfile; docUrl: string; etag: string | null }> {
  const docUrl = profileDocUrl(webId);
  const { dataset, etag } = await freshRdf(docUrl, fetchImpl);
  return { profile: readEditableProfile(webId, dataset), docUrl, etag };
}

/**
 * Save edited profile fields back to the card with a read-modify-write that
 * detects concurrent edits.
 *
 * Re-reads the document fresh so the write preserves every triple this app
 * does not own, then conditionally PUTs with `If-Match` set to the **ETag the
 * editor loaded** (`opts.etag`) — NOT the just-re-read ETag. That distinction
 * is what makes a concurrent edit fail: if another client changed the card
 * after this editor opened, the loaded ETag no longer matches the server's and
 * the PUT returns 412 instead of silently clobbering their change. A 412
 * (concurrent edit) or 403 (no write access) surfaces as `ResourceWriteError`
 * with `.status` — the UI re-reads on 412 and explains permissions on 403.
 *
 * When `opts.etag` is absent (e.g. the card had no ETag), the re-read ETag is
 * used as a best-effort guard.
 *
 * @param fetchImpl - test-only override; omit in production.
 */
export async function saveProfile(opts: {
  webId: string;
  edit: EditableProfile;
  /** The ETag from the read the editor was working against (concurrency guard). */
  etag?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<{ etag: string | null }> {
  const { webId, edit, fetchImpl } = opts;
  const docUrl = profileDocUrl(webId);
  const { dataset, etag: freshEtag } = await freshRdf(docUrl, fetchImpl);
  applyEditableProfile(webId, dataset, edit);
  return writeResource(docUrl, dataset, {
    // Prefer the caller's loaded ETag so a change since load triggers a 412.
    etag: opts.etag !== undefined ? opts.etag : freshEtag,
    fetchImpl,
    prefixes: PROFILE_PREFIXES,
  });
}
