import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/legal-page";

/**
 * The real privacy policy — honest and specific to how this app works (a
 * client-side Solid app: browser ↔ your pod ↔ services you connect; nothing
 * through us). Every claim below is checked against the codebase: the
 * in-memory token store, the localStorage keys, the static export, and the
 * token-exchange proxy used by the four proxy-mode OAuth integrations.
 * Fully static; rendered outside the session gate (AppShell PUBLIC_ROUTES).
 */
export const metadata: Metadata = {
  title: "Privacy policy",
  description:
    "How Pod Manager handles your data: everything stays between your browser, your pod, and the services you connect.",
};

const EFFECTIVE_DATE = "12 June 2026";

const P = "text-sm leading-relaxed text-muted-foreground text-pretty";
const LIST = "flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-muted-foreground";

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy" effectiveDate={EFFECTIVE_DATE}>
      <LegalSection title="What Pod Manager is">
        <p className={P}>
          Pod Manager is a client-side web application for viewing and
          organising the data in your personal{" "}
          <a
            href="https://solidproject.org"
            rel="noopener noreferrer"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Solid pod
          </a>
          , and for controlling which apps can access it. It is delivered as
          static files: there is no application server run by the developer
          that sees or processes your data.
        </p>
      </LegalSection>

      <LegalSection title="Where your data flows">
        <p className={P}>
          Everything happens in your browser. Data moves only between:
        </p>
        <ul className={LIST}>
          <li>
            <strong className="text-foreground">your browser and your pod</strong>{" "}
            — the storage provider you chose and signed in with; and
          </li>
          <li>
            <strong className="text-foreground">
              your browser and the services you explicitly connect
            </strong>{" "}
            — for example Spotify or GitHub, when you choose to import from
            them.
          </li>
        </ul>
        <p className={P}>
          Data you import is written exclusively to your own pod, under your
          own storage. It is never sent to the developer or to any third
          party. You can browse, edit, and delete it there at any time.
        </p>
      </LegalSection>

      <LegalSection title="Sign-in and tokens">
        <p className={P}>
          You sign in with your own Solid identity provider; Pod Manager never
          sees your password. OAuth access tokens for connected services are
          held in memory only — they are never written to disk, never stored
          server-side (there is no server), and never sent to the developer. A
          page reload drops them, and you simply reconnect.
        </p>
        <p className={P}>
          A few OAuth providers (GitHub, Strava, Twitch, Notion) require a
          secret-keeping token-exchange proxy. When one of those is configured,
          the proxy sees the one-time authorization code only, exchanges it,
          and returns the token to your browser — it does not store tokens or
          your data.
        </p>
      </LegalSection>

      <LegalSection title="What stays on your device">
        <p className={P}>
          To make returning easier, the app keeps a small amount of state in
          your browser&apos;s local storage: your list of recently used
          accounts (WebID, display name, avatar URL, chosen provider), the
          WebID of the active account, and your light/dark theme preference.
          This never leaves your device, and you can remove it by clearing the
          site&apos;s browsing data.
        </p>
      </LegalSection>

      <LegalSection title="No analytics, no tracking, no ads">
        <p className={P}>
          Pod Manager contains no analytics, no tracking scripts, no
          advertising, and no third-party beacons of any kind. The developer
          collects nothing about your use of the app.
        </p>
      </LegalSection>

      <LegalSection title="Contact">
        <p className={P}>
          Questions about this policy:{" "}
          <a
            href="mailto:jesse@jeswr.org"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            jesse@jeswr.org
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
