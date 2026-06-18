// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Per-resource Sharing panel (feature-completeness plan Wave 3, Cluster B).
 *
 * A Sheet attached to any resource that shows, in plain language, WHO has WHICH
 * access — people (by WebID), groups, "Anyone on the web" (public) and "Anyone
 * signed in" (authenticated) — grouped, with levels (Can view / Can edit /
 * Owner), never raw WAC modes. It lets the user add/remove subjects and change
 * levels, surfaces whether access is inherited from a parent or set directly,
 * and protects the user from ever removing their own Owner (self-lockout guard).
 *
 * All RDF/`.acl` work happens in {@link @/lib/resource-acl}; this file is pure
 * UI + orchestration. Mutations go through the typed backend (never hand-built
 * triples); errors surface as honest, plain-language toasts and the model is
 * re-read so the panel always reflects the server (fail-closed).
 */
import { useCallback, useState } from "react";
import Link from "next/link";
import {
  Check,
  ChevronDown,
  Globe,
  Loader2,
  Plus,
  ShieldCheck,
  Trash2,
  UserCircle,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ErrorState } from "@/components/states";
import { AclWriteError } from "@/lib/errors";
import { nameFromUrl } from "@/lib/pod-data";
import {
  describeEntryAccess,
  LEVEL_DESCRIPTION,
  LEVEL_LABEL,
  subjectKey,
  subjectLabel,
  wouldLockOutOwner,
  type AccessEntry,
  type AccessLevel,
  type AccessSubject,
  type ResourceAccess,
} from "@/lib/resource-acl";
import { useResourceSharing } from "@/components/use-resource-sharing";

const LEVELS: AccessLevel[] = ["view", "edit", "owner", "add"];

/**
 * The Share button + the Sheet it opens, attachable to any resource row.
 *
 * Open state is uncontrolled by default (renders its own "Share" trigger). For
 * callers that already own a trigger elsewhere — e.g. a "Sharing" item in the
 * files-browser 3-dots menu (bug #11), where nesting a SheetTrigger inside the
 * DropdownMenu is fragile — pass a controlled `open`/`onOpenChange` and set
 * `hideTrigger` so no second trigger button renders.
 */
