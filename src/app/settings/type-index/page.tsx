// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Type-index management — view + manage the public and private type-index
 * registrations (`solid:TypeRegistration`: which RDF class is stored where).
 * A SolidOS capability: see what's registered, add a registration, remove one.
 * Read + write go through `type-index-manage` (read-modify-write, conditional).
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, Loader2, ListTree, Lock, Plus, Trash2, Globe2 } from "lucide-react";
import { toast } from "sonner";
import { useTypeIndex } from "@/components/use-type-index";
import {
  addRegistration,
  removeRegistration,
  type IndexKind,
  type ManagedRegistration,
} from "@/lib/type-index-manage";
import { categoryForClass } from "@/lib/categories";
import { EmptyState, ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

/** Last path segment of a class IRI, for a compact label. */
function classTail(iri: string): string {
  const m = /[#/]([^#/]+)$/.exec(iri);
  return m ? m[1] : iri;
}

export default function TypeIndexPage() {
  const { data, loading, error, reload } = useTypeIndex();
  const [busy, setBusy] = useState<string | null>(null);

  async function onRemove(reg: ManagedRegistration) {
    setBusy(reg.subject);
    try {
      await removeRegistration({ indexUrl: reg.indexUrl, subject: reg.subject });
      toast.success("Registration removed");
      reload();
    } catch {
      toast.error("Could not remove this registration. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  const grouped = useMemo(() => {
    const out: Record<IndexKind, ManagedRegistration[]> = { public: [], private: [] };
    for (const r of data?.registrations ?? []) out[r.indexKind].push(r);
    return out;
  }, [data]);

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <ol className="flex items-center gap-1">
          <li>
            <Link href="/settings" className="hover:text-foreground hover:underline">
              Settings
            </Link>
          </li>
          <ChevronRight className="size-4" aria-hidden="true" />
          <li aria-current="page" className="font-medium text-foreground">
            Type index
          </li>
        </ol>
      </nav>

      <header className="flex items-start gap-4">
        <span
          aria-hidden="true"
          className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"
        >
          <ListTree className="size-6" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Type index</h1>
          <p className="measure mt-1 text-sm text-muted-foreground text-pretty">
            The map that tells apps where each kind of your data lives. Most people
            never need to touch this — it is here for full control.
          </p>
        </div>
      </header>

      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <>
          <IndexGroup
            kind="public"
            indexUrl={data?.publicIndex}
            registrations={grouped.public}
            busy={busy}
            onRemove={onRemove}
            onAdded={reload}
          />
          <IndexGroup
            kind="private"
            indexUrl={data?.privateIndex}
            registrations={grouped.private}
            busy={busy}
            onRemove={onRemove}
            onAdded={reload}
          />
        </>
      )}
    </div>
  );
}

function IndexGroup({
  kind,
  indexUrl,
  registrations,
  busy,
  onRemove,
  onAdded,
}: {
  kind: IndexKind;
  indexUrl?: string;
  registrations: ManagedRegistration[];
  busy: string | null;
  onRemove: (reg: ManagedRegistration) => void;
  onAdded: () => void;
}) {
  const isPublic = kind === "public";
  const Icon = isPublic ? Globe2 : Lock;
  const title = isPublic ? "Public type index" : "Private type index";
  const blurb = isPublic
    ? "Anyone can read these pointers — they help other apps discover your shared data."
    : "Only you (and apps you allow) can read these pointers. Your private data index is referenced only from your private preferences file, not your public profile.";

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
            {title}
          </CardTitle>
          {indexUrl ? (
            <AddRegistration indexUrl={indexUrl} onAdded={onAdded} />
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">{blurb}</p>
      </CardHeader>
      <CardContent>
        {!indexUrl ? (
          <p className="text-sm text-muted-foreground">
            You do not have a {isPublic ? "public" : "private"} type index yet. One is
            created automatically the first time an app registers data.
          </p>
        ) : registrations.length === 0 ? (
          <EmptyState
            icon={ListTree}
            title="No registrations"
            description="Nothing is registered in this index yet."
          />
        ) : (
          <ul className="flex flex-col gap-2" aria-label={`${title} registrations`}>
            {registrations.map((reg) => {
              const location = reg.container ?? reg.instance ?? "";
              return (
                <li
                  key={reg.subject}
                  className="flex items-start justify-between gap-3 rounded-xl border border-border bg-background p-3"
                >
                  <div className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{classTail(reg.forClass)}</span>
                      <Badge variant="secondary">{categoryForClass(reg.forClass).label}</Badge>
                      {reg.container ? (
                        <Badge variant="outline">folder</Badge>
                      ) : (
                        <Badge variant="outline">file</Badge>
                      )}
                    </span>
                    <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                      {location}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[0.7rem] text-muted-foreground/70">
                      {reg.forClass}
                    </span>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy === reg.subject}
                        aria-label={`Remove ${classTail(reg.forClass)} registration`}
                      >
                        {busy === reg.subject ? (
                          <Loader2 className="animate-spin" aria-hidden="true" />
                        ) : (
                          <Trash2 aria-hidden="true" />
                        )}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Remove this registration?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Apps may no longer discover your{" "}
                          <strong>{classTail(reg.forClass)}</strong> data automatically.
                          This does not delete the data itself.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => onRemove(reg)}>
                          Remove
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AddRegistration({ indexUrl, onAdded }: { indexUrl: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [forClass, setForClass] = useState("");
  const [target, setTarget] = useState("");
  const [kind, setKind] = useState<"container" | "instance">("container");
  const [saving, setSaving] = useState(false);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!/^https?:\/\//i.test(forClass.trim())) {
      toast.error("The type must be a full IRI (https://…).");
      return;
    }
    if (!/^https?:\/\//i.test(target.trim())) {
      toast.error("The location must be a full URL (https://…).");
      return;
    }
    setSaving(true);
    try {
      const res = await addRegistration({
        indexUrl,
        registration:
          kind === "container"
            ? { forClass: forClass.trim(), container: target.trim() }
            : { forClass: forClass.trim(), instance: target.trim() },
      });
      toast.success(res.added ? "Registration added" : "That registration already exists");
      setForClass("");
      setTarget("");
      setOpen(false);
      onAdded();
    } catch {
      toast.error("Could not add this registration. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" />
        Add
      </Button>
    );
  }

  return (
    <form
      onSubmit={onAdd}
      className="mt-2 flex w-full flex-col gap-3 rounded-xl border border-border bg-background p-3"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${indexUrl}-class`}>Type (RDF class IRI)</Label>
        <Input
          id={`${indexUrl}-class`}
          value={forClass}
          onChange={(e) => setForClass(e.target.value)}
          placeholder="http://schema.org/Recipe"
        />
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-sm font-medium">Where the data lives</legend>
        <div className="flex gap-3 text-sm">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name={`${indexUrl}-kind`}
              checked={kind === "container"}
              onChange={() => setKind("container")}
            />
            A folder
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name={`${indexUrl}-kind`}
              checked={kind === "instance"}
              onChange={() => setKind("instance")}
            />
            A single file
          </label>
        </div>
        <Input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          aria-label="Location URL"
          placeholder={kind === "container" ? "https://…/recipes/" : "https://…/recipes.ttl"}
        />
      </fieldset>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Add registration
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
