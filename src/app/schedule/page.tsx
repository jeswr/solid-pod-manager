// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Scheduling / RSVP — propose an event poll with several time options, invite
 * agents (cross-pod via the SSRF-hardened sendNotification), collect RSVPs, and
 * see a per-option tally. The poll lives in the organiser's own pod under
 * `schedule/` (Type-Index registered via the store engine). `?id=<pollUrl>`
 * opens a poll (scope-guarded by the store's assertInContainer); no id shows the
 * list + a "New poll" form.
 */
import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CalendarClock, Check, Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/components/session-provider";
import { useStore, useItems, useItem } from "@/components/use-productivity";
import { EmptyState, ErrorState } from "@/components/states";
import { ItemRowSkeleton } from "@/components/item-row";
import { PeoplePicker } from "@/components/people-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  scheduleStore,
  tallyRsvps,
  winningOption,
  type Poll,
  type RsvpResponse,
} from "@/lib/schedule";
import { sendNotification } from "@/lib/notify-send";
import { fromDateTimeLocal, formatDateTime } from "@/lib/format";

export default function SchedulePage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <ScheduleInner />
    </Suspense>
  );
}

function ScheduleInner() {
  const id = useSearchParams().get("id") ?? undefined;
  return id ? <PollDetail pollUrl={id} /> : <PollList />;
}

