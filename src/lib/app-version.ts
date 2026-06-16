// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * The build identifier attached to user feedback (the shared
 * {@link https://github.com/jeswr/app-shell `@jeswr/app-shell`} `FeedbackButton`
 * stamps it into the issue's diagnostics so a report can be tied to a build).
 *
 * Prefer the deploy's git SHA, set at BUILD time via `NEXT_PUBLIC_BUILD_SHA`
 * — `NEXT_PUBLIC_*` vars are inlined by Next at build, so this resolves to a
 * static string in the static export. Keep the read as a direct
 * `process.env.NEXT_PUBLIC_BUILD_SHA` property access (not a computed key) so
 * Next's static replacement can see and inline it. When the SHA is unset (local
 * dev / a build that doesn't pass one), fall back to the package version so the
 * value is always a sensible, non-empty string.
 */
const PACKAGE_VERSION = "0.1.0";

export const APP_VERSION: string =
  process.env.NEXT_PUBLIC_BUILD_SHA || PACKAGE_VERSION;