export function SharingPanel({
  resourceUrl,
  trigger,
  open: controlledOpen,
  onOpenChange,
  hideTrigger,
}: {
  resourceUrl: string;
  /** Optional custom trigger; defaults to an outline "Share" button. */
  trigger?: React.ReactNode;
  /** Controlled open state (with {@link onOpenChange}). Uncontrolled if unset. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Render no built-in trigger (use with a controlled `open` from elsewhere). */
  hideTrigger?: boolean;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {hideTrigger ? null : (
        <SheetTrigger asChild>
          {trigger ?? (
            <Button variant="outline">
              <Users className="size-4" aria-hidden="true" />
              Share
            </Button>
          )}
        </SheetTrigger>
      )}
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b border-border p-6">
          <SheetTitle className="truncate">Share “{nameFromUrl(resourceUrl)}”</SheetTitle>
          <SheetDescription>
            Choose who can see or change this, in plain language. Only you keep
            full control unless you grant it.
          </SheetDescription>
        </SheetHeader>
        {/* Mount the body only while open so the read runs on demand. */}
        {open ? <SharingBody resourceUrl={resourceUrl} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function SharingBody({ resourceUrl }: { resourceUrl: string }) {
  const { access, loading, error, ownerWebId, backend, reload } =
    useResourceSharing(resourceUrl);

  if (error) {
    return (
      <div className="p-6">
        <ErrorState error={error} onRetry={reload} />
      </div>
    );
  }
  if (loading || !access || !ownerWebId || !backend) {
    return (
      <div className="space-y-3 p-6" aria-busy="true" aria-label="Loading access settings">
        <Skeleton className="h-10 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <SharingEditor
      access={access}
      ownerWebId={ownerWebId}
      backend={backend}
      reload={reload}
    />
  );
}

function SharingEditor({
  access,
  ownerWebId,
  backend,
  reload,
}: {
  access: ResourceAccess;
  ownerWebId: string;
  backend: NonNullable<ReturnType<typeof useResourceSharing>["backend"]>;
  reload: () => void;
}) {
  const [busy, setBusy] = useState(false);

  /** Run a mutation, then re-read; surface errors honestly (fail-closed). */
  async function run(
    action: () => Promise<void>,
    success: string,
  ): Promise<void> {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      reload();
    } catch (e) {
      const msg = mutationMessage(e);
      toast.error(msg.title, { description: msg.description });
      // Reconcile with the live ACL after a failure too: a 409/412 means the
      // document changed under us, and a network error after the PUT may have
      // landed — never keep rendering the stale pre-mutation snapshot (roborev).
      reload();
    } finally {
      setBusy(false);
    }
  }

  function setLevel(subject: AccessSubject, level: AccessLevel) {
    // No-op when the subject already sits at exactly this displayed level:
    // re-selecting "Can view" must NOT rewrite a read+append entry down to
    // read-only (the collapsed level is lossy; only an actual CHANGE should
    // canonicalise the modes) (roborev). A change to a different level is the
    // user's explicit intent and writes that level's canonical modes.
    const current = access.entries.find(
      (e) => subjectKey(e.subject) === subjectKey(subject),
    );
    if (current && current.level === level) {
      // Re-selecting the SAME displayed level is a no-op regardless of source.
      // The collapsed level is lossy (e.g. read+append shows as "Can view"), so
      // re-writing it would drop append; and for an inherited entry it would
      // needlessly materialise. Promotion to a resource-specific ACL is offered
      // explicitly elsewhere (the "Set specific access" control) (roborev).
      return;
    }
    // Client-side self-lockout guard (the backend also refuses, fail-closed).
    if (wouldLockOutOwner(access, ownerWebId, { subject, level })) {
      toast.error("You can't remove your own access.", {
        description: "You'd lock yourself out of managing this. You stay as Owner.",
      });
      return;
    }
    void run(
      () => backend.setAccess(access.resourceUrl, subject, level),
      "Access updated.",
    );
  }

  function remove(subject: AccessSubject) {
    if (wouldLockOutOwner(access, ownerWebId, { subject, remove: true })) {
      toast.error("You can't remove your own access.", {
        description: "You'd lock yourself out of managing this. You stay as Owner.",
      });
      return;
    }
    void run(
      () => backend.removeAccess(access.resourceUrl, subject),
      "Access removed.",
    );
  }

  const publicEntry = access.entries.find((e) => e.subject.kind === "public");
  const authedEntry = access.entries.find((e) => e.subject.kind === "authenticated");
  const named = access.entries.filter(
    (e) => e.subject.kind === "agent" || e.subject.kind === "group",
  );
  // Browser-app origins and any unmodelled agent-classes are shown READ-ONLY
  // here (origins are managed in Connected apps; unmodelled classes aren't
  // editable inline) so access is never under-reported, while keeping the
  // editable surface simple.
  const readOnly = access.entries.filter(
    (e) => e.subject.kind === "origin" || e.subject.kind === "class",
  );

  return (
    <div className="flex-1 overflow-y-auto">
      {access.inherited ? (
        <InheritanceNotice
          busy={busy}
          onSetSpecific={() =>
            // Promoting to a specific ACL: re-affirm the owner at Owner level,
            // which materialises the inherited rules into this resource's own
            // document (the backend copies them so no one loses access).
            run(
              () =>
                backend.setAccess(
                  access.resourceUrl,
                  { kind: "agent", id: ownerWebId },
                  "owner",
                ),
              "This now has its own access settings.",
            )
          }
        />
      ) : null}

      <section className="flex flex-col gap-2 p-4" aria-label="People and groups">
        <h3 className="px-1 text-sm font-medium text-muted-foreground">People and groups</h3>
        {named.length === 0 ? (
          <p className="px-1 text-sm text-muted-foreground">
            No people or groups added yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {named.map((entry) => (
              <EntryRow
                key={`${entry.subject.kind}:${entry.subject.id}`}
                entry={entry}
                isSelf={entry.subject.kind === "agent" && entry.subject.id === ownerWebId}
                busy={busy}
                onSetLevel={(level) => setLevel(entry.subject, level)}
                onRemove={() => remove(entry.subject)}
              />
            ))}
          </ul>
        )}
        <AddPersonForm
          busy={busy}
          onAdd={(subject, level) => setLevel(subject, level)}
        />
      </section>

      {readOnly.length > 0 ? (
        <section className="flex flex-col gap-2 border-t border-border p-4" aria-label="Other access">
          <h3 className="px-1 text-sm font-medium text-muted-foreground">Other access</h3>
          <ul className="flex flex-col gap-1.5">
            {readOnly.map((entry) => (
              <li
                key={`${entry.subject.kind}:${entry.subject.id}`}
                className="flex items-center gap-3 rounded-xl border border-border bg-card p-3"
              >
                <Globe className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={entry.subject.id}>
                    {entry.subject.kind === "origin"
                      ? originHost(entry.subject.id)
                      : subjectLabel(entry.subject)}
                  </p>
                  <p className="truncate text-xs text-muted-foreground" title={entry.subject.id}>
                    {describeEntryAccess(entry)}
                  </p>
                </div>
                <Badge variant="secondary" className="font-normal">
                  {LEVEL_LABEL[entry.level]}
                </Badge>
              </li>
            ))}
          </ul>
          <p className="px-1 text-xs text-muted-foreground">
            Browser-app access is managed in{" "}
            <Link href="/connected-apps" className="font-medium text-primary underline-offset-4 hover:underline">
              Connected apps
            </Link>
            .
          </p>
        </section>
      ) : null}

      <section className="flex flex-col gap-2 border-t border-border p-4" aria-label="General access">
        <h3 className="px-1 text-sm font-medium text-muted-foreground">General access</h3>
        <PublicToggle
          icon={Globe}
          title="Anyone on the web"
          subtitle="Anyone with the link — no sign-in needed."
          entry={publicEntry}
          busy={busy}
          onSetLevel={(level) => setLevel({ kind: "public", id: "" }, level)}
          onRemove={() => remove({ kind: "public", id: "" })}
        />
        <PublicToggle
          icon={UserCircle}
          title="Anyone signed in"
          subtitle="Any signed-in person, on any pod."
          entry={authedEntry}
          busy={busy}
          onSetLevel={(level) => setLevel({ kind: "authenticated", id: "" }, level)}
          onRemove={() => remove({ kind: "authenticated", id: "" })}
        />
      </section>

      <p className="flex items-center gap-1.5 border-t border-border p-4 text-sm text-muted-foreground">
        <ShieldCheck className="size-4 shrink-0 text-primary" aria-hidden="true" />
        You always keep full control of your own data.
      </p>
    </div>
  );
}

/** One person/group row: name, level picker, inheritance badge, remove. */
function EntryRow({
  entry,
  isSelf,
  busy,
  onSetLevel,
  onRemove,
}: {
  entry: AccessEntry;
  isSelf: boolean;
  busy: boolean;
  onSetLevel: (level: AccessLevel) => void;
  onRemove: () => void;
}) {
  const Icon = entry.subject.kind === "group" ? Users : UserCircle;
  return (
    <li className="flex items-center gap-3 rounded-xl border border-border bg-card p-3">
      <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={entry.subject.id || undefined}>
          {/* Show a stable, distinguishing identifier for agents AND groups so
              two group grants are never visually identical (roborev). The full
              IRI stays available via the title attribute for accessibility. */}
          {entry.subject.kind === "agent" || entry.subject.kind === "group"
            ? entry.subject.id
            : subjectLabel(entry.subject)}
          {entry.subject.kind === "group" ? (
            <span className="ml-1 text-muted-foreground">(group)</span>
          ) : null}
          {isSelf ? <span className="ml-1 text-muted-foreground">(you)</span> : null}
        </p>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {entry.source === "inherited" ? (
            <Badge variant="secondary" className="font-normal">
              Inherited
            </Badge>
          ) : null}
          {describeEntryAccess(entry)}
        </p>
      </div>
      <LevelPicker
        level={entry.level}
        // The owner's own Owner row has no valid level change: a downgrade is a
        // self-lockout (blocked) and re-selecting Owner is a no-op. Disable the
        // picker rather than leave a dead control — promoting an INHERITED
        // self-owner grant to resource-specific is done via "Set specific
        // access" (the inheritance notice) (roborev).
        disabled={busy || (isSelf && entry.level === "owner")}
        onChange={onSetLevel}
      />
      {/* The owner can't remove their own access (self-lockout). Others can be
          removed whether set here or inherited — removing an inherited entry
          materialises a resource-specific ACL that omits them. */}
      {!isSelf ? (
        <Button
          variant="ghost"
          size="icon"
          disabled={busy}
          aria-label={`Remove access for ${entry.subject.id || subjectLabel(entry.subject)}`}
          onClick={onRemove}
        >
          <Trash2 className="size-4 text-destructive" aria-hidden="true" />
        </Button>
      ) : null}
    </li>
  );
}

/** Public / authenticated row with an inline level picker + "off". */
function PublicToggle({
  icon: Icon,
  title,
  subtitle,
  entry,
  busy,
  onSetLevel,
  onRemove,
}: {
  icon: typeof Globe;
  title: string;
  subtitle: string;
  entry?: AccessEntry;
  busy: boolean;
  onSetLevel: (level: AccessLevel) => void;
  onRemove: () => void;
}) {
  const on = entry !== undefined;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-3">
      <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {on && entry?.source === "inherited" ? (
            <Badge variant="secondary" className="font-normal">
              Inherited
            </Badge>
          ) : null}
          {/* When on, show the mode-aware description (so a read+append public
              grant is reported honestly as "…and add", not just "Can view")
              (roborev); when off, the static hint explains what turning on does. */}
          {on && entry ? describeEntryAccess(entry) : subtitle}
        </p>
      </div>
      {on ? (
        <>
          <LevelPicker
            level={entry.level}
            disabled={busy}
            onChange={onSetLevel}
            // Public/authenticated should never be Owner — drop that option.
            allowed={["view", "edit", "add"]}
          />
          <Button
            variant="ghost"
            size="icon"
            disabled={busy}
            aria-label={`Turn off ${title}`}
            onClick={onRemove}
          >
            <Trash2 className="size-4 text-destructive" aria-hidden="true" />
          </Button>
        </>
      ) : (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onSetLevel("view")}>
          Turn on
        </Button>
      )}
    </div>
  );
}

/** A small dropdown to choose a level (plain-language, no raw modes). */
function LevelPicker({
  level,
  disabled,
  onChange,
  allowed = LEVELS,
}: {
  level: AccessLevel;
  disabled?: boolean;
  onChange: (level: AccessLevel) => void;
  allowed?: AccessLevel[];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" disabled={disabled} className="shrink-0 gap-1">
          {LEVEL_LABEL[level]}
          <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {allowed.map((l) => (
          <DropdownMenuItem
            key={l}
            onSelect={() => onChange(l)}
            className="flex flex-col items-start gap-0.5"
          >
            <span className="flex w-full items-center justify-between font-medium">
              {LEVEL_LABEL[l]}
              {l === level ? <Check className="size-4 text-primary" aria-hidden="true" /> : null}
            </span>
            <span className="text-xs text-muted-foreground">{LEVEL_DESCRIPTION[l]}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Add a person (WebID) or group (group-doc IRI) at a chosen level. */
function AddPersonForm({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (subject: AccessSubject, level: AccessLevel) => void;
}) {
  const [value, setValue] = useState("");
  const [kind, setKind] = useState<"agent" | "group">("agent");
  const [level, setLevel] = useState<AccessLevel>("view");

  const trimmed = value.trim();
  const valid = isHttpUrl(trimmed);

  function submit() {
    if (!valid) return;
    onAdd({ kind, id: trimmed }, level);
    setValue("");
  }

  return (
    <form
      className="mt-1 flex flex-col gap-2 rounded-xl border border-dashed border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Label htmlFor="share-add" className="text-xs text-muted-foreground">
        Add by {kind === "agent" ? "WebID" : "group address"}
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id="share-add"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={
            kind === "agent"
              ? "https://example.org/profile/card#me"
              : "https://example.org/groups/team#it"
          }
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
        />
        <LevelPicker level={level} disabled={busy} onChange={setLevel} />
        <Button type="submit" size="sm" disabled={busy || !valid}>
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Plus className="size-4" aria-hidden="true" />
          )}
          Add
        </Button>
      </div>
      <div className="flex items-center gap-3 text-xs">
        <button
          type="button"
          className={kind === "agent" ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}
          onClick={() => setKind("agent")}
        >
          A person
        </button>
        <button
          type="button"
          className={kind === "group" ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}
          onClick={() => setKind("group")}
        >
          A group
        </button>
        {trimmed && !valid ? (
          <span className="text-destructive">Enter a full web address (https://…).</span>
        ) : null}
      </div>
    </form>
  );
}

/** Inherited-access banner with a "set specific access" promotion. */
function InheritanceNotice({
  busy,
  onSetSpecific,
}: {
  busy: boolean;
  onSetSpecific: () => void;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-border bg-accent/30 p-4 text-sm">
      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
      <div className="flex-1">
        <p className="font-medium">Access is inherited from the folder it lives in.</p>
        <p className="mt-0.5 text-muted-foreground">
          Changes here will create access settings specific to this item, copying
          the current ones so no one loses access.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          disabled={busy}
          onClick={onSetSpecific}
        >
          Set specific access
        </Button>
      </div>
    </div>
  );
}

/**
 * A browser-app origin for display — the FULL origin (scheme + host) so
 * `http://app.example` and `https://app.example` are never shown identically
 * in an access-control UI (roborev). The exact IRI stays in the title/key.
 */
function originHost(origin: string): string {
  try {
    return new URL(origin).origin || origin;
  } catch {
    return origin;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Turn a mutation error into honest, plain-language toast copy. */
function mutationMessage(e: unknown): { title: string; description: string } {
  if (e instanceof AclWriteError) {
    const cause = String((e as { cause?: unknown }).cause ?? "");
    if (cause.includes("forbidden") || cause.includes("403") || cause.includes("401")) {
      return {
        title: "You don't have permission to change sharing here.",
        description: "You need to be an Owner of this item. Nothing was changed.",
      };
    }
    return {
      title: "Couldn't update access.",
      // The backend's own message is already plain-language (e.g. the
      // conflict/self-lockout copy); surface it.
      description: e.message,
    };
  }
  return {
    title: "Couldn't update access.",
    description: "Nothing was changed. Check your connection and try again.",
  };
}