function PollList() {
  const store = useStore<Poll>(scheduleStore);
  const { data, loading, error, reload } = useItems(store);
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"
          >
            <CalendarClock className="size-6" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Scheduling</h1>
            <p className="measure mt-1 text-sm text-muted-foreground text-pretty">
              Propose times, invite people, and tally RSVPs — stored in your pod.
            </p>
          </div>
        </div>
        <Button onClick={() => setCreating((c) => !c)} variant={creating ? "secondary" : "default"}>
          <Plus aria-hidden="true" />
          {creating ? "Close" : "New poll"}
        </Button>
      </header>

      {creating && <NewPoll onCreated={reload} />}

      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading ? (
        <ul className="flex flex-col gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <ItemRowSkeleton key={i} />
          ))}
        </ul>
      ) : (data?.length ?? 0) === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No polls yet"
          description="Create a poll to find a time that works for everyone."
        />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Your polls">
          {data?.map((p) => (
            <li key={p.url}>
              <Link
                href={`/schedule?id=${encodeURIComponent(p.url)}`}
                className="flex items-center gap-3 rounded-xl border border-border bg-card p-3 hover:bg-accent/40"
              >
                <Badge variant="secondary" className="shrink-0">
                  {p.data.options.length} option{p.data.options.length === 1 ? "" : "s"}
                </Badge>
                <span className="min-w-0 flex-1 truncate font-medium">
                  {p.data.name.trim() || "Untitled poll"}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {p.data.invitees.length} invited
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewPoll({ onCreated }: { onCreated: () => void }) {
  const { webId } = useSession();
  const store = useStore<Poll>(scheduleStore);
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [options, setOptions] = useState<string[]>([""]);
  const [invitees, setInvitees] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  function setOption(i: number, value: string) {
    setOptions((opts) => opts.map((o, idx) => (idx === i ? value : o)));
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!store || !webId) return;
    if (!name.trim()) {
      toast.error("Give the poll a name.");
      return;
    }
    const isoOptions = options
      .map((o) => fromDateTimeLocal(o))
      .filter((d): d is Date => d !== undefined)
      .map((d) => d.toISOString());
    if (isoOptions.length === 0) {
      toast.error("Add at least one time option.");
      return;
    }
    setSaving(true);
    try {
      const poll: Poll = {
        name: name.trim(),
        description: description.trim() || undefined,
        organizer: webId,
        options: isoOptions,
        invitees,
        rsvps: [],
      };
      const { url } = await store.create(poll, name);
      // Notify each invitee (strict-validated target). Failures don't block.
      await Promise.allSettled(
        invitees.map((recipient) =>
          sendNotification({
            recipientWebId: recipient,
            actorWebId: webId,
            type: "Invite",
            summary: `${name.trim()} — please RSVP`,
            object: url,
          }),
        ),
      );
      toast.success("Poll created");
      onCreated();
      router.push(`/schedule?id=${encodeURIComponent(url)}`);
    } catch {
      toast.error("Could not create the poll. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onCreate} className="flex flex-col gap-5 rounded-xl border border-border bg-muted/30 p-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="poll-name">Name</Label>
        <Input id="poll-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Team dinner" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="poll-desc">Description (optional)</Label>
        <Textarea id="poll-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Time options</legend>
        {options.map((o, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              type="datetime-local"
              value={o}
              onChange={(e) => setOption(i, e.target.value)}
              aria-label={`Option ${i + 1}`}
            />
            {options.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setOptions((opts) => opts.filter((_, idx) => idx !== i))}
                aria-label={`Remove option ${i + 1}`}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            )}
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => setOptions((o) => [...o, ""])}>
          <Plus aria-hidden="true" />
          Add option
        </Button>
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <Label>Invite people (optional)</Label>
        <PeoplePicker value={invitees} onChange={setInvitees} label="Find people to invite" />
      </div>
      <div>
        <Button type="submit" disabled={saving}>
          {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}
          Create poll
        </Button>
      </div>
    </form>
  );
}

function PollDetail({ pollUrl }: { pollUrl: string }) {
  const { webId } = useSession();
  const store = useStore<Poll>(scheduleStore);
  const { data: item, loading, error, reload } = useItem(store, pollUrl);
  const [saving, setSaving] = useState(false);

  const poll = item?.data;
  const tallies = useMemo(
    () => (poll ? tallyRsvps(poll.options, poll.rsvps) : []),
    [poll],
  );
  const winner = useMemo(() => winningOption(tallies), [tallies]);

  async function rsvp(option: string, response: RsvpResponse) {
    if (!store || !poll || !webId || !item) return;
    setSaving(true);
    try {
      // Upsert this attendee's response for the option (last-wins; the tally
      // collapses duplicates too, but we keep the stored set tidy).
      const rsvps = [
        ...poll.rsvps.filter((r) => !(r.attendee === webId && r.option === option)),
        { attendee: webId, option, response },
      ];
      await store.update(pollUrl, { ...poll, rsvps }, item.etag);
      toast.success("RSVP saved");
      reload();
    } catch {
      toast.error("Could not save your RSVP. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <Link href="/schedule" className="hover:text-foreground hover:underline">
          ← All polls
        </Link>
      </nav>

      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading || !poll ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <>
          <header>
            <h1 className="text-2xl font-semibold tracking-tight">{poll.name.trim() || "Untitled poll"}</h1>
            {poll.description && <p className="mt-1 text-sm text-muted-foreground">{poll.description}</p>}
          </header>

          <ul className="flex flex-col gap-2" aria-label="Time options">
            {tallies.map((t) => {
              const mine = poll.rsvps.find((r) => r.attendee === webId && r.option === t.option);
              const isWinner = winner?.option === t.option && t.yes > 0;
              return (
                <li
                  key={t.option}
                  className={`flex flex-wrap items-center gap-3 rounded-xl border p-3 ${
                    isWinner ? "border-primary bg-primary/5" : "border-border bg-card"
                  }`}
                >
                  <span className="min-w-0 flex-1 font-medium">
                    {formatDateTime(new Date(t.option))}
                    {isWinner && (
                      <Badge variant="default" className="ml-2">
                        Leading
                      </Badge>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t.yes} yes · {t.maybe} maybe · {t.no} no
                  </span>
                  <span className="flex items-center gap-1">
                    {(["yes", "maybe", "no"] as RsvpResponse[]).map((r) => (
                      <Button
                        key={r}
                        type="button"
                        size="sm"
                        variant={mine?.response === r ? "default" : "outline"}
                        disabled={saving}
                        onClick={() => void rsvp(t.option, r)}
                      >
                        {mine?.response === r && <Check className="size-3" aria-hidden="true" />}
                        {r}
                      </Button>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>

          {poll.invitees.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Invited: {poll.invitees.length} {poll.invitees.length === 1 ? "person" : "people"}
            </p>
          )}
        </>
      )}
    </div>
  );
}
