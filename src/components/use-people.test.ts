// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md

/**
 * Regression lock for the {@link usePeople} live-refresh topics (roborev finding,
 * Low): the people-picker fetcher reads from BOTH the active storage's contacts
 * container AND the profile document (`foaf:knows` friends). The SWR conversion
 * moved the watched notification topic to ONLY the contacts container, so a
 * profile/friend change no longer invalidated the mounted picker — a regression
 * vs the prior live-refresh.
 *
 * The fix watches BOTH topics: the contacts container via `useSwrRead`'s
 * `topicUrl`, and the profile document via a second `useResourceNotifications`
 * subscription wired to the SAME `reload`. A change on EITHER revalidates the
 * picker.
 *
 * Why this is a topic-set / structural test (mirrors instant-nav.test.ts):
 * Vitest runs the `node` environment with no DOM / React renderer (see
 * vitest.config.ts), so we cannot mount the real hook. Instead we (1) model the
 * exact set of topics `usePeople` subscribes to and prove a profile-document
 * notification still fires `reload`, and (2) structurally assert the source wires
 * a profile-document subscription, so the "contacts container only" regression
 * cannot silently recur. The React wiring around it is covered by the build + e2e.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CONTACTS_SLUG } from "../lib/contacts.js";
import { profileDocUrl } from "../lib/profile-edit.js";

const COMPONENTS_DIR = dirname(fileURLToPath(import.meta.url));
const WEBID = "https://alice.example/profile/card#me";
const STORAGE = "https://alice.example/storage/";

// ---------------------------------------------------------------------------
// (1) Behavioural: the picker watches BOTH the contacts container AND the
//     profile document, so a change to EITHER triggers a revalidation.
// ---------------------------------------------------------------------------

/**
 * The set of (topicUrl → onChange) subscriptions `usePeople` installs, modelled
 * 1:1 from the hook:
 *   - the contacts container (via useSwrRead's topicUrl), and
 *   - the profile document (via the second useResourceNotifications),
 * both wired to the SAME `reload`. A subscription dispatcher routes a
 * notification for a topic to that topic's onChange (mirroring
 * `useResourceNotifications` → `subscribeToResource`).
 */
function peopleSubscriptions(
  webId: string | undefined,
  activeStorage: string | undefined,
  reload: () => void,
) {
  const subs = new Map<string, () => void>();
  const contactsContainer = activeStorage
    ? new URL(CONTACTS_SLUG, activeStorage).toString()
    : undefined;
  // useSwrRead's topicUrl — the contacts container — revalidates via reload().
  if (contactsContainer) subs.set(contactsContainer, reload);
  // The second subscription added by the fix — the profile document.
  if (webId) subs.set(profileDocUrl(webId), reload);
  return {
    topics: [...subs.keys()],
    /** Deliver a change notification for `topic` (no-op if unwatched). */
    notify(topic: string) {
      subs.get(topic)?.();
    },
  };
}

describe("usePeople — live-refresh topics (profile-doc regression lock)", () => {
  it("watches BOTH the contacts container AND the profile document", () => {
    const { topics } = peopleSubscriptions(WEBID, STORAGE, () => {});
    expect(topics).toContain(`${STORAGE}${CONTACTS_SLUG}`);
    expect(topics).toContain(profileDocUrl(WEBID));
    expect(topics).toHaveLength(2);
  });

  it("a PROFILE-DOCUMENT change still triggers a revalidation (the regression)", () => {
    const reload = vi.fn();
    const { notify } = peopleSubscriptions(WEBID, STORAGE, reload);
    // A friend added on the profile card (foaf:knows) must refresh the picker.
    notify(profileDocUrl(WEBID));
    expect(reload, "a profile-document change must revalidate the mounted picker").toHaveBeenCalledTimes(1);
  });

  it("a CONTACTS-CONTAINER change still triggers a revalidation (unchanged behaviour)", () => {
    const reload = vi.fn();
    const { notify } = peopleSubscriptions(WEBID, STORAGE, reload);
    notify(`${STORAGE}${CONTACTS_SLUG}`);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("logged-out / no storage → no subscriptions (nothing to watch)", () => {
    expect(peopleSubscriptions(undefined, undefined, () => {}).topics).toEqual([]);
    // No WebID but a storage: only the contacts container is watched.
    expect(peopleSubscriptions(undefined, STORAGE, () => {}).topics).toEqual([
      `${STORAGE}${CONTACTS_SLUG}`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// (2) Structural guard: the source must wire a profile-document subscription,
//     so the "contacts container only" regression cannot silently recur.
// ---------------------------------------------------------------------------

describe("usePeople — structural: subscribes to the profile document", () => {
  const src = readFileSync(join(COMPONENTS_DIR, "use-people.ts"), "utf8");

  it("imports useResourceNotifications and subscribes to profileDocUrl(webId)", () => {
    expect(
      src.includes("useResourceNotifications"),
      "use-people.ts must subscribe to the profile document via useResourceNotifications",
    ).toBe(true);
    expect(
      /useResourceNotifications\([^)]*profileDocUrl\(/.test(src),
      "use-people.ts must wire a useResourceNotifications subscription on profileDocUrl(webId)",
    ).toBe(true);
  });
});
