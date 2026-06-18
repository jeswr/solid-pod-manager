// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Upload a chosen image file into the user's pod and make it readable as their
 * profile picture (bugs #12 / #13 — the profile editor previously only accepted
 * a pasted http URL, with no way to upload a local image).
 *
 * The flow, kept here as one testable unit (the profile page is thin UI over
 * it):
 *
 *   1. PUT the image bytes to `<storage>/profile/avatar.<ext>` (the extension
 *      tracks the chosen image type so the byte-stream is served honestly) with
 *      the file's own MIME type, via the existing `files` write path. We OVERWRITE
 *      (no create-only), unlike the files-browser uploads.
 *   2. Delete any STALE `avatar.*` variants left from a previous upload of a
 *      different image type (e.g. a prior `avatar.jpg` when this upload writes
 *      `avatar.png`) so a type change never orphans the old public picture
 *      (roborev). Best-effort: a delete failure never fails the upload.
 *   3. Grant PUBLIC read on the new resource through the typed sharing backend
 *      (`acl:Read` for `foaf:Agent`) so the picture renders for anyone viewing
 *      the profile — a profile photo is, by intent, public-facing. We NEVER
 *      hand-build ACL triples; the typed backend owns that. A pod whose
 *      access-control model the backend does not support (ACP `.acr`) or any ACL
 *      write failure is reported via {@link UploadProfilePhotoResult} — NOT
 *      silently dropped — so the caller can tell the user the picture may not yet
 *      be visible to others (roborev).
 *   4. Return the resulting pod URL for the caller to write into
 *      `vcard:hasPhoto` (via the normal `saveProfile` flow).
 *
 * SECURITY: the target is derived from the user's OWN `activeStorage`, so it is
 * inherently in-pod-scope (SEC-1) — the caller passes its active storage, never
 * an attacker-influenceable URL. Production callers pass NO `fetchImpl` so the
 * auth-patched global fetch (DPoP) runs; the parameters here are test-only.
 */
import { asContainerUrl, deleteEntry, guessContentType, writeRaw } from "./files.js";
import { AcpUnsupportedError } from "./errors.js";
import { WacResourceSharingBackend } from "./resource-acl.js";

/**
 * Accepted avatar image types mapped to the file extension we store under. The
 * keys are the allow-list (defence-in-depth alongside the picker filter) AND the
 * full set of `avatar.*` variants we sweep when replacing a previous upload.
 */
const IMAGE_TYPE_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

/** Every extension an avatar might have been stored under (for stale cleanup). */
const AVATAR_EXTENSIONS: readonly string[] = Object.values(IMAGE_TYPE_EXTENSION);

