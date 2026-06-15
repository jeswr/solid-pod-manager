// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Per-typed-view edit maps (Wave 5 §1). For each #61 typed view
 * (contacts/music/photo/event/bookmark) this declares the field→predicate
 * bindings that make its extracted fields editable IN PLACE. Each map mirrors
 * exactly the predicates the matching extractor reads (so what you see is what
 * you edit) and the shapes the first-party stores write
 * (`contacts.ts`, `vocab.ts`) — keeping a round-trip re-readable by the same
 * extractor and by other Solid apps.
 *
 * The maps are keyed by the typed-viewer `id` (the same ids the registry uses),
 * so the editable-card wrapper can look up "how do I edit a <contacts> subject"
 * with one call. Pure + node-testable; the writer (`subject-edit.ts`) turns a
 * field + value into quads, and `EditableField` renders the widget.
 *
 * Scheme note: extractors accept both `https://schema.org/` and the legacy
 * `http://` form for *reading*, but on WRITE we always emit the `https://`
 * canonical predicate (matching `vocab.ts` `SCHEMA`), so edits converge the data
 * onto one vocabulary without disturbing the rest of the document.
 */
import { SCHEMA } from "../integrations/core/vocab.js";
import { type FieldSpec, normaliseField } from "./field-types.js";

const VCARD = "http://www.w3.org/2006/vcard/ns#";
const BOOKMARK = "http://www.w3.org/2002/01/bookmark#";
const DCT = "http://purl.org/dc/terms/";

/** Build a normalised field from a partial declaration (fills id + datatype). */
function f(spec: Omit<FieldSpec, "id"> & { id?: string }): FieldSpec {
  return normaliseField(spec);
}

/** Contacts (`vcard:Individual`) — mirrors `contacts.ts` + `contacts-view.ts`. */
export const CONTACT_FIELDS: readonly FieldSpec[] = [
  f({ label: "Name", predicate: `${VCARD}fn`, kind: "text", mode: "literal", required: true }),
  f({ label: "Email", predicate: `${VCARD}hasEmail`, kind: "email", mode: "mailto" }),
  f({ label: "Phone", predicate: `${VCARD}hasTelephone`, kind: "tel", mode: "tel" }),
  f({ label: "Note", predicate: `${VCARD}note`, kind: "textarea", mode: "literal" }),
];

/** Music (`schema:MusicRecording`) — mirrors `music-view.ts` + `vocab.ts`. */
export const MUSIC_FIELDS: readonly FieldSpec[] = [
  f({ label: "Title", predicate: `${SCHEMA}name`, kind: "text", mode: "literal", required: true }),
  f({ label: "Artist", predicate: `${SCHEMA}byArtist`, kind: "text", mode: "literal" }),
  f({ label: "Album", predicate: `${SCHEMA}inAlbum`, kind: "text", mode: "literal" }),
  f({
    label: "Duration",
    predicate: `${SCHEMA}duration`,
    kind: "text",
    mode: "literal",
    hint: "ISO-8601, e.g. PT3M33S",
  }),
];

/** Photo (`schema:ImageObject`) — mirrors `photo-view.ts` + `vocab.ts`. */
export const PHOTO_FIELDS: readonly FieldSpec[] = [
  f({ label: "Title", predicate: `${SCHEMA}name`, kind: "text", mode: "literal" }),
  f({ label: "Image URL", predicate: `${SCHEMA}contentUrl`, kind: "url", mode: "iri" }),
  f({ label: "Width", predicate: `${SCHEMA}width`, kind: "number", mode: "literal" }),
  f({ label: "Height", predicate: `${SCHEMA}height`, kind: "number", mode: "literal" }),
];

/** Event (`schema:Event`) — mirrors `event-view.ts` + `vocab.ts` (CalendarEvent). */
export const EVENT_FIELDS: readonly FieldSpec[] = [
  f({ label: "Title", predicate: `${SCHEMA}name`, kind: "text", mode: "literal", required: true }),
  f({ label: "Starts", predicate: `${SCHEMA}startDate`, kind: "datetime", mode: "literal" }),
  f({ label: "Ends", predicate: `${SCHEMA}endDate`, kind: "datetime", mode: "literal" }),
  f({ label: "Location", predicate: `${SCHEMA}location`, kind: "text", mode: "literal" }),
  f({ label: "Description", predicate: `${SCHEMA}description`, kind: "textarea", mode: "literal" }),
];

/** Bookmark (`bookmark:Bookmark`) — mirrors `bookmark-view.ts`. */
export const BOOKMARK_FIELDS: readonly FieldSpec[] = [
  f({ label: "Title", predicate: `${DCT}title`, kind: "text", mode: "literal", required: true }),
  f({ label: "Link", predicate: `${BOOKMARK}recalls`, kind: "url", mode: "iri", required: true }),
];

/** The edit map by typed-viewer id (the keys `registry.tsx` selects on). */
export const EDIT_MAP: Readonly<Record<string, readonly FieldSpec[]>> = {
  contacts: CONTACT_FIELDS,
  music: MUSIC_FIELDS,
  photo: PHOTO_FIELDS,
  event: EVENT_FIELDS,
  bookmark: BOOKMARK_FIELDS,
};

/** The fields for a typed-viewer id, or `undefined` if the view isn't editable. */
export function editFieldsFor(viewerId: string): readonly FieldSpec[] | undefined {
  return EDIT_MAP[viewerId];
}
