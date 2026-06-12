import Link from "next/link";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * Shared chrome for the public legal pages (/privacy, /terms). These render
 * OUTSIDE the session-gated AppShell (see PUBLIC_ROUTES there), so they carry
 * their own minimal header/footer in the app's visual language. Server-safe:
 * no hooks, no I/O — the pages stay fully static under `output: "export"`.
 */
export function LegalPage({
  title,
  effectiveDate,
  children,
}: {
  title: string;
  /** ISO date shown as "Effective <date>". */
  effectiveDate: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-16 items-center justify-between border-b border-border px-4 md:px-8">
        <Link
          href="/"
          aria-label="Pod Manager home"
          className="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Brand />
        </Link>
        <ThemeToggle />
      </header>

      <main className="flex-1 px-4 py-10 md:px-8">
        <article className="mx-auto w-full max-w-2xl">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            {title}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Effective {effectiveDate}
          </p>
          <div className="mt-8 flex flex-col gap-8">{children}</div>
        </article>
      </main>

      <footer className="border-t border-border px-4 py-6 md:px-8">
        <div className="mx-auto flex w-full max-w-2xl flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground hover:underline">
            Pod Manager
          </Link>
          <Link href="/privacy" className="hover:text-foreground hover:underline">
            Privacy
          </Link>
          <Link href="/terms" className="hover:text-foreground hover:underline">
            Terms
          </Link>
          <a
            href="mailto:jesse@jeswr.org"
            className="hover:text-foreground hover:underline"
          >
            jesse@jeswr.org
          </a>
        </div>
      </footer>
    </div>
  );
}

/** One titled section of a legal page. */
export function LegalSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}
