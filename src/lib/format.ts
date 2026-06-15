/**
 * Small presentation formatters (pure, no RDF). Kept in `lib/` because they are
 * shared, framework-free, and unit-testable.
 */

/** Human-readable byte size: 1536 → "1.5 KB". */
export function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined || Number.isNaN(bytes)) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** Relative-ish date label from an ISO string: "2 days ago" / a calendar date. */
export function formatModified(iso: string | undefined, now: Date = new Date()): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  const diffMs = now.getTime() - date.getTime();
  const day = 86_400_000;
  if (diffMs < 0) return formatDate(date);
  if (diffMs < day) return "today";
  if (diffMs < 2 * day) return "yesterday";
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)} days ago`;
  return formatDate(date);
}

/** A short, readable calendar date, e.g. "1 Jul 2026" (locale-formatted). */
export function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Human time of day, e.g. "9:00 AM" — locale-formatted. */
export function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Full, readable date + time for an event detail, e.g. "Wed, 1 Jul 2026, 10:00". */
export function formatDateTime(date: Date): string {
  return date.toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Format a `Date` for an `<input type="datetime-local">` value (the control
 * needs local wall-clock `YYYY-MM-DDTHH:mm`, never a UTC `Z` string).
 */
export function toDateTimeLocal(date: Date | undefined): string {
  if (!date || Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/**
 * Parse a `datetime-local` input value (local wall-clock) into a `Date`.
 * Returns `undefined` for empty/invalid input.
 */
export function fromDateTimeLocal(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
