/**
 * The data taxonomy — a fixed two-tier category set (DESIGN.md §3, R3).
 *
 * Inspired by the 1Password item-category IA: a short **Common** tier the
 * user sees first, above a longer **Other** tail. Categories are presented to
 * the user; the underlying pod paths / RDF classes never are (Product
 * principle 2: plain language, never jargon).
 *
 * Each category declares the RDF classes that, when registered in the pod's
 * Type Index (`solid:forClass`), mean "this category has data". The mapping is
 * the bridge between Solid's class-based discovery and the human taxonomy.
 *
 * Open question Q1 (DESIGN.md §13): the exact common-tier set wants user
 * validation. This is the proposed set, kept in one place so it is trivial to
 * revise.
 */

/** A Lucide icon name — resolved to a component in the UI layer only. */
export type CategoryIconName =
  | "user-round"
  | "contact-round"
  | "heart-pulse"
  | "wallet"
  | "calendar"
  | "image"
  | "briefcase"
  | "car-front"
  | "file-text"
  | "boxes";

/** Which tier a category lives in. */
export type CategoryTier = "common" | "other";

export interface DataCategory {
  /** Stable id, used in routes (`/my-data/[category]`). URL-safe. */
  readonly id: string;
  /** Human label shown in the UI. */
  readonly label: string;
  /** One-sentence privacy assurance shown on the category (DESIGN.md §6, R6). */
  readonly assurance: string;
  /** Short description for empty states / tooltips. */
  readonly description: string;
  readonly tier: CategoryTier;
  readonly icon: CategoryIconName;
  /**
   * RDF class IRIs that map to this category. A Type-Index registration
   * `solid:forClass` matching any of these places its data here.
   */
  readonly classes: readonly string[];
}

const SCHEMA = "https://schema.org/";
const SCHEMA_HTTP = "http://schema.org/";
const VCARD = "http://www.w3.org/2006/vcard/ns#";
const FOAF = "http://xmlns.com/foaf/0.1/";
const BOOKMARK = "http://www.w3.org/2002/01/bookmark#";

/**
 * The canonical category list. Order within each tier is the display order.
 * `classes` lists both the `https://schema.org/` and legacy `http://schema.org/`
 * forms because pods in the wild use either.
 */
