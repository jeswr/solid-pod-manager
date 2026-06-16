// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * The deployed pod-app subdomains — the standalone Solid apps (Pod Drive, Pod
 * Photos, …) that live alongside the Pod Manager on `solid-test.jeswr.org`.
 *
 * The Pod Manager is the hub; each of these is a focused app over the same pod.
 * Data pages here deep-link ("Open in Pod Drive") to the matching app so the
 * user can jump from "see what's in my pod" to "work with it in the app".
 *
 * Each URL is overridable at BUILD time via `NEXT_PUBLIC_POD_APP_<KEY>_URL`
 * (e.g. `NEXT_PUBLIC_POD_APP_DRIVE_URL`) — `NEXT_PUBLIC_*` vars are inlined by
 * Next at build, so this resolves to a static string in the export. When the
 * override is unset, the production subdomain is the fallback. Keep the env
 * reads as direct `process.env.NEXT_PUBLIC_POD_APP_*` property accesses (not a
 * computed key) so Next's static replacement can see and inline them.
 */

/** The pod-app keys, one per deployed subdomain. */
export type PodAppKey =
  | "drive"
  | "photos"
  | "music"
  | "health"
  | "docs"
  | "money"
  | "mail"
  | "chat"
  | "issues";

/** Human-facing app names — used for the launcher label ("Open in Pod Drive"). */
export const POD_APP_LABEL: Record<PodAppKey, string> = {
  drive: "Pod Drive",
  photos: "Pod Photos",
  music: "Pod Music",
  health: "Pod Health",
  docs: "Pod Docs",
  money: "Pod Money",
  mail: "Pod Mail",
  chat: "Pod Chat",
  issues: "Solid Issues",
};

/**
 * The production subdomains. The fallback when no env override is set. These are
 * the canonical homes of the deployed apps on the live host.
 */
const POD_APP_DEFAULT_URL: Record<PodAppKey, string> = {
  drive: "https://drive.solid-test.jeswr.org",
  photos: "https://photos.solid-test.jeswr.org",
  music: "https://music.solid-test.jeswr.org",
  health: "https://health.solid-test.jeswr.org",
  docs: "https://docs.solid-test.jeswr.org",
  money: "https://money.solid-test.jeswr.org",
  mail: "https://mail.solid-test.jeswr.org",
  chat: "https://chat.solid-test.jeswr.org",
  issues: "https://issues.solid-test.jeswr.org",
};

/**
 * The resolved app → URL map. Each entry prefers the build-time
 * `NEXT_PUBLIC_POD_APP_<KEY>_URL` override and falls back to the production
 * subdomain. The env reads are spelled out per key (not a `process.env[...]`
 * dynamic index) so Next can statically inline each one into the export.
 */
export const POD_APP_URL: Record<PodAppKey, string> = {
  drive: process.env.NEXT_PUBLIC_POD_APP_DRIVE_URL || POD_APP_DEFAULT_URL.drive,
  photos: process.env.NEXT_PUBLIC_POD_APP_PHOTOS_URL || POD_APP_DEFAULT_URL.photos,
  music: process.env.NEXT_PUBLIC_POD_APP_MUSIC_URL || POD_APP_DEFAULT_URL.music,
  health: process.env.NEXT_PUBLIC_POD_APP_HEALTH_URL || POD_APP_DEFAULT_URL.health,
  docs: process.env.NEXT_PUBLIC_POD_APP_DOCS_URL || POD_APP_DEFAULT_URL.docs,
  money: process.env.NEXT_PUBLIC_POD_APP_MONEY_URL || POD_APP_DEFAULT_URL.money,
  mail: process.env.NEXT_PUBLIC_POD_APP_MAIL_URL || POD_APP_DEFAULT_URL.mail,
  chat: process.env.NEXT_PUBLIC_POD_APP_CHAT_URL || POD_APP_DEFAULT_URL.chat,
  issues: process.env.NEXT_PUBLIC_POD_APP_ISSUES_URL || POD_APP_DEFAULT_URL.issues,
};

/** The launch URL + label for a pod-app key. */
export interface PodApp {
  readonly key: PodAppKey;
  readonly label: string;
  readonly url: string;
}

/** Resolve a pod-app key to its `{ key, label, url }`. */
export function podApp(key: PodAppKey): PodApp {
  return { key, label: POD_APP_LABEL[key], url: POD_APP_URL[key] };
}

/**
 * The launch URL for a pod app, carrying the signed-in user's WebID so the
 * target app can auto-authenticate (the media-kraken#54 autologin pattern).
 *
 * When `webId` is given, the WebID is appended as the `#autologin/<webId>`
 * fragment — the target app strips the `#autologin/` prefix and
 * `decodeURIComponent`s the rest. The WebID is URL-encoded so its own `#me`
 * fragment (and any other reserved chars) cannot break the launch URL. When no
 * `webId` is given (signed out), the bare app URL is returned — a plain link,
 * no fragment.
 *
 * The fragment is never sent to the server (browsers don't transmit the hash),
 * so the WebID stays client-side; do not log it.
 */
export function podAppLaunchUrl(key: PodAppKey, webId?: string): string {
  const url = POD_APP_URL[key];
  return webId ? `${url}#autologin/${encodeURIComponent(webId)}` : url;
}

/**
 * Which pod apps a data category maps to. A category page renders an "Open in
 * <app>" launcher for each key here — Media surfaces BOTH Photos and Music, so
 * the value is a list. A category with no matching app (Calendar, Contacts, …)
 * is simply absent from the map and shows no launcher.
 *
 * Keys are the category ids from {@link file://./categories.ts}.
 */
export const CATEGORY_POD_APPS: Readonly<Record<string, readonly PodAppKey[]>> = {
  media: ["photos", "music"],
  finance: ["money"],
  health: ["health"],
  documents: ["docs"],
};

/** The pod apps for a category id, in display order (empty when none map). */
export function podAppsForCategory(categoryId: string): PodApp[] {
  return (CATEGORY_POD_APPS[categoryId] ?? []).map(podApp);
}
