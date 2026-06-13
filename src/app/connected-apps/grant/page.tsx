"use client";

/**
 * The grant / consent screen (DESIGN.md §5 — GDPR-valid, dark-pattern-free).
 *
 * Deep-linkable: an external app can send the user here with
 * `?client=<app id URL>&categories=health,finance&modes=read&redirect=<url>&reason=<benefit>`.
 *
 * Hard rules implemented (R5/R6):
 * - per-category checkboxes — never all-or-nothing;
 * - a plain-language scope + benefit rationale per request;
 * - Accept and Decline with EQUAL visual weight (identical variant + size);
 * - no consent wall — declining writes nothing and returns to the app cleanly;
 * - the persistent assurance that everything is revocable in Connected apps.
 */
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AppWindow, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { categoryIcon } from "@/components/category-icon";
import { EmptyState, ErrorState } from "@/components/states";
import {
  permissionsBackend,
  useConnectedApps,
} from "@/components/use-permissions";
import { categoryById, CATEGORIES, type DataCategory } from "@/lib/categories";
import {
  describeModes,
  fetchAppIdentity,
  type AccessMode,
  type AppIdentity,
} from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";

const VALID_MODES: readonly AccessMode[] = ["read", "append", "write", "control"];

export default function GrantPage() {
  // useSearchParams requires a Suspense boundary in a prod build.
  return (
    <Suspense fallback={<Skeleton className="h-64 rounded-2xl" />}>
      <GrantScreen />
    </Suspense>
  );
}

function GrantScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const { ctx, data: apps, loading, error, reload, getFreshModel } =
    useConnectedApps();

  const clientId = params.get("client") ?? undefined;
  const reason = params.get("reason") ?? undefined;
  const redirect = safeRedirect(params.get("redirect"));

  const modes = parseModes(params.get("modes"));
  const requested = parseCategories(params.get("categories"));

  const [identity, setIdentity] = useState<AppIdentity>();
  const [selected, setSelected] = useState<ReadonlySet<string>>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    fetchAppIdentity(clientId).then((id) => {
      if (!cancelled) setIdentity(id);
    });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  if (!clientId) {
    return (
      <EmptyState
        icon={AppWindow}
        title="This access request is incomplete"
        description="The link that brought you here doesn't say which app is asking. Nothing has been shared. You can review your connected apps instead."
        action={
          <Button variant="outline" asChild>
            <Link href="/connected-apps">Review connected apps</Link>
          </Button>
        }
      />
    );
  }
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !ctx || !identity) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading access request">
        <Skeleton className="h-16 w-80 rounded-xl" />
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-2xl" />
        ))}
      </div>
    );
  }

  const appName = identity.name;
  // Only categories with somewhere to point the grant are offered enabled.
  const offered = (requested ?? CATEGORIES.map((c) => c.id))
    .map((id) => categoryById(id))
    .filter((c): c is DataCategory => Boolean(c))
    .map((category) => ({
      category,
      grantable:
        ctx.summaries.find((s) => s.category.id === category.id)?.locations.length ?? 0,
    }));
  const checked =
    selected ??
    new Set(offered.filter((o) => o.grantable > 0).map((o) => o.category.id));

  const alreadyConnected = apps?.some((a) => a.agentId === clientId) ?? false;
  const selectedLabels = offered
    .filter((o) => checked.has(o.category.id))
    .map((o) => o.category.label.toLowerCase());

  function toggle(categoryId: string, value: boolean) {
    const next = new Set(checked);
    if (value) next.add(categoryId);
    else next.delete(categoryId);
    setSelected(next);
  }

  function leave(message: string) {
    if (redirect) {
      window.location.assign(redirect);
      return;
    }
    toast.info(message);
    router.push("/connected-apps");
  }

  async function decline() {
    // No consent wall: nothing is written, the user returns to the app cleanly.
    leave("No access was granted.");
  }

  async function accept() {
    if (!ctx) return;
    setBusy(true);
    // SECURITY: grant against a FRESH context (owner WebID / pod root /
    // category targets, re-discovered live) rather than the cached snapshot
    // the offered list was rendered from. Falls back to the rendered ctx only
    // if the fresh read fails, so a grant is never silently dropped.
    let writeCtx = ctx;
    try {
      writeCtx = (await getFreshModel()).ctx;
    } catch {
      // keep rendered ctx — the write is still authoritative under If-Match.
    }
    const granted: string[] = [];
    const failed: string[] = [];
    for (const { category, grantable } of offered) {
      if (!checked.has(category.id) || grantable === 0) continue;
      try {
        await permissionsBackend.grant(writeCtx, clientId as string, category.id, modes);
        granted.push(category.label.toLowerCase());
      } catch {
        failed.push(category.label.toLowerCase());
      }
    }
    setBusy(false);
    if (failed.length > 0) {
      toast.error(`Couldn't grant access to ${failed.join(", ")}.`, {
        description:
          granted.length > 0
            ? `Access to ${granted.join(", ")} was granted.`
            : "Nothing was changed. Check your connection and try again.",
      });
      return;
    }
    toast.success(`${appName} can now ${describeModes(modes)} your ${granted.join(", ")}.`);
    leave("Access granted.");
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          {appName} is asking to access your data
        </h1>
        <p className="measure mt-1 text-muted-foreground text-pretty">
          {reason
            ? `${appName} wants your ${selectedLabels.length > 0 ? selectedLabels.join(", ") : "data"} so you can ${reason}.`
            : `Choose exactly which categories ${appName} may ${describeModes(modes)}. You stay in control, category by category.`}
        </p>
        {alreadyConnected ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {appName} already has some access —{" "}
            <Link
              href={`/connected-apps/app?id=${encodeURIComponent(clientId)}`}
              className="underline underline-offset-4 hover:text-foreground"
            >
              review it here
            </Link>
            .
          </p>
        ) : null}
      </header>

      <fieldset className="flex flex-col gap-3 border-0 p-0">
        <legend className="sr-only">Data categories {appName} may access</legend>
        {offered.map(({ category, grantable }) => {
          const Icon = categoryIcon(category.icon);
          const id = `grant-${category.id}`;
          const disabled = grantable === 0;
          return (
            <div
              key={category.id}
              className="flex items-start gap-3 rounded-2xl border border-border bg-card p-4"
            >
              <Checkbox
                id={id}
                checked={!disabled && checked.has(category.id)}
                disabled={disabled || busy}
                onCheckedChange={(v) => toggle(category.id, v === true)}
                className="mt-0.5"
              />
              <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                <span className="flex items-center gap-2 font-medium">
                  <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                  {category.label}
                </span>
                <span className="mt-0.5 block text-sm text-muted-foreground text-pretty">
                  {disabled
                    ? `Nothing is stored here yet, so there's nothing to share.`
                    : `${appName} will be able to ${describeModes(modes)} your ${category.label.toLowerCase()}.`}
                </span>
              </label>
            </div>
          );
        })}
      </fieldset>

      {/* Equal visual weight: identical variant + size, side by side (R5). Both
          neutral `outline` rather than two filled primaries — equal weight, but
          without reading as a double-confirm (PM review #5). */}
      <div className="grid grid-cols-2 gap-3">
        <Button size="lg" variant="outline" disabled={busy} onClick={decline}>
          Don&apos;t allow
        </Button>
        <Button
          size="lg"
          variant="outline"
          disabled={busy || checked.size === 0}
          onClick={accept}
        >
          Allow selected
        </Button>
      </div>
      {redirect ? (
        <p className="text-center text-sm text-muted-foreground">
          Either way, you&apos;ll return to {hostOf(redirect) ?? "the app"}.
        </p>
      ) : null}

      <p className="flex items-center justify-center gap-1.5 text-center text-sm text-muted-foreground">
        <ShieldCheck className="size-4 shrink-0 text-primary" aria-hidden="true" />
        You can change or revoke this anytime in Connected apps.
      </p>
    </div>
  );
}

function parseModes(raw: string | null): AccessMode[] {
  if (!raw) return ["read"];
  const modes = raw
    .split(",")
    .map((m) => m.trim().toLowerCase())
    .filter((m): m is AccessMode => (VALID_MODES as readonly string[]).includes(m));
  return modes.length > 0 ? modes : ["read"];
}

function parseCategories(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const ids = raw
    .split(",")
    .map((c) => c.trim())
    .filter((c) => categoryById(c) !== undefined);
  return ids.length > 0 ? ids : undefined;
}

/** Only ever bounce the user to an http(s) URL — anything else is dropped. */
function safeRedirect(raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}
