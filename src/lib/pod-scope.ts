/**
 * Pod-scope guard. The app's `fetch` is auth-patched: any 401 triggers an
 * `upgrade()` that attaches the user's DPoP-bound access token + a proof for the
 * REQUESTED url. So fetching an attacker-controlled url (e.g. a crafted
 * `…/item?url=https://evil.example/x` link) would leak the user's token/proof to
 * that origin (a confused-deputy / token-leak; see the P1 security review SEC-1).
 *
 * Therefore the app must only ever `fetch` resources it has a legitimate reason
 * to: resources INSIDE one of the user's own pods. This module centralises that
 * check so every "open a pod resource" path uses it.
 */

/**
 * True iff `target` is a same-origin descendant of `root` (a pod storage URL).
 * Compares the normalised origin + a path-prefix that respects path segment
 * boundaries (so `…/alicE/` does not match `…/alice-evil/`). Both must be
 * http(s). The fragment/query on `target` are ignored for the containment test.
 */
export function isWithinPod(target: string, root: string): boolean {
  let t: URL;
  let r: URL;
  try {
    t = new URL(target);
    r = new URL(root);
  } catch {
    return false;
  }
  if (t.protocol !== "http:" && t.protocol !== "https:") return false;
  if (t.protocol !== r.protocol || t.host !== r.host) return false;
  // Normalise the root to end in "/" so the prefix check is segment-aligned.
  const rootPath = r.pathname.endsWith("/") ? r.pathname : `${r.pathname}/`;
  const targetPath = t.pathname;
  // The pod root itself is in scope, as is anything strictly under it.
  return `${targetPath}/` === rootPath || targetPath === r.pathname || targetPath.startsWith(rootPath);
}

/** True iff `target` is within ANY of the user's pod storages. */
export function isInOwnPods(target: string, storages: readonly string[]): boolean {
  return storages.some((root) => isWithinPod(target, root));
}

/** Schemes safe to render as a clickable href. Pod RDF is attacker-influenceable. */
const SAFE_LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * Return `value` if it is safe to put in an `href`, else `undefined` (caller
 * renders it as inert text). Blocks `javascript:`, `data:`, `vbscript:`, etc. —
 * IRIs from pod data become hrefs in the RDF/profile viewers, and React does NOT
 * block dangerous href schemes (review SEC-2: DOM-XSS via a `javascript:` IRI).
 */
export function safeLinkHref(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined; // relative/opaque — not a navigable absolute IRI, render as text
  }
  return SAFE_LINK_SCHEMES.has(url.protocol) ? value : undefined;
}
