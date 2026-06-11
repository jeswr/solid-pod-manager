"use client";

/**
 * Calendar — a first-party productivity app. Events (`schema:Event` under
 * `calendar/`) shown two ways: an agenda (upcoming, grouped by day) and a
 * simple month grid. Create / open / edit / delete via `/calendar/[id]`.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  Plus,
} from "lucide-react";
import {
  calendarStore,
  groupByDay,
  monthMatrix,
  type CalendarEvent,
} from "@/lib/calendar";
import { useStore, useItems } from "@/components/use-productivity";
import { EmptyState, ErrorState } from "@/components/states";
import { ItemRowSkeleton } from "@/components/item-row";
import { Button } from "@/components/ui/button";
import { formatTime } from "@/lib/format";
import type { StoredItem } from "@/lib/productivity-store";
import { cn } from "@/lib/utils";

type View = "agenda" | "month";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export default function CalendarPage() {
  const store = useStore<CalendarEvent>(calendarStore);
  const { data, loading, error, reload } = useItems(store);
  const [view, setView] = useState<View>("agenda");
  const [anchor, setAnchor] = useState(() => new Date());

  const events = data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"
          >
            <CalendarDays className="size-6" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Calendar</h1>
            <p className="measure mt-1 text-sm text-muted-foreground text-pretty">
              Your events, stored privately in your pod.
            </p>
          </div>
        </div>
        <Button asChild>
          <Link href="/calendar/edit">
            <Plus aria-hidden="true" />
            New event
          </Link>
        </Button>
      </header>

      <div
        role="tablist"
        aria-label="Calendar view"
        className="inline-flex w-fit gap-1 rounded-lg bg-muted p-1"
      >
        {(["agenda", "month"] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={cn(
              "rounded-md px-3 py-1 text-sm font-medium capitalize transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              view === v
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {v}
          </button>
        ))}
      </div>

      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading ? (
        <ul className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <ItemRowSkeleton key={i} />
          ))}
        </ul>
      ) : events.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="No events yet"
          description="Add your first event. It is saved privately to your pod."
          action={
            <Button asChild>
              <Link href="/calendar/edit">
                <Plus aria-hidden="true" />
                New event
              </Link>
            </Button>
          }
        />
      ) : view === "agenda" ? (
        <AgendaView events={events} />
      ) : (
        <MonthView
          events={events}
          anchor={anchor}
          onPrev={() => setAnchor((a) => new Date(a.getFullYear(), a.getMonth() - 1, 1))}
          onNext={() => setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + 1, 1))}
          onToday={() => setAnchor(new Date())}
        />
      )}
    </div>
  );
}

function AgendaView({ events }: { events: StoredItem<CalendarEvent>[] }) {
  const days = useMemo(() => groupByDay(events), [events]);
  return (
    <div className="flex flex-col gap-6">
      {days.map((day) => (
        <section key={day.key} aria-label={day.date.toDateString()} className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground">
            {day.date.toLocaleDateString(undefined, {
              weekday: "long",
              month: "short",
              day: "numeric",
            })}
          </h2>
          <ul className="flex flex-col gap-2">
            {day.events.map((ev) => (
              <li key={ev.url}>
                <EventRow event={ev} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function EventRow({ event }: { event: StoredItem<CalendarEvent> }) {
  const e = event.data;
  const href = `/calendar/edit?id=${encodeURIComponent(event.url)}`;
  return (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span className="flex w-16 shrink-0 flex-col items-center rounded-lg bg-muted py-1.5 text-center">
        <span className="text-sm font-semibold tabular">{formatTime(e.start)}</span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{e.name.trim() || "Untitled event"}</span>
        <span className="flex items-center gap-3 truncate text-xs text-muted-foreground">
          {e.end && (
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3" aria-hidden="true" />
              until {formatTime(e.end)}
            </span>
          )}
          {e.location && (
            <span className="inline-flex items-center gap-1 truncate">
              <MapPin className="size-3" aria-hidden="true" />
              {e.location}
            </span>
          )}
        </span>
      </span>
      <ChevronRight
        className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
        aria-hidden="true"
      />
    </Link>
  );
}

function MonthView({
  events,
  anchor,
  onPrev,
  onNext,
  onToday,
}: {
  events: StoredItem<CalendarEvent>[];
  anchor: Date;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
}) {
  const weeks = useMemo(() => monthMatrix(anchor, events), [anchor, events]);
  const todayKey = new Date().toDateString();
  const monthLabel = anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{monthLabel}</h2>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={onToday}>
            Today
          </Button>
          <Button variant="outline" size="icon-sm" onClick={onPrev} aria-label="Previous month">
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button variant="outline" size="icon-sm" onClick={onNext} aria-label="Next month">
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-border bg-border">
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            className="bg-muted px-2 py-1.5 text-center text-xs font-medium text-muted-foreground"
          >
            <span className="sr-only">{d}</span>
            <span aria-hidden="true">{d.slice(0, 2)}</span>
          </div>
        ))}
        {weeks.flat().map((cell) => {
          const isToday = cell.date.toDateString() === todayKey;
          return (
            <div
              key={cell.date.toISOString()}
              className={cn(
                "flex min-h-20 flex-col gap-1 bg-card p-1.5",
                !cell.inMonth && "bg-muted/40 text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "self-start text-xs tabular",
                  isToday &&
                    "grid size-5 place-items-center rounded-full bg-primary font-semibold text-primary-foreground",
                )}
              >
                {cell.date.getDate()}
              </span>
              <ul className="flex flex-col gap-0.5">
                {cell.events.slice(0, 3).map((ev) => (
                  <li key={ev.url}>
                    <Link
                      href={`/calendar/edit?id=${encodeURIComponent(ev.url)}`}
                      className="block truncate rounded bg-accent px-1 py-0.5 text-[11px] text-accent-foreground hover:bg-accent/70 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                      title={ev.data.name}
                    >
                      {formatTime(ev.data.start)} {ev.data.name.trim() || "Event"}
                    </Link>
                  </li>
                ))}
                {cell.events.length > 3 && (
                  <li className="px-1 text-[11px] text-muted-foreground">
                    +{cell.events.length - 3} more
                  </li>
                )}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
