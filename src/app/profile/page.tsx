// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Profile editor — read + edit the WebID profile card the way others see it.
 * Name / nickname / photo / role / organisation / pronouns / description /
 * homepage. Saved with a conditional write (412 → reopen, 403 → permission).
 *
 * The WebID itself is read-only here: per ADR-0004 it is an admin-controlled
 * identity claim, not a user-editable profile field — we show it but never
 * write it.
 */
import { useEffect, useMemo, useState } from "react";
import { Globe, IdCard, Loader2, Save, UserRound } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/components/session-provider";
import { useEditableProfile, saveProfile } from "@/components/use-profile-edit";
import { ErrorState } from "@/components/states";
import { ResourceWriteError } from "@/lib/errors";
import type { EditableProfile } from "@/lib/profile-edit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export default function ProfilePage() {
  const { webId } = useSession();
  const { data, loading, error, reload } = useEditableProfile();

  const [form, setForm] = useState<EditableProfile>({ name: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) setForm(data.profile);
  }, [data]);

  const set = <K extends keyof EditableProfile>(key: K, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const previewName = form.name.trim() || webId || "You";
  const photoValid = useMemo(() => isHttpUrl(form.photo), [form.photo]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!webId) return;
    if (form.homepage && !isHttpUrl(form.homepage)) {
      toast.error("Homepage must be a full web address (https://…).");
      return;
    }
    if (form.photo && !isHttpUrl(form.photo)) {
      toast.error("Photo must be a full image address (https://…).");
      return;
    }
    setSaving(true);
    try {
      await saveProfile({ webId, edit: form });
      toast.success("Profile saved", { description: "This is how others see you." });
    } catch (err) {
      if (err instanceof ResourceWriteError && err.status === 412) {
        toast.error("Your profile changed elsewhere. Reloading the latest…");
        reload();
      } else if (err instanceof ResourceWriteError && err.status === 403) {
        toast.error("You don't have permission to edit this profile.");
      } else {
        toast.error("Could not save your profile. Please try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start gap-4">
        <span
          aria-hidden="true"
          className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"
        >
          <IdCard className="size-6" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Your profile</h1>
          <p className="measure mt-1 text-sm text-muted-foreground text-pretty">
            Edit the details people see when they look you up. It all stays in your pod.
          </p>
        </div>
      </header>

      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          <form onSubmit={onSave} className="flex flex-col gap-5">
            <Field id="p-name" label="Name">
              <Input
                id="p-name"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Your full name"
                autoComplete="name"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="p-nick" label="Nickname" hint="what friends call you">
                <Input
                  id="p-nick"
                  value={form.nickname ?? ""}
                  onChange={(e) => set("nickname", e.target.value)}
                  placeholder="optional"
                />
              </Field>
              <Field id="p-pronouns" label="Pronouns">
                <Input
                  id="p-pronouns"
                  value={form.pronouns ?? ""}
                  onChange={(e) => set("pronouns", e.target.value)}
                  placeholder="e.g. she/her"
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="p-role" label="Role">
                <Input
                  id="p-role"
                  value={form.role ?? ""}
                  onChange={(e) => set("role", e.target.value)}
                  placeholder="e.g. Engineer"
                />
              </Field>
              <Field id="p-org" label="Organisation">
                <Input
                  id="p-org"
                  value={form.organisation ?? ""}
                  onChange={(e) => set("organisation", e.target.value)}
                  placeholder="e.g. Example Co"
                />
              </Field>
            </div>

            <Field id="p-photo" label="Photo address" hint="a link to your picture">
              <Input
                id="p-photo"
                type="url"
                inputMode="url"
                value={form.photo ?? ""}
                onChange={(e) => set("photo", e.target.value)}
                placeholder="https://…/me.jpg"
              />
            </Field>

            <Field id="p-home" label="Homepage">
              <Input
                id="p-home"
                type="url"
                inputMode="url"
                value={form.homepage ?? ""}
                onChange={(e) => set("homepage", e.target.value)}
                placeholder="https://your-site.example/"
              />
            </Field>

            <Field id="p-desc" label="About you">
              <Textarea
                id="p-desc"
                value={form.description ?? ""}
                onChange={(e) => set("description", e.target.value)}
                placeholder="A short description others will see…"
              />
            </Field>

            <div>
              <Button type="submit" disabled={saving}>
                {saving ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <Save aria-hidden="true" />
                )}
                Save profile
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              Your sign-in address (WebID) is managed by your provider and cannot be
              changed here.{" "}
              <span className="font-mono break-all">{webId}</span>
            </p>
          </form>

          {/* How others see you */}
          <aside aria-label="Profile preview">
            <Card className="sticky top-4">
              <CardHeader>
                <CardTitle className="text-sm text-muted-foreground">
                  How others see you
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col items-center gap-3 text-center">
                <Avatar size="lg" className="size-20">
                  {photoValid ? (
                    <AvatarImage src={form.photo} alt="" />
                  ) : null}
                  <AvatarFallback className="text-lg">
                    {initials(previewName)}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <p className="font-semibold">{previewName}</p>
                  {form.nickname?.trim() && (
                    <p className="text-sm text-muted-foreground">“{form.nickname.trim()}”</p>
                  )}
                  {form.pronouns?.trim() && (
                    <p className="text-xs text-muted-foreground">{form.pronouns.trim()}</p>
                  )}
                </div>
                {(form.role?.trim() || form.organisation?.trim()) && (
                  <p className="flex items-center gap-1.5 text-sm">
                    <UserRound className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    {[form.role?.trim(), form.organisation?.trim()].filter(Boolean).join(" · ")}
                  </p>
                )}
                {form.description?.trim() && (
                  <p className="measure text-sm text-muted-foreground text-pretty">
                    {form.description.trim()}
                  </p>
                )}
                {form.homepage?.trim() && isHttpUrl(form.homepage) && (
                  <a
                    href={form.homepage.trim()}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline"
                  >
                    <Globe className="size-3.5" aria-hidden="true" />
                    {hostOf(form.homepage)}
                  </a>
                )}
              </CardContent>
            </Card>
          </aside>
        </div>
      )}
    </div>
  );
}

function isHttpUrl(v: string | undefined): boolean {
  const t = v?.trim();
  if (!t) return false;
  try {
    const u = new URL(t);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url.trim()).hostname;
  } catch {
    return url.trim();
  }
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>
        {label}
        {hint ? (
          <span className="ml-1.5 font-normal text-muted-foreground">— {hint}</span>
        ) : null}
      </Label>
      {children}
    </div>
  );
}
