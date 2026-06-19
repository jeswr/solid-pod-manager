"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ExternalLink,
  Eye,
  Home,
  KeyRound,
  Loader2,
  Lock,
  ShieldCheck,
} from "lucide-react";
import {
  LoginSupersededError,
  NoWebIdFromProviderError,
  useSession,
} from "@/components/session-provider";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { initials } from "@/components/account-menu";
import {
  InvalidWebIdError,
  NoSolidIssuerError,
  validateWebId,
  webIdFromSearch,
} from "@/lib/login-ux";
import {
  HOME_PROVIDER,
  LOGIN_PROVIDERS,
  NotALoginAddressError,
  PUBLIC_PROVIDERS,
} from "@/lib/login-input";
import { PopupBlockedError } from "@/lib/popup-login";
import { AmbiguousIssuerError } from "@/lib/webid-token-provider";
import { PasskeyRegistry } from "@/lib/webauthn-reauth";

/** Friendly, jargon-light error copy for the login failure modes. */
function loginErrorMessage(error: unknown): string {
  if (error instanceof InvalidWebIdError) {
    return "That doesn't look like a valid web address. A WebID looks like https://you.example/profile/card#me";
  }
  if (error instanceof NoSolidIssuerError || error instanceof NotALoginAddressError) {
    return "We couldn't find a Solid login at that address. Double-check it, pick a provider above, or get a pod below.";
  }
  if (error instanceof PopupBlockedError) {
    return "Your browser blocked the sign-in window. Allow popups for this site and try again.";
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return "Sign-in was cancelled. Try again when you're ready.";
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "Sign-in took too long and was stopped. Try again when you're ready.";
  }
  if (error instanceof NoWebIdFromProviderError) {
    return "You signed in, but your provider didn't tell us your WebID. Try entering your WebID directly.";
  }
  return "We couldn't sign you in. Check the address and your connection, then try again.";
}

/**
 * First-run login. Leads with what the product does in plain language (the
 * research's #1 risk: trust + usability must be earned, not assumed), offers a
 * one-tap path to create a pod for newcomers — THIS server first — and a
 * first-party sign-in surface: a provider picker (home provider leading) plus
 * ONE smart input that accepts a WebID or a bare provider URL. Returning users
 * get avatar quick-buttons.
 *
 * All login entry points call the session's login functions DIRECTLY from the
 * click/submit handler: the OIDC popup is opened synchronously there, so the
 * user activation is never lost (src/lib/popup-login.ts).
 */
