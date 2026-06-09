"use client";

import { useState } from "react";
import { ArrowRight, ExternalLink, Loader2, ShieldCheck } from "lucide-react";
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
 * WebID-first login (solid-reactive-authentication UX spec). One input: the
 * user's WebID. Returning users see avatar buttons for their recent accounts.
 * A pod-signup link makes a never-heard-of-Solid user reachable in ~30s.
 */
export function LoginScreen() {
  const { login, recentAccounts, status } = useSession();
  const [webId, setWebId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = status === "authenticating";

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
            Your data, your rules
          </h1>
          <p className="measure mt-2 text-pretty text-muted-foreground">
            See everything in your personal pod, and decide which apps can use
            it. Sign in with your WebID to start.
          </p>
        </div>

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

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void attempt(webId);
          }}
          className="rounded-2xl border border-border bg-card p-6 shadow-sm"
          noValidate
        >
          <Label htmlFor="webid" className="text-sm font-medium">
            Your WebID
          </Label>
          <Input
            id="webid"
            name="webid"
            type="url"
            inputMode="url"
            autoComplete="url"
            placeholder="https://you.example/profile/card#me"
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
              This is the web address of your pod profile.
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
        </form>

        <div className="mt-6 rounded-xl border border-dashed border-border bg-muted/40 p-4">
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            <span>
              New to Solid? A “pod” is your own private data store.{" "}
              <a
                href="https://solidproject.org/users/get-a-pod"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
              >
                Get a free pod
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
