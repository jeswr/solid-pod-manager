"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Check,
  ChevronRight,
  Database,
  Fingerprint,
  Globe,
  IdCard,
  KeyRound,
  ListTree,
  Loader2,
  LogOut,
  Server,
} from "lucide-react";
import { toast } from "sonner";
import {
  useSession,
  WebAuthnRegistrationError,
} from "@/components/session-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function SettingsPage() {
  const { profile, webId, activeStorage, logout } = useSession();

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Settings</h1>
        <p className="mt-1 text-muted-foreground text-pretty">
          Your account and pod basics.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Account</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field icon={Fingerprint} label="Display name">
            {profile ? profile.displayName : <Skeleton className="h-5 w-40" />}
          </Field>
          <Field icon={Fingerprint} label="Your pod address" hint="sometimes called your WebID">
            <span className="break-all font-mono text-sm">{webId ?? "—"}</span>
          </Field>
          <Field icon={Server} label="Sign-in provider" hint="who you log in with">
            <span className="break-all font-mono text-sm">
              {profile?.issuers[0] ?? "—"}
            </span>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Storage</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field icon={Database} label="Active pod">
            <span className="break-all font-mono text-sm">{activeStorage ?? "—"}</span>
          </Field>
          {profile && profile.storages.length > 1 ? (
            <p className="text-sm text-muted-foreground">
              You have {profile.storages.length} pods. Switching between them
              arrives with the write features.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <SettingsLink
            href="/profile"
            icon={IdCard}
            title="Edit your profile"
            description="Your name, photo, and the details others see."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Advanced</CardTitle>
        </CardHeader>
        <CardContent>
          <SettingsLink
            href="/settings/type-index"
            icon={ListTree}
            title="Type index"
            description="See and manage where each kind of your data is registered."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Domains</CardTitle>
        </CardHeader>
        <CardContent>
          <Link
            href="/settings/domains"
            className="group flex items-start gap-3 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <Globe
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="min-w-0">
              <span className="flex items-center gap-1 text-sm font-medium underline-offset-4 group-hover:underline">
                Custom domains
                <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
              </span>
              <span className="mt-0.5 block text-sm text-muted-foreground">
                Use your own web address for your pod.
              </span>
            </span>
          </Link>
        </CardContent>
      </Card>

      <PasskeyCard />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Session</CardTitle>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            onClick={() => {
              logout();
              toast.success("Signed out", {
                description: "Your data stays in your pod.",
              });
            }}
          >
            <LogOut className="size-4" aria-hidden="true" />
            Sign out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Opt-in "Sign in with a passkey" set-up — the app-side payoff of the passkey
 * workstream. After this one-time set-up the next visit to this device signs in
 * redirect-free (the platform passkey prompt instead of the provider popup).
 *
 * NO auto-provision: if the provider refuses (e.g. the account is not
 * provisioned for passkeys) we surface the provider's OWN message verbatim and
 * create nothing — the existing redirect sign-in keeps working unchanged.
 */
function PasskeyCard() {
  const { status, hasPasskey, registerPasskey } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Locally remember that a passkey set-up SUCCEEDED this session even when the
  // local hint could not be persisted (`{ saved: false }` — credential created,
  // hint not stored, so `hasPasskey` stays false). Without this the UI keeps
  // showing "Set up a passkey", inviting a pointless duplicate ceremony (roborev
  // Finding 4). The credential exists on the device either way, so the ready state
  // is correct; only the cross-load hint failed.
  const [setupComplete, setSetupComplete] = useState(false);
  const ready = hasPasskey || setupComplete;

  if (status !== "logged-in") return null;

  async function setUp() {
    setError(null);
    setBusy(true);
    try {
      const { saved } = await registerPasskey();
      // The credential was created on this device on ANY success — flip to the
      // ready state and hide the button regardless of whether the local hint
      // persisted (roborev Finding 4).
      setSetupComplete(true);
      if (saved) {
        toast.success("Passkey set up", {
          description: "Next time on this device you can sign in with your passkey.",
        });
      } else {
        // The credential WAS created — this is a non-fatal warning, not a
        // failure, so do not invite a duplicate retry.
        toast.warning("Passkey created", {
          description:
            "Your passkey was created, but this browser couldn't remember it for next time. You can still sign in with it.",
        });
      }
    } catch (e) {
      if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "AbortError")) {
        // The user dismissed the platform prompt — not an error worth shouting.
        setBusy(false);
        return;
      }
      // Surface the provider's no-auto-provision (or any) message verbatim; do
      // NOT attempt to create an identity.
      const message =
        e instanceof WebAuthnRegistrationError
          ? e.message
          : "We couldn't set up a passkey right now. Please try again.";
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Sign-in &amp; security</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <KeyRound
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm font-medium">Sign in with a passkey</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {ready
                ? "This device is set up. Next time you can sign in with your fingerprint, face, or device PIN — no sign-in window."
                : "Set up a passkey to sign in next time with your fingerprint, face, or device PIN — without opening a sign-in window."}
            </p>
          </div>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {ready ? (
          <p className="inline-flex items-center gap-2 text-sm font-medium text-primary">
            <Check className="size-4" aria-hidden="true" />
            Passkey ready on this device
          </p>
        ) : (
          <div>
            <Button variant="outline" onClick={setUp} disabled={busy}>
              {busy ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Setting up…
                </>
              ) : (
                <>
                  <KeyRound className="size-4" aria-hidden="true" />
                  Set up a passkey
                </>
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** A card-body navigation link to a settings sub-page (shared layout). */
function SettingsLink({
  href,
  icon: Icon,
  title,
  description,
}: {
  href: string;
  icon: typeof Database;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-start gap-3 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0">
        <span className="flex items-center gap-1 text-sm font-medium underline-offset-4 group-hover:underline">
          {title}
          <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
        </span>
        <span className="mt-0.5 block text-sm text-muted-foreground">{description}</span>
      </span>
    </Link>
  );
}

function Field({
  icon: Icon,
  label,
  hint,
  children,
}: {
  icon: typeof Database;
  label: string;
  /** Optional plain-language gloss for a technical term (no-jargon principle). */
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      {/* A single-pair description list — valid dt/dd markup (PM-8). */}
      <dl className="m-0 min-w-0">
        <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
          {hint ? (
            <span className="ml-1.5 normal-case font-normal tracking-normal lowercase opacity-80">
              ({hint})
            </span>
          ) : null}
        </dt>
        <dd className="m-0 mt-0.5">{children}</dd>
      </dl>
    </div>
  );
}