export function LoginScreen() {
  const { login, loginWithIssuer, signInWithPasskey, cancelLogin, recentAccounts, status } =
    useSession();
  const [webId, setWebId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showSignIn, setShowSignIn] = useState(false);
  // Set when the entered WebID advertises several issuers: the USER picks.
  const [issuerChoices, setIssuerChoices] = useState<string[] | null>(null);
  // The WebIDs this device has a passkey registered for (client-only —
  // localStorage). Drives the "passkey" hint on returning-account buttons: a
  // sign-in there is served redirect-free by the composed WebAuthn re-auth
  // provider on the first protected read. Keyed by WebID (NOT issuer) so two
  // accounts on the same provider don't both light up. Empty until the effect
  // runs (and on SSR).
  const [passkeyWebIds, setPasskeyWebIds] = useState<Set<string>>(new Set());
  const busy = status === "authenticating";
  const returning = recentAccounts.length > 0;

  // Load the per-device passkey hints once on the client (localStorage is not
  // available during SSR / the static export's prerender).
  useEffect(() => {
    try {
      const ids = new PasskeyRegistry().list().map((r) => r.webId);
      setPasskeyWebIds(new Set(ids));
    } catch {
      // No localStorage / corrupt store — no hints, normal login unchanged.
    }
  }, []);

  /** Whether THIS exact account (by WebID) has a passkey registered here. */
  function accountHasPasskey(accountWebId: string): boolean {
    return passkeyWebIds.has(accountWebId);
  }

  // WebID deep-link contract: the Solid server's profile page links to
  // `/?webid=<URL-encoded WebID>` — landing with it prefills the sign-in form
  // for that WebID and surfaces it immediately. Login is NOT auto-submitted:
  // the OIDC flow opens a popup, and popups not triggered by a user gesture
  // are blocked — so the user confirms with one click on "Sign in".
  // Read from window.location in an effect (not useSearchParams) so the
  // prerendered shell needs no Suspense boundary and hydration stays clean.
  useEffect(() => {
    const fromLink = webIdFromSearch(window.location.search);
    if (fromLink) {
      setWebId(fromLink);
      setShowSignIn(true);
    }
  }, []);

  /** Shared failure handling for every login path. */
  function fail(e: unknown) {
    if (e instanceof LoginSupersededError) {
      // BENIGN (the #123 fence): the login was superseded by a newer login / a logout / a
      // cancel — not a failure. The superseding actor owns the UI; show NO error.
      return;
    }
    if (e instanceof AmbiguousIssuerError) {
      // Several issuers on the profile: never pick silently — let the user.
      setIssuerChoices(e.issuers);
      return;
    }
    setError(loginErrorMessage(e));
  }

  /** Smart-input submit (WebID or bare issuer; optional pre-picked issuer). */
  function attempt(input: string, issuer?: string) {
    setError(null);
    setIssuerChoices(null);
    // Validate synchronously BEFORE the popup opens: garbage input gets an
    // inline error, not a flash of a blank popup.
    try {
      validateWebId(input);
    } catch (e) {
      setError(loginErrorMessage(e));
      return;
    }
    // No await before login(): it must run inside the click's user activation.
    login(input, issuer ? { issuer } : undefined).catch(fail);
  }

  /** Provider-picker click: login straight against a known issuer. */
  function attemptIssuer(issuer: string) {
    setError(null);
    setIssuerChoices(null);
    loginWithIssuer(issuer).catch(fail);
  }

  /**
   * Recent-account click: WebID + remembered issuer.
   *
   * PASSKEY-FIRST, POPUP-FREE (the Finding-3 flicker fix): when THIS account has a
   * passkey on this device, try the redirect-free `signInWithPasskey` FIRST — it
   * opens NO OAuth popup at all (the session is served by the native passkey prompt
   * on the first protected read), killing the "tab rapidly opening and closing"
   * flicker the old `login(..., silentFirst)` path produced for passkey accounts
   * (dead refresh token → about:blank popup → fast `prompt=none` against the live
   * IdP cookie). If the passkey ceremony fails we fall through to the interactive
   * `login()`. That fallback runs AFTER the async ceremony, so the click's transient
   * activation may be SPENT — `login()`'s popup may then be BLOCKED and recovers via
   * the existing blocked-popup ("Continue signing in") affordance rather than opening
   * under the click. That is acceptable: it is a one-click recovery, NOT the
   * automatic-on-load flicker this fix targets, and the happy path opens no popup.
   *
   * For a NON-passkey account, behaviour is unchanged: when the app still holds a
   * session / refresh token for that issuer, NO popup opens; otherwise the silent
   * `prompt=none` attempt runs first (a live IdP session is likely for a returning
   * account, so silent success means zero typing).
   */
  function attemptRecent(account: { webId: string; issuer?: string }) {
    setError(null);
    setIssuerChoices(null);
    if (accountHasPasskey(account.webId) && account.issuer) {
      // No await before the call: start the passkey ceremony synchronously off the click.
      signInWithPasskey(account.webId, account.issuer).catch((e) => {
        if (e instanceof LoginSupersededError) return; // benign (the #123 fence)
        // The passkey ceremony / read failed → fall back to the interactive `login()`.
        // This `.catch` runs AFTER the async ceremony, so the original click's transient
        // activation is likely SPENT by now: `login()`'s `window.open` may be BLOCKED. That
        // is fine — it recovers cleanly via the existing blocked-popup ("Continue signing
        // in") affordance (SessionProvider), whose button click supplies fresh activation.
        // The property this path preserves is that NOTHING flashes automatically: the happy
        // passkey path opens no popup at all, and the failure path degrades to a one-click
        // affordance rather than an unactivated/surprise window.
        login(account.webId, { issuer: account.issuer, silentFirst: true }).catch(fail);
      });
      return;
    }
    login(account.webId, { issuer: account.issuer, silentFirst: true }).catch(fail);
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

        {/* In-flight login: one clear state with a way out. The popup is open;
            everything else on this screen is disabled until it settles. */}
        {busy && (
          <div
            role="status"
            className="mb-6 flex items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-sm"
          >
            <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
            <span className="min-w-0 flex-1 text-sm">
              <span className="block font-medium">Finish signing in with your provider</span>
              <span className="block text-muted-foreground">
                A sign-in window is open — complete the steps there.
              </span>
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={cancelLogin}>
              Cancel
            </Button>
          </div>
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
                    onClick={() => attemptRecent(a)}
                    className="flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
                  >
                    <Avatar className="size-9">
                      {a.avatarUrl ? <AvatarImage src={a.avatarUrl} alt="" /> : null}
                      <AvatarFallback className="bg-accent text-accent-foreground text-sm">
                        {initials(a.displayName)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 truncate font-medium">
                        {a.displayName}
                        {accountHasPasskey(a.webId) && (
                          <Badge variant="secondary" className="gap-1">
                            <KeyRound className="size-3" aria-hidden="true" />
                            Passkey
                          </Badge>
                        )}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {accountHasPasskey(a.webId)
                          ? "Sign in with your passkey — no sign-in window"
                          : a.webId}
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

        {/* New users: lead with "create a pod" — THIS server first; existing
            users: the sign-in surface. The sign-in surface is always reachable
            via the toggle so neither path is buried. */}
        {!returning && !showSignIn ? (
          <section aria-label="Create a pod" className="rounded-2xl border border-border bg-card p-6 shadow-sm">
            <h2 className="text-base font-semibold">Get started — create your free pod</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Make your pod right here (it’s like creating an email account) — or
              pick another provider. You’ll come right back to your data.
            </p>
            <ul className="mt-4 flex flex-col gap-2">
              <li>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => attemptIssuer(HOME_PROVIDER.issuer)}
                  className="flex w-full items-center gap-3 rounded-xl border border-primary/40 bg-accent/40 p-3 text-left transition-colors hover:bg-accent/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
                    <Home className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 font-medium">
                      {HOME_PROVIDER.name}
                      <Badge variant="secondary">This server</Badge>
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Create your pod right here — free, one step
                    </span>
                  </span>
                  <ArrowRight className="size-4 text-muted-foreground" aria-hidden="true" />
                </button>
              </li>
              {PUBLIC_PROVIDERS.map((p) => (
                <li key={p.issuer}>
                  <a
                    href={p.issuer}
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
          <section aria-label="Sign in" className="rounded-2xl border border-border bg-card p-6 shadow-sm">
            <h2 className="text-base font-semibold">Sign in to your pod</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick your provider, or enter your pod address below.
            </p>

            {/* Provider picker — the home provider leads. */}
            <ul className="mt-4 flex flex-col gap-2" aria-label="Pod providers">
              {LOGIN_PROVIDERS.map((p) => (
                <li key={p.issuer}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => attemptIssuer(p.issuer)}
                    className={
                      p.home
                        ? "flex w-full items-center gap-3 rounded-xl border border-primary/40 bg-accent/40 p-3 text-left transition-colors hover:bg-accent/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
                        : "flex w-full items-center gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
                    }
                  >
                    {p.home && (
                      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
                        <Home className="size-4" aria-hidden="true" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 font-medium">
                        {p.name}
                        {p.home && <Badge variant="secondary">This server</Badge>}
                      </span>
                      <span className="block text-xs text-muted-foreground">{p.blurb}</span>
                    </span>
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>

            <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>

            {/* ONE smart input: WebID or bare provider URL. */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                attempt(webId);
              }}
              noValidate
            >
              <Label htmlFor="webid" className="text-sm font-medium">
                Your pod address or provider
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
                  The web address your provider gave you (your “WebID”) — or just
                  your provider’s address if you don’t have one yet.
                </p>
              )}

              {/* The WebID advertises several issuers — the user picks one. */}
              {issuerChoices && (
                <fieldset className="mt-3 rounded-xl border border-border p-3">
                  <legend className="px-1 text-xs font-medium text-muted-foreground">
                    Your profile lists more than one sign-in provider — choose one
                  </legend>
                  <ul className="flex flex-col gap-2">
                    {issuerChoices.map((issuer) => (
                      <li key={issuer}>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => attempt(webId, issuer)}
                          className="flex w-full items-center gap-2 rounded-lg border border-border p-2 text-left text-sm transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
                        >
                          <KeyRound className="size-4 shrink-0 text-primary" aria-hidden="true" />
                          <span className="truncate">{issuer}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </fieldset>
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
          </section>
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

        {/* Legal links — public pages, reachable before sign-in. */}
        <footer className="mt-6 flex items-center justify-center gap-4 text-xs text-muted-foreground">
          <Link href="/privacy" className="hover:text-foreground hover:underline">
            Privacy policy
          </Link>
          <span aria-hidden="true">·</span>
          <Link href="/terms" className="hover:text-foreground hover:underline">
            Terms of service
          </Link>
        </footer>
      </div>
    </main>
  );
}
