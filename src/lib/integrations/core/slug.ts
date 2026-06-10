/**
 * Deterministic, URI-safe fragment ids for imported records.
 *
 * Export rows rarely carry a stable id, so we derive a fragment from the
 * record's natural key (title+date, order id, …). The fragment must be
 * URI-safe (AGENTS.md: a `:` in a name breaks ACL matching) and stable across
 * re-imports (idempotency). We slugify the readable part for debuggability and
 * append a short FNV-1a hash of the full key to keep distinct records distinct.
 */

/** Lowercase, hyphenated, ASCII-only slug of up to 48 chars (may be empty). */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

/** FNV-1a (32-bit) hex of a string — a stable short discriminator. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * A stable fragment id for a record: a readable slug of `label` plus a hash of
 * `key` (defaults to `label`). Always non-empty and URI-safe.
 */
export function recordFragment(label: string, key: string = label): string {
  const base = slugify(label);
  const hash = fnv1a(key);
  return base ? `${base}-${hash}` : hash;
}
