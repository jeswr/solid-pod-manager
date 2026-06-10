"use client";

import { Database, Fingerprint, LogOut, Server } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/components/session-provider";
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
