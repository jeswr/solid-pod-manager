// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Chat — an append-only message log under the user's pod. With `?url=<container>`
 * it shows that chat (validated within the user's own pods — confused-deputy
 * guard on the param); without it, a form to start a new chat (PeoplePicker +
 * channel name) that mints `chat/<channel>/` and optionally notifies the
 * contact via the SSRF-hardened sendNotification.
 *
 * Live updates: subscribes to the chat container so new messages appear without
 * polling. Messages render oldest→newest.
 */
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, MessagesSquare, Send } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/components/session-provider";
import { useChat } from "@/components/use-chat";
import { useResourceNotifications } from "@/components/use-resource-notifications";
import { LaunchInApp } from "@/components/launch-in-app";
import { PeoplePicker } from "@/components/people-picker";
import { EmptyState, ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { chatContainerUrl } from "@/lib/chat";
import { sendNotification } from "@/lib/notify-send";
import { safeLinkHref } from "@/lib/pod-scope";

export default function ChatPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <ChatInner />
    </Suspense>
  );
}

function ChatInner() {
  const url = useSearchParams().get("url") ?? undefined;
  return url ? <ChatView containerUrl={url} /> : <StartChat />;
}

function ChatView({ containerUrl }: { containerUrl: string }) {
  const { webId } = useSession();
  const { data, loading, error, reload, send, outOfScope, readOnly } = useChat(containerUrl);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  useResourceNotifications(outOfScope ? undefined : containerUrl, reload);

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    setSending(true);
    try {
      await send(draft);
      setDraft("");
    } catch {
      toast.error("Could not send your message. Please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"
          >
            <MessagesSquare className="size-6" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Chat</h1>
            <p className="measure mt-1 text-sm text-muted-foreground text-pretty break-all">
              {containerUrl}
            </p>
          </div>
        </div>
        <LaunchInApp app="chat" />
      </header>

      {error ? (
        <ErrorState error={error} onRetry={outOfScope ? undefined : reload} />
      ) : loading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (data?.length ?? 0) === 0 ? (
        <EmptyState icon={MessagesSquare} title="No messages yet" description="Say hello to start the conversation." />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Messages">
          {data?.map((m) => {
            const authorHref = m.author ? safeLinkHref(m.author) : undefined;
            const mine = m.author === webId;
            return (
              <li
                key={m.url}
                className={`max-w-[80%] rounded-xl border border-border p-3 ${
                  mine ? "self-end bg-primary/10" : "bg-card"
                }`}
              >
                <p className="text-sm whitespace-pre-wrap break-words">{m.content}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {authorHref ? (
                    <a href={authorHref} rel="noopener noreferrer" className="hover:underline">
                      {mine ? "You" : m.author}
                    </a>
                  ) : (
                    m.author ?? "Unknown"
                  )}
                  {m.created ? ` · ${new Date(m.created).toLocaleString()}` : ""}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      {!outOfScope &&
        (readOnly ? (
          <p
            className="rounded-xl border border-dashed border-border bg-muted/40 p-3 text-sm text-muted-foreground"
            role="note"
          >
            This is a read-only external chat. You can read its messages here, but messages can only
            be sent from the app that created it.
          </p>
        ) : (
          <form onSubmit={onSend} className="flex items-center gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Write a message…"
              aria-label="Message"
              disabled={sending}
            />
            <Button type="submit" disabled={sending || !draft.trim()}>
              {sending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
              Send
            </Button>
          </form>
        ))}
    </div>
  );
}

function StartChat() {
  const { webId, activeStorage } = useSession();
  const router = useRouter();
  const [name, setName] = useState("");
  const [contacts, setContacts] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  async function onStart(e: React.FormEvent) {
    e.preventDefault();
    if (!activeStorage || !webId) {
      toast.error("Sign in to start a chat.");
      return;
    }
    if (!name.trim()) {
      toast.error("Give the chat a name.");
      return;
    }
    setCreating(true);
    const container = chatContainerUrl(activeStorage, name);
    // Best-effort: notify each picked contact (strict-validated target). A failed
    // notification does not block opening the chat.
    await Promise.allSettled(
      contacts.map((recipient) =>
        sendNotification({
          recipientWebId: recipient,
          actorWebId: webId,
          type: "Invite",
          summary: `${name.trim()} — chat invite`,
          object: container,
        }),
      ),
    );
    setCreating(false);
    router.push(`/chat?url=${encodeURIComponent(container)}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start gap-4">
        <span
          aria-hidden="true"
          className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"
        >
          <MessagesSquare className="size-6" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Start a chat</h1>
          <p className="measure mt-1 text-sm text-muted-foreground text-pretty">
            Chats are stored privately in your pod. Optionally invite a contact.
          </p>
        </div>
      </header>

      <form onSubmit={onStart} className="flex max-w-xl flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="chat-name">Chat name</Label>
          <Input
            id="chat-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Project team"
            autoFocus
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Invite contacts (optional)</Label>
          <PeoplePicker value={contacts} onChange={setContacts} label="Find contacts to invite" />
        </div>
        <div>
          <Button type="submit" disabled={creating || !name.trim()}>
            {creating ? <Loader2 className="animate-spin" aria-hidden="true" /> : <MessagesSquare aria-hidden="true" />}
            Start chat
          </Button>
        </div>
      </form>
    </div>
  );
}
