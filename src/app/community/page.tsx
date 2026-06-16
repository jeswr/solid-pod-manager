// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Solid Community — the user's view of the Solid community's conversations,
 * unified across the Solid **forum** (forum.solidproject.org) and the Solid
 * **chat** rooms (matrix.org), via `@jeswr/solid-community-feeds`.
 *
 *   - The FORUM works out of the box (public read, no credentials) — a
 *     brand-new user immediately sees the forum's latest threads, newest-first.
 *   - The Matrix rooms appear once the user connects a Matrix access token
 *     ("Connect Matrix"); until then the Matrix source is omitted and the forum
 *     still renders. Credentials are in-memory only (`community-credentials.ts`).
 *
 * Threads are listed newest-first with an unread badge (computed against a
 * per-thread read marker the user persists), a short preview, and a
 * click-through to the canonical web source (the forum topic / matrix.to).
 * Instant-nav SWR: returning to this page paints the last feed immediately and
 * revalidates in the background. All links render through `safeLinkHref`.
 */
import { useMemo, useState } from "react";
import { ExternalLink, MessagesSquare, Plug, RefreshCw, Unplug } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/components/session-provider";
import {
  clearCommunityFeedCache,
  useCommunityFeed,
  useCommunityPrefs,
} from "@/components/use-community";
import { EmptyState, ErrorState } from "@/components/states";
import { ItemRowSkeleton } from "@/components/item-row";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { safeLinkHref } from "@/lib/pod-scope";
import { formatModified } from "@/lib/format";
import { threadReadPosition, type CommunityThread } from "@/lib/community-feeds";
import {
  clearCommunityCredentials,
  hasMatrixCredential,
  setCommunityCredentials,
} from "@/lib/community-credentials";

/** A human label for a thread's backend. */
function sourceLabel(source: CommunityThread["source"]): string {
  return source === "matrix" ? "Chat" : "Forum";
}