/** The MIME type without any `; charset=…` suffix, lower-cased. */
function normalizeType(type: string): string {
  return type.split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * The safe file extension for an avatar of `type`. Derived from the allow-listed
 * MIME (so the URL extension and stored bytes agree). The caller has already
 * validated `type` is in the allow-list, so the map always hits.
 */
function avatarExtension(type: string): string {
  return IMAGE_TYPE_EXTENSION[type] ?? "img";
}

export interface UploadProfilePhotoOptions {
  /** Test-only fetch override; omit in production so the auth-patched global runs. */
  fetchImpl?: typeof fetch;
}

/** Why a public-read grant didn't take (so the caller can message honestly). */
export type PublicReadStatus =
  /** Public read was granted — anyone can see the avatar. */
  | "granted"
  /** The pod uses an access-control model we can't set here (ACP `.acr`). */
  | "unsupported"
  /** The ACL write failed (permission/network/conflict). */
  | "failed";

export interface UploadProfilePhotoResult {
  /** The uploaded avatar's pod URL (to write into `vcard:hasPhoto`). */
  url: string;
  /**
   * Whether public-read was successfully granted. `false` means the bytes
   * uploaded but the public grant did NOT take — the URL is still usable by the
   * owner (and anyone they already share the parent with); the caller warns that
   * others may not see the picture yet. NEVER silently dropped (roborev): the
   * exact reason is in {@link publicReadStatus}.
   */
  publicReadGranted: boolean;
  /** The granular reason for {@link publicReadGranted} (for honest messaging). */
  publicReadStatus: PublicReadStatus;
  /**
   * Best-effort cleanup of STALE avatar variants left by a previous upload of a
   * DIFFERENT image type (e.g. an old `avatar.jpg` when this upload wrote
   * `avatar.png`). The caller MUST run this only AFTER the profile document is
   * saved with the new `url` (roborev): deleting the old variants before the
   * save lands could leave a failed save pointing `vcard:hasPhoto` at a
   * just-deleted URL (a broken published photo). Idempotent + swallows its own
   * errors — awaiting it never throws and never needs a try/catch.
   */
  cleanupStaleVariants: () => Promise<void>;
}

/**
 * Upload `file` as the signed-in user's avatar and return its pod URL.
 *
 * @param activeStorage - the user's chosen pod storage root (their own pod).
 * @param webId - the signed-in WebID (the owner the ACL backend protects).
 * @throws {Error} when the file is not an accepted image type.
 * @throws {ResourceWriteError} on a failed upload (the caller surfaces a toast).
 */
export async function uploadProfilePhoto(
  activeStorage: string,
  webId: string,
  file: File,
  opts: UploadProfilePhotoOptions = {},
): Promise<UploadProfilePhotoResult> {
  // Allow-list check via Object.hasOwn so a malformed synthetic `File.type` of
  // an inherited prop name (`constructor`/`toString`) can't slip past (roborev).
  const type = normalizeType(file.type || guessContentType(file.name) || "");
  if (!Object.hasOwn(IMAGE_TYPE_EXTENSION, type)) {
    throw new Error("Please choose an image file (PNG, JPEG, GIF, WebP or SVG).");
  }

  const profileContainer = `${asContainerUrl(activeStorage)}profile/`;
  const ext = avatarExtension(type);
  const url = `${profileContainer}avatar.${ext}`;

  // Overwrite an existing avatar (no create-only): a re-upload should replace the
  // old picture, not 412.
  await writeRaw(url, file, { contentType: type, fetchImpl: opts.fetchImpl });

  // Stale-variant cleanup is DEFERRED to the caller (see `cleanupStaleVariants`):
  // it must run only AFTER the profile document is saved with the new `url`, so a
  // failed save never leaves `vcard:hasPhoto` pointing at a just-deleted old
  // variant (roborev). Best-effort + idempotent: deleteEntry treats 404/410 as
  // success, errors are swallowed, and it never deletes the NEW variant.
  const cleanupStaleVariants = async (): Promise<void> => {
    await Promise.all(
      AVATAR_EXTENSIONS.filter((e) => e !== ext).map((e) =>
        deleteEntry(`${profileContainer}avatar.${e}`, opts.fetchImpl).catch(
          () => undefined,
        ),
      ),
    );
  };

  // Make it publicly readable so the avatar renders for profile viewers. The
  // backend reads the resource (now present) to find its ACL doc, then sets the
  // public Read grant via typed accessors (never hand-built triples). The
  // outcome is REPORTED, never silently dropped (roborev): on an ACP pod the
  // backend throws AcpUnsupportedError (we can't grant WAC public-read there),
  // and any other ACL failure is surfaced as "failed" — either way the bytes are
  // uploaded and the URL is usable by the owner, so we keep the upload and let
  // the caller tell the user the picture may not yet be visible to others.
  let publicReadStatus: PublicReadStatus = "granted";
  try {
    const backend = new WacResourceSharingBackend(webId, opts.fetchImpl);
    await backend.setAccess(url, { kind: "public", id: "" }, "view");
  } catch (e) {
    publicReadStatus = e instanceof AcpUnsupportedError ? "unsupported" : "failed";
  }

  return {
    url,
    publicReadGranted: publicReadStatus === "granted",
    publicReadStatus,
    cleanupStaleVariants,
  };
}
