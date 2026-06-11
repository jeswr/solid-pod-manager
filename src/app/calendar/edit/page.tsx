"use client";

/**
 * Event editor — create (no `?id=`) or edit/delete an existing event
 * (`?id=` = the event's resource URL). A query parameter rather than a path
 * segment so the page prerenders under `output: "export"`. A start time is
 * required; the rest are optional. Conditional writes use the read ETag
 * (412 → reopen).
 */
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, Loader2, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { calendarStore, type CalendarEvent } from "@/lib/calendar";
import { useStore, useItem } from "@/components/use-productivity";
import { ErrorState } from "@/components/states";
import { ResourceWriteError } from "@/lib/errors";
import { fromDateTimeLocal, toDateTimeLocal } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";

/** A sensible default start for a new event: the next whole hour. */
function nextHour(): Date {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

export default function EventEditorPage() {
  // useSearchParams requires a Suspense boundary in a prerendered page.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <EventEditor />
    </Suspense>
  );
}

function EventEditor() {
  // `?id=` is the event's resource URL (URLSearchParams decodes it); absent → new.
  const url = useSearchParams().get("id") ?? undefined;
  const isNew = !url;

  const router = useRouter();
  const store = useStore<CalendarEvent>(calendarStore);
  const { data: item, loading, error } = useItem(store, url);

  const [name, setName] = useState("");
  const [start, setStart] = useState(() => toDateTimeLocal(nextHour()));
  const [end, setEnd] = useState("");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [etag, setEtag] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (item) {
      setName(item.data.name);
      setStart(toDateTimeLocal(item.data.start));
      setEnd(toDateTimeLocal(item.data.end));
      setLocation(item.data.location ?? "");
      setDescription(item.data.description ?? "");
      setEtag(item.etag);
    }
  }, [item]);

  const ready = Boolean(store) && (isNew || Boolean(item) || !loading);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!store) return;
    const startDate = fromDateTimeLocal(start);
    if (!startDate) {
      toast.error("Please choose a start date and time.");
      return;
    }
    setSaving(true);
    try {
      const event: CalendarEvent = {
        name,
        start: startDate,
        end: fromDateTimeLocal(end),
        location: location || undefined,
        description: description || undefined,
      };
      if (isNew) {
        const { url: created } = await store.create(event, name);
        toast.success("Event created");
        router.replace(`/calendar/edit?id=${encodeURIComponent(created)}`);
      } else if (url) {
        await store.update(url, event, etag);
        toast.success("Event saved");
        router.push("/calendar");
      }
    } catch (err) {
      if (err instanceof ResourceWriteError && err.status === 412) {
        toast.error("This event changed elsewhere. Reopen it and try again.");
      } else {
        toast.error("Could not save your event. Please try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!store || !url) return;
    setDeleting(true);
    try {
      await store.remove(url);
      toast.success("Event deleted");
      router.push("/calendar");
    } catch {
      toast.error("Could not delete this event. Please try again.");
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <ol className="flex items-center gap-1">
          <li>
            <Link href="/calendar" className="hover:text-foreground hover:underline">
              Calendar
            </Link>
          </li>
          <ChevronRight className="size-4" aria-hidden="true" />
          <li aria-current="page" className="font-medium text-foreground">
            {isNew ? "New event" : "Edit event"}
          </li>
        </ol>
      </nav>

      {error ? (
        <ErrorState error={error} />
      ) : !ready ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <form onSubmit={onSave} className="flex max-w-xl flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="event-name">Title</Label>
            <Input
              id="event-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Untitled event"
              autoFocus={isNew}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="event-start">Starts</Label>
              <Input
                id="event-start"
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="event-end">Ends (optional)</Label>
              <Input
                id="event-end"
                type="datetime-local"
                value={end}
                min={start || undefined}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="event-location">Location (optional)</Label>
            <Input
              id="event-location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Where is it?"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="event-description">Description (optional)</Label>
            <Textarea
              id="event-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add details, an agenda, a link…"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={saving}>
              {saving ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Save aria-hidden="true" />
              )}
              {isNew ? "Create event" : "Save changes"}
            </Button>
            <Button type="button" variant="ghost" asChild>
              <Link href="/calendar">Cancel</Link>
            </Button>
            {!isNew && (
              <Button
                type="button"
                variant="destructive"
                className="ml-auto"
                onClick={onDelete}
                disabled={deleting}
              >
                {deleting ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <Trash2 aria-hidden="true" />
                )}
                Delete
              </Button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