/** A short, single-line preview of a thread's newest message (plain text). */
function threadPreview(thread: CommunityThread): string | undefined {
  const newest = thread.messages?.[0];
  if (!newest?.body) return undefined;
  const text = newest.body.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

export default function CommunityPage() {
  const { webId } = useSession();
  const { prefs, loaded, markRead } = useCommunityPrefs();
  const { data, loading, error, revalidating, reload } = useCommunityFeed(prefs, loaded);

  // Matrix-connect dialog state (in-memory token; never persisted).
  const [connecting, setConnecting] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const connected = hasMatrixCredential();

  const threads = useMemo(() => data?.threads ?? [], [data]);
  // Surface EVERY per-source failure, not just Matrix: if the forum source fails
  // while Matrix returns data, the user must still be told the forum is missing
  // (one source failing never blanks the other — but it must never fail
  // silently either).
  const sourceErrors = useMemo(() => {
    const errs = data?.errors ?? [];
    return {
      matrix: errs.some((e) => e.source === "matrix"),
      discourse: errs.some((e) => e.source === "discourse"),
    };
  }, [data]);

  function connectMatrix() {
    const token = tokenInput.trim();
    if (!token) return;
    // Record the owning WebID so the token is dropped on an account switch.
    setCommunityCredentials({ matrixAccessToken: token }, webId);
    // Drop any cached pre-connect feed slots so the connected feed is fetched
    // fresh (and a previously-cached disconnected slot can't linger). The cache
    // is memory-only, so private content never touched disk — this is the
    // in-memory hygiene companion to the disconnect clear below.
    clearCommunityFeedCache(webId);
    setTokenInput("");
    setConnecting(false);
    toast.success("Matrix connected — loading your rooms…");
    reload();
  }

  function disconnectMatrix() {
    clearCommunityCredentials();
    // Evict the memory-cached feed for this WebID: it holds the (now
    // disconnected) account's PRIVATE Matrix room content, which must not linger
    // in memory after an explicit disconnect or be reused on a later reconnect
    // (roborev finding, Medium). The feed key flips m→_, so the connected slot
    // would otherwise sit in memory until logout.
    clearCommunityFeedCache(webId);
    toast.message("Matrix disconnected.");
    reload();
  }

  function onOpenThread(thread: CommunityThread) {
    // Mark read at the thread's newest position when the user clicks through.
    const pos = threadReadPosition(thread);
    if (pos !== undefined) markRead(thread.id, pos);
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
            <h1 className="text-2xl font-semibold tracking-tight">Solid Community</h1>
            <p className="measure mt-1 text-sm text-muted-foreground text-pretty">
              The Solid forum and chat rooms, in one place. The forum works without signing in;
              connect Matrix to see your chat rooms too.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {connected ? (
            <Button variant="outline" size="sm" onClick={disconnectMatrix}>
              <Unplug aria-hidden="true" />
              Disconnect Matrix
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setConnecting((v) => !v)}>
              <Plug aria-hidden="true" />
              Connect Matrix
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={reload}
            disabled={loading}
            aria-label="Refresh the community feed"
          >
            <RefreshCw aria-hidden="true" className={revalidating ? "animate-spin" : undefined} />
          </Button>
        </div>
      </header>

      {connecting && !connected ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connect your Matrix account</CardTitle>
            <CardDescription>
              Paste a Matrix user access token (from your Matrix client&rsquo;s account / device
              settings). It is kept only in this browser tab&rsquo;s memory — never written to disk
              or your pod — and is sent only to matrix.org to read your rooms.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="matrix-token">Matrix access token</Label>
              <Input
                id="matrix-token"
                type="password"
                autoComplete="off"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="syt_…"
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={connectMatrix} disabled={!tokenInput.trim()}>
                Connect
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConnecting(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {sourceErrors.matrix ? (
        <Alert>
          <Unplug className="size-4" aria-hidden="true" />
          <AlertTitle>Matrix rooms unavailable</AlertTitle>
          <AlertDescription>
            We couldn&rsquo;t load your Matrix rooms right now, so they&rsquo;re not shown below.
            Your access token may have expired — reconnect to try again.
          </AlertDescription>
        </Alert>
      ) : null}

      {sourceErrors.discourse ? (
        <Alert>
          <Unplug className="size-4" aria-hidden="true" />
          <AlertTitle>Forum unavailable</AlertTitle>
          <AlertDescription>
            We couldn&rsquo;t load the Solid forum right now, so its threads aren&rsquo;t shown
            below. Check your connection and try refreshing.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Cold load with nothing cached → skeleton. */}
      {loading ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <ItemRowSkeleton />
          <ItemRowSkeleton />
          <ItemRowSkeleton />
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : threads.length === 0 ? (
        <EmptyState
          icon={MessagesSquare}
          title="No community threads yet"
          description="When the Solid forum or your connected chat rooms have activity, it will show up here, newest first."
          action={
            !connected ? (
              <Button variant="outline" size="sm" onClick={() => setConnecting(true)}>
                <Plug aria-hidden="true" />
                Connect Matrix
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {threads.map((thread) => (
            <ThreadRow key={thread.id} thread={thread} onOpen={() => onOpenThread(thread)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ThreadRow({ thread, onOpen }: { thread: CommunityThread; onOpen: () => void }) {
  const href = safeLinkHref(thread.permalink);
  const when = formatModified(thread.lastActivityAt);
  const preview = threadPreview(thread);
  const unread = thread.unreadCount && thread.unreadCount > 0 ? thread.unreadCount : 0;

  const inner = (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="shrink-0">
            {sourceLabel(thread.source)}
          </Badge>
          <span className="truncate font-medium">{thread.title || "Untitled thread"}</span>
          {unread > 0 ? (
            <Badge className="shrink-0" aria-label={`${unread} unread`}>
              {unread}
            </Badge>
          ) : null}
        </div>
        {preview ? (
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground text-pretty">{preview}</p>
        ) : null}
        <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
          {when ? <span>{when}</span> : null}
          {typeof thread.messageCount === "number" ? (
            <span>
              {thread.messageCount} {thread.messageCount === 1 ? "message" : "messages"}
            </span>
          ) : null}
        </div>
      </div>
      {href ? <ExternalLink className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
    </div>
  );

  return (
    <li className="rounded-2xl border border-border bg-card transition-colors hover:bg-accent/40">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onOpen}
          className="block rounded-2xl px-4 py-3 focus-visible:outline-2 focus-visible:outline-ring"
        >
          {inner}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <div className="px-4 py-3">{inner}</div>
      )}
    </li>
  );
}
