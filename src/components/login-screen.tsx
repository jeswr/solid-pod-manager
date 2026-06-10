"use client";

import { useState } from "react";
import {
  ArrowRight,
  ExternalLink,
  Eye,
  KeyRound,
  Loader2,
  Lock,
  ShieldCheck,
} from "lucide-react";
import { useSession } from "@/components/session-provider";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { initials } from "@/components/account-menu";
import {
  InvalidWebIdError,
  NoSolidIssuerError,
} from "@/lib/login-ux";

/**
 * Where a new user can create a pod. Kept short + recognisable; each is an
 * external sign-up page (we never collect credentials ourselves). Ordered by
 * how beginner-friendly the sign-up is.
 */
const POD_PROVIDERS: { name: string; url: string; blurb: string }[] = [
  { name: "solidcommunity.net", url: "https://solidcommunity.net/", blurb: "Free, run by the Solid community" },
  { name: "solidweb.org", url: "https://solidweb.org/", blurb: "Free community pod host" },
  { name: "teamid.live", url: "https://teamid.live/", blurb: "Free, quick sign-up" },
];

/** Friendly, jargon-light error copy for the login failure modes. */
function loginErrorMessage(error: unknown): string {
  if (error instanceof InvalidWebIdError) {
    return "That doesn't look like a valid web address. A WebID looks like https://you.example/profile/card#me";
  }
  if (error instanceof NoSolidIssuerError) {
    return "We couldn't find a Solid login for that address. Double-check it, or get a pod below.";
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return "Sign-in was cancelled. Try again when you're ready.";
  }
  return "We couldn't sign you in. Check the address and your connection, then try again.";
}

/**
 * First-run login. Leads with what the product does in plain language (the
 * research's #1 risk: trust + usability must be earned, not assumed), offers a
 * one-tap path to create a pod for newcomers, and keeps the pod-address sign-in
 * for people who already have one. Returning users get avatar quick-buttons.
 */
export function LoginScreen() {
  const { login, recentAccounts, status } = useSession();
  const [webId, setWebId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showSignIn, setShowSignIn] = useState(false);
  const busy = status === "authenticating";
  const returning = recentAccounts.length > 0;

  async function attempt(id: string) {
    setError(null);
    try {
      await login(id);
    } catch (e) {
      setError(loginErrorMessage(e));
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-gradient-to-b from-accent/30 to-background px-4 py-10">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <Brand className="mb-6 scale-110" />
          <h1 className="text-2xl font-semibold tracking-tight text-balance">
            One home for all your personal data
          </h1>
          <p className="measure mt-2 text-pretty text-muted-foreground">
            Pod Manager puts your information — your calendar, contacts, health,
            files and more — in a private store that <em>you</em> own, and lets
            you decide which apps can use it.
          </p>
        </div>

        {/* First-run explainer (3 plain points). Hidden once we show the
            sign-in form or for returning users, to keep that path fast. */}
        {!showSignIn && !returning && (
          <ul className="mb-8 grid gap-3" aria-label="How Pod Manager works">
            {[
              { icon: Lock, title: "Your data lives in your pod", body: "A private online store that belongs to you — not to us, and not to any app." },
              { icon: Eye, title: "You can see all of it", body: "Everything in one place, organised and easy to browse." },
              { icon: KeyRound, title: "You decide who gets access", body: "Grant or revoke any app's access to any part of your data, anytime." },
            ].map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex items-start gap-3 rounded-xl border border-border bg-card/60 p-3">
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-primary">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <span>
                  <span className="block text-sm font-medium">{title}</span>
                  <span className="block text-sm text-muted-foreground">{body}</span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {recentAccounts.length > 0 && (
          <section aria-label="Recent accounts" className="mb-6">
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">
              Continue as
            </h2>
            <ul className="flex flex-col gap-2">
              {recentAccounts.map((a) => (
                <li key={a.webId}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => attempt(a.webId)}
                    className="flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
                  >
                    <Avatar className="size-9">
                      {a.avatarUrl ? <AvatarImage src={a.avatarUrl} alt="" /> : null}
                      <AvatarFallback className="bg-accent text-accent-foreground text-sm">
                        {initials(a.displayName)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {a.displayName}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {a.webId}
                      </span>
                    </span>
                    <ArrowRight className="size-4 text-muted-foreground" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
            <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              or use a different account
              <span className="h-px flex-1 bg-border" />
            </div>
          </section>
        )}

        {/* New users: lead with "create a pod"; existing users: the sign-in form.
            The form is always reachable via the toggle so neither path is buried. */}
        {!returning && !showSignIn ? (
          <section aria-label="Create a pod" className="rounded-2xl border border-border bg-card p-6 shadow-sm">
            <h2 className="text-base font-semibold">Get started — create your free pod</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick a provider to make your pod (it’s like creating an email account). You’ll come right
              back here to sign in.
            </p>
            <ul className="mt-4 flex flex-col gap-2">
              {POD_PROVIDERS.map((p) => (
                <li key={p.url}>
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{p.name}</span>
                      <span className="block text-xs text-muted-foreground">{p.blurb}</span>
                    </span>
                    <ExternalLink className="size-4 text-muted-foreground" aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
            <p className="mt-5 text-center text-sm text-muted-foreground">
              Already have a pod?{" "}
              <button
                type="button"
                onClick={() => setShowSignIn(true)}
                className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                Sign in
              </button>
            </p>
          </section>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void attempt(webId);
            }}
            className="rounded-2xl border border-border bg-card p-6 shadow-sm"
            noValidate
          >
            <Label htmlFor="webid" className="text-sm font-medium">
              Your pod address
            </Label>
            <Input
              id="webid"
              name="webid"
              type="url"
              inputMode="url"
              autoComplete="url"
              placeholder="https://you.solidcommunity.net/profile/card#me"
              value={webId}
              onChange={(e) => setWebId(e.target.value)}
              disabled={busy}
              aria-invalid={error ? "true" : undefined}
              aria-describedby={error ? "webid-error" : "webid-hint"}
              className="mt-2"
            />
            {error ? (
              <p id="webid-error" role="alert" className="mt-2 text-sm text-destructive">
                {error}
              </p>
            ) : (
              <p id="webid-hint" className="mt-2 text-xs text-muted-foreground">
                The web address your provider gave you (sometimes called your “WebID”).
              </p>
            )}

            <Button type="submit" className="mt-4 w-full" disabled={busy || !webId.trim()}>
              {busy ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Signing in…
                </>
              ) : (
                "Sign in"
              )}
            </Button>

            {!returning && (
              <p className="mt-4 text-center text-sm text-muted-foreground">
                Don’t have a pod yet?{" "}
                <button
                  type="button"
                  onClick={() => setShowSignIn(false)}
                  className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  Create one
                </button>
              </p>
            )}
          </form>
        )}

        <div className="mt-6 rounded-xl border border-dashed border-border bg-muted/40 p-4">
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            <span>
              Pod Manager never stores your data or your password — sign-in happens with your provider.{" "}
              <a
                href="https://solidproject.org/users/get-a-pod"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
              >
                More providers
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>{" "}
              and come back here.
            </span>
          </p>
        </div>
      </div>
    </main>
  );
}
