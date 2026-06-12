import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/legal-page";

/**
 * The real terms of service — short, honest, and specific: this is a test
 * deployment of a client-side Solid app, provided as-is; the user owns their
 * data. Fully static; rendered outside the session gate (AppShell
 * PUBLIC_ROUTES).
 */
export const metadata: Metadata = {
  title: "Terms of service",
  description:
    "The terms for using Pod Manager: provided as-is, a test deployment, and your data stays yours.",
};

const EFFECTIVE_DATE = "12 June 2026";

const P = "text-sm leading-relaxed text-muted-foreground text-pretty";
const LIST = "flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-muted-foreground";

export default function TermsPage() {
  return (
    <LegalPage title="Terms of service" effectiveDate={EFFECTIVE_DATE}>
      <LegalSection title="The service">
        <p className={P}>
          Pod Manager is a client-side web application for viewing and
          organising the data in your Solid pod. It is currently a{" "}
          <strong className="text-foreground">test deployment</strong>:
          features may change, break, or be withdrawn without notice, and the
          hosting may be interrupted. By using it you accept these terms.
        </p>
      </LegalSection>

      <LegalSection title="Your data is yours">
        <p className={P}>
          Your data lives in your pod, with the storage provider you chose —
          not with Pod Manager. The app reads and writes it only on your
          instruction, and the developer has no access to it. Deleting the app
          or your account here does not touch your pod; your relationship with
          your pod provider is governed by their terms, not these.
        </p>
      </LegalSection>

      <LegalSection title="Acceptable use">
        <p className={P}>You agree not to use Pod Manager to:</p>
        <ul className={LIST}>
          <li>
            access data or pods you are not authorised to access, or attempt
            to circumvent access controls;
          </li>
          <li>
            disrupt, overload, or probe the hosting infrastructure or the
            services it connects to; or
          </li>
          <li>break any law that applies to you.</li>
        </ul>
        <p className={P}>
          When you connect a third-party service (for example to import your
          data from it), you are also responsible for complying with that
          service&apos;s own terms.
        </p>
      </LegalSection>

      <LegalSection title="No warranty">
        <p className={P}>
          Pod Manager is provided <strong className="text-foreground">“as is”</strong>,
          without warranty of any kind — express or implied — including
          fitness for a particular purpose and non-infringement. To the
          maximum extent permitted by law, the developer is not liable for any
          loss or damage arising from your use of the app, including loss of
          data. Keep your own copies of anything you cannot afford to lose.
        </p>
      </LegalSection>

      <LegalSection title="Changes">
        <p className={P}>
          These terms may be updated as the app evolves; the effective date
          above will change when they do. Continuing to use the app after a
          change means you accept the updated terms.
        </p>
      </LegalSection>

      <LegalSection title="Contact">
        <p className={P}>
          Questions about these terms:{" "}
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
