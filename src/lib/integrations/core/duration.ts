/** Format a number of seconds as an ISO-8601 duration (`PT1H30M`, `PT45S`). */
export function isoDurationFromSeconds(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const body = `${h > 0 ? `${h}H` : ""}${m > 0 ? `${m}M` : ""}${sec > 0 || (h === 0 && m === 0) ? `${sec}S` : ""}`;
  return `PT${body}`;
}

/** Format a number of minutes as an ISO-8601 duration. */
export function isoDurationFromMinutes(minutes: number): string {
  return isoDurationFromSeconds(minutes * 60);
}