export const CATEGORIES: readonly DataCategory[] = [
  // ── Common tier ─────────────────────────────────────────────────────────
  {
    id: "identity",
    label: "Identity",
    tier: "common",
    icon: "user-round",
    assurance: "Your core profile. Your basic identity is public by design on Solid.",
    description: "Your name, photo, and the basics of who you are.",
    classes: [`${FOAF}Person`, `${SCHEMA}Person`, `${SCHEMA_HTTP}Person`, `${VCARD}Individual`],
  },
  {
    id: "contacts",
    label: "Contacts",
    tier: "common",
    icon: "contact-round",
    assurance: "Only apps you approve can read your contacts.",
    description: "People and address books you keep in your pod.",
    classes: [`${VCARD}AddressBook`, `${VCARD}Contact`, `${SCHEMA}Person`, `${FOAF}Person`],
  },
  {
    id: "health",
    label: "Health",
    tier: "common",
    icon: "heart-pulse",
    assurance: "Only apps you approve can read your health data.",
    description: "Measurements, conditions, and activity you track.",
    classes: [
      `${SCHEMA}MedicalEntity`,
      `${SCHEMA_HTTP}MedicalEntity`,
      `${SCHEMA}HealthValue`,
      "http://www.w3.org/2006/time#Instant",
    ],
  },
  {
    id: "finance",
    label: "Finance",
    tier: "common",
    icon: "wallet",
    assurance: "Only apps you approve can read your financial data.",
    description: "Accounts, transactions, and invoices.",
    classes: [`${SCHEMA}Invoice`, `${SCHEMA_HTTP}Invoice`, `${SCHEMA}MonetaryAmount`, `${SCHEMA}BankAccount`],
  },
  {
    id: "calendar",
    label: "Calendar",
    tier: "common",
    icon: "calendar",
    assurance: "Only apps you approve can read your calendar.",
    description: "Events and appointments.",
    classes: [
      `${SCHEMA}Event`,
      `${SCHEMA_HTTP}Event`,
      "http://www.w3.org/2002/12/cal/ical#Vevent",
      "http://www.w3.org/2002/12/cal/icaltzd#Vevent",
    ],
  },
  {
    id: "media",
    label: "Media",
    tier: "common",
    icon: "image",
    assurance: "Only apps you approve can read your media.",
    description: "Photos, videos, and audio you store.",
    classes: [
      `${SCHEMA}ImageObject`,
      `${SCHEMA}VideoObject`,
      `${SCHEMA}AudioObject`,
      `${SCHEMA}MediaObject`,
      `${SCHEMA_HTTP}ImageObject`,
    ],
  },
  // ── Other / tail tier ───────────────────────────────────────────────────
  {
    id: "work-education",
    label: "Work & education",
    tier: "other",
    icon: "briefcase",
    assurance: "Only apps you approve can read your work and education data.",
    description: "Roles, organisations, and qualifications.",
    classes: [`${SCHEMA}Organization`, `${SCHEMA}EducationalOrganization`, `${SCHEMA}JobPosting`],
  },
  {
    id: "mobility",
    label: "Mobility",
    tier: "other",
    icon: "car-front",
    assurance: "Only apps you approve can read your mobility data.",
    description: "Trips, vehicles, and journeys.",
    classes: [`${SCHEMA}Trip`, `${SCHEMA}Vehicle`, `${SCHEMA}TravelAction`],
  },
  {
    id: "documents",
    label: "Documents",
    tier: "other",
    icon: "file-text",
    assurance: "Only apps you approve can read your documents.",
    description: "Notes, files, and bookmarks.",
    classes: [
      `${SCHEMA}TextDigitalDocument`,
      `${SCHEMA}DigitalDocument`,
      `${SCHEMA_HTTP}TextDigitalDocument`,
      `${BOOKMARK}Bookmark`,
    ],
  },
] as const;

/** The fallback bucket for registered classes we don't recognise. */
export const UNCATEGORISED: DataCategory = {
  id: "other",
  label: "Other data",
  tier: "other",
  icon: "boxes",
  assurance: "Only apps you approve can read this data.",
  description: "Data in your pod that doesn't fit a known category yet.",
  classes: [],
};

const BY_ID = new Map<string, DataCategory>(
  [...CATEGORIES, UNCATEGORISED].map((c) => [c.id, c]),
);

const BY_CLASS = new Map<string, DataCategory>();
for (const category of CATEGORIES) {
  for (const cls of category.classes) {
    // First category to claim a class wins (order = priority). Identity is
    // listed first, so a bare foaf:Person profile maps to Identity, not Contacts.
    if (!BY_CLASS.has(cls)) BY_CLASS.set(cls, category);
  }
}

/** Categories in the Common tier, in display order. */
export function commonCategories(): DataCategory[] {
  return CATEGORIES.filter((c) => c.tier === "common");
}

/** Categories in the Other tier, in display order. */
export function otherCategories(): DataCategory[] {
  return CATEGORIES.filter((c) => c.tier === "other");
}

/** Look up a category by its route id (includes the `other` fallback). */
export function categoryById(id: string): DataCategory | undefined {
  return BY_ID.get(id);
}

/**
 * Map an RDF class IRI to its category. Unknown classes fall back to the
 * {@link UNCATEGORISED} bucket so discovered-but-unrecognised data is never
 * silently dropped.
 */
export function categoryForClass(classIri: string): DataCategory {
  return BY_CLASS.get(classIri) ?? UNCATEGORISED;
}
