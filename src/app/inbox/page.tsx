// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Inbox — the user's LDN inbox. Lists incoming ActivityStreams 2.0
 * notifications (newest first), with mark-read / dismiss, plus a "Send
 * notification" affordance that picks a recipient (PeoplePicker) and delivers a
 * cross-pod notification via the SSRF-hardened `sendNotification`.
 *
 * Live updates: subscribes to the inbox container so new notifications appear
 * without polling. All content links render through `safeLinkHref`.
 */
import { useState } from "react";
import { Inbox as InboxIcon, Loader2, MailCheck, Send, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/components/session-provider";
import { useInbox } from "@/components/use-inbox";
import { useResourceNotifications } from "@/components/use-resource-notifications";
import { PeoplePicker } from "@/components/people-picker";
import { EmptyState, ErrorState } from "@/components/states";
import { ItemRowSkeleton } from "@/components/item-row";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { safeLinkHref } from "@/lib/pod-scope";
import { sendNotification } from "@/lib/notify-send";
import { NoInboxError, InvalidTargetError, NotificationSendError } from "@/lib/errors";
import type { InboxNotification } from "@/lib/inbox";

export default function InboxPage() {
  const { webId } = useSession();
  const { data, loading, error, inboxUrl, reload, markRead, dismiss } = useInbox();
  const [composing, setComposing] = useState(false);

  // Live-update: re-list when the inbox container changes.
  useResourceNotifications(inboxUrl, reload);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"
          >
            <InboxIcon className="size-6" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
            <p className="measure mt-1 text-sm text-muted-foreground text-pretty">
              Notifications other people send to your pod.
            </p>
          </div>
        </div>
        <Button onClick={() => setComposing((c) => !c)} variant={composing ? "secondary" : "default"}>
          <Send aria-hidden="true" />
          {composing ? "Close" : "Send notification"}
        </Button>
      </header>

      {composing && webId && (
        <ComposeNotification actorWebId={webId} onSent={() => setComposing(false)} />
      )}

      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading ? (
        <ul className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <ItemRowSkeleton key={i} />
          ))}
        </ul>
      ) : !inboxUrl ? (
        <EmptyState
          icon={InboxIcon}
          title="No inbox yet"
          description="Your profile doesn't advertise an inbox in this pod, so there's nothing to receive into."
        />
      ) : (data?.length ?? 0) === 0 ? (
        <EmptyState
          icon={InboxIcon}
          title="Your inbox is empty"
          description="When someone sends you a notification, it shows up here."
        />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Your notifications">
          {data?.map((n) => (
            <li key={n.url}>
              <NotificationRow
                n={n}
                onMarkRead={() => void doAction(() => markRead(n.url), "Marked as read")}
                onDismiss={() => void doAction(() => dismiss(n.url), "Dismissed")}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Render a published timestamp, omitting it for missing/invalid dates. */
function formatPublished(published: string | undefined): string {
  if (!published) return "";
  const d = new Date(published);
  return Number.isNaN(d.getTime()) ? "" : ` · ${d.toLocaleString()}`;
}

async function doAction(action: () => Promise<void>, okMessage: string) {
  try {
    await action();
    toast.success(okMessage);
  } catch {
    toast.error("Could not update this notification. Please try again.");
  }
}

function NotificationRow({
  n,
  onMarkRead,
  onDismiss,
}: {
  n: InboxNotification;
  onMarkRead: () => void;
  onDismiss: () => void;
}) {
  const actorHref = n.actor ? safeLinkHref(n.actor) : undefined;
  const objectHref = n.object ? safeLinkHref(n.object) : undefined;
  return (
    <div
      className={`flex items-start gap-3 rounded-xl border border-border bg-card p-3 ${
        n.read ? "opacity-70" : ""
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <Badge variant={n.read ? "outline" : "default"} className="shrink-0">
            {n.type}
          </Badge>
          {n.summary && <span className="truncate font-medium">{n.summary}</span>}
        </span>
        {n.content && <span className="mt-1 block text-sm text-muted-foreground">{n.content}</span>}
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {actorHref ? (
            <a href={actorHref} className="hover:underline" rel="noopener noreferrer">
              {n.actor}
            </a>
          ) : (
            n.actor ?? "Unknown sender"
          )}
          {formatPublished(n.published)}
        </span>
        {objectHref && (
          <a
            href={objectHref}
            rel="noopener noreferrer"
            className="mt-1 block truncate text-xs text-primary hover:underline"
          >
            {n.object}
          </a>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {!n.read && (
          <Button type="button" variant="ghost" size="icon" onClick={onMarkRead} aria-label="Mark as read">
            <MailCheck className="size-4" aria-hidden="true" />
          </Button>
        )}
        <Button type="button" variant="ghost" size="icon" onClick={onDismiss} aria-label="Dismiss">
          <Trash2 className="size-4" aria-hidden="true" />
        </Button>
      </span>
    </div>
  );
}

function ComposeNotification({ actorWebId, onSent }: { actorWebId: string; onSent: () => void }) {
  const [recipients, setRecipients] = useState<string[]>([]);
  const [summary, setSummary] = useState("");
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);

  async function onSend() {
    const recipient = recipients[0];
    if (!recipient) {
      toast.error("Pick a recipient first.");
      return;
    }
    setSending(true);
    try {
      // sendNotification discovers + STRICT-validates the recipient inbox before
      // any POST (SSRF guard) — production passes no fetch (auth-patched global).
      await sendNotification({
        recipientWebId: recipient,
        actorWebId,
        type: "Announce",
        summary: summary.trim() || undefined,
        content: content.trim() || undefined,
      });
      toast.success("Notification sent");
      onSent();
    } catch (e) {
      if (e instanceof NoInboxError) {
        toast.error("This person's pod doesn't advertise an inbox.");
      } else if (e instanceof InvalidTargetError) {
        toast.error("That inbox address isn't safe to send to.");
      } else if (e instanceof NotificationSendError) {
        toast.error("Their inbox rejected the notification. Please try again later.");
      } else {
        toast.error("Could not send the notification. Please try again.");
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-muted/30 p-4">
      <div className="flex flex-col gap-1.5">
        <Label>Recipient</Label>
        <PeoplePicker value={recipients} onChange={setRecipients} single label="Find a recipient" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="notif-summary">Summary</Label>
        <Input
          id="notif-summary"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="A short headline"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="notif-content">Message (optional)</Label>
        <Textarea
          id="notif-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Add any details…"
        />
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" onClick={() => void onSend()} disabled={sending || recipients.length === 0}>
          {sending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
          Send
        </Button>
        <Button type="button" variant="ghost" onClick={onSent}>
          <X aria-hidden="true" />
          Cancel
        </Button>
      </div>
    </div>
  );
}
