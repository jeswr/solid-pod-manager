// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Events renderer (design: `docs/typed-data-views.md` P3): a list of event
 * cards — date/time + title + location — with an **"Open in Google Calendar"**
 * action and **no raw triples / no raw URLs**. Consumes the pure `EventModel`;
 * all RDF stayed in `lib/`.
 *
 * The pure layer keeps the start/end as raw ISO strings (locale/timezone
 * neutral + serialisable); this card formats them for display in the user's
 * locale via `Intl`.
 */
import { CalendarDays, MapPin } from "lucide-react";
import type { CalendarEventItem, EventModel } from "@/lib/typed-views/event-view";
import { Card, CardContent } from "@/components/ui/card";
import { SourceActionButton } from "@/components/typed-views/source-action";

/** The event-card list for an events resource. */
export function EventCardList({ model }: { model: EventModel; url: string }) {
  if (model.items.length === 0) {
    return <p className="text-sm text-muted-foreground">No events found in this resource.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {model.items.map((event) => (
        <EventRow key={event.id} event={event} />
      ))}
    </div>
  );
}

function EventRow({ event }: { event: CalendarEventItem }) {
  const when = formatRange(event.startDate, event.endDate);

  return (
    <Card>
      <CardContent className="flex items-start gap-4 py-4">
        <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-accent text-accent-foreground">
          <CalendarDays className="size-5" aria-hidden="true" />
        </div>

        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-medium leading-tight">{event.title}</span>
          {when && <span className="text-sm text-muted-foreground">{when}</span>}
          {event.location && (
            <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
              <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{event.location}</span>
            </span>
          )}
          {event.description && (
            <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">{event.description}</p>
          )}

          {event.source && (
            <div className="mt-2 flex flex-wrap gap-2">
              <SourceActionButton source={event.source} />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Locale-friendly date/time, e.g. "11 Jun 2026, 09:00 – 09:15". Tolerates bad input. */
function formatRange(startIso?: string, endIso?: string): string | undefined {
  const start = parse(startIso);
  if (!start) return undefined;
  const end = parse(endIso);

  const dateFmt = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

  // All-day events (adapter writes midnight UTC) — show the date only.
  const startHasTime = !/T00:00:00(?:\.000)?Z?$/.test(startIso ?? "");
  const base = startHasTime ? `${dateFmt.format(start)}, ${timeFmt.format(start)}` : dateFmt.format(start);

  if (!end) return base;
  // Same calendar day → only show the end time; otherwise the full end date.
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  if (!startHasTime) return base; // all-day: skip the end timestamp
  const endStr = sameDay ? timeFmt.format(end) : `${dateFmt.format(end)}, ${timeFmt.format(end)}`;
  return `${base} – ${endStr}`;
}

function parse(iso?: string): Date | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : new Date(t);
}
