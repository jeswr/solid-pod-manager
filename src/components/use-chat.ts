// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Chat hook — opens a chat at a container URL (scope-guarded to the user's own
 * pods via `openChat`/`ChatScopeError`), lists messages, and sends. Production
 * paths pass NO `fetch`.
 *
 * Stale-while-revalidate: the message LISTING goes through the shared
 * {@link useSwrRead} cache, keyed PER CHAT container (`chat:<containerUrl>`), so
 * re-opening a chat you have already viewed paints the last-seen messages
 * INSTANTLY and revalidates in the background; the container is watched so a new
 * message invalidates + refreshes it. An out-of-scope or not-yet-opened chat
 * uses an empty key (no fetch, no cache entry). SECURITY: the cache is
 * render-only; `send` writes a fresh message via the live `chat` handle and
 * `reload()`s — it never mutates the cached snapshot.
 */
import { useCallback, useMemo } from "react";
import { useSession } from "@/components/session-provider";
import { useSwrRead } from "@/components/use-swr-read";
import { openChat, type Chat, type ChatMessage } from "@/lib/chat";
import { ChatScopeError } from "@/lib/errors";
import type { RevalidatableState } from "@/components/use-pod-data";

export interface UseChat extends RevalidatableState<ChatMessage[]> {
  reload: () => void;
  send: (content: string) => Promise<void>;
  /** True when the container URL is out of the user's own pods (blocked). */
  outOfScope: boolean;
}

export function useChat(containerUrl: string | undefined): UseChat {
  const { webId, activeStorage, profile, status } = useSession();

  // Scope against ALL of the user's own pods (not just the active one), so a chat
  // saved/invited in another of the user's storages is still in scope. Memoise on
  // a STABLE string key (not the array reference) so a freshly-built
  // profile.storages each render doesn't re-create the chat / re-trigger loads.
  const storageKey = (profile?.storages ?? []).join("|") || (activeStorage ?? "");
  const storages = useMemo(() => {
    const all = profile?.storages ?? [];
    return all.length > 0 ? all : activeStorage ? [activeStorage] : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const { chat, outOfScope } = useMemo(() => {
    if (status !== "logged-in" || !webId || storages.length === 0 || !containerUrl) {
      return { chat: undefined as Chat | undefined, outOfScope: false };
    }
    try {
      return {
        chat: openChat({ containerUrl, storages, webId }),
        outOfScope: false,
      };
    } catch (e) {
      if (e instanceof ChatScopeError) return { chat: undefined, outOfScope: true };
      throw e;
    }
  }, [status, webId, storages, containerUrl]);

  // Per-chat cache key; an out-of-scope / not-yet-opened chat uses an empty key
  // (no fetch, no cache entry), matching the previous loading/blocked behaviour.
  const key = chat && containerUrl ? `chat:${containerUrl}` : "";
  const fetcher = useCallback(
    () => (chat ? chat.messages() : Promise.resolve<ChatMessage[]>([])),
    [chat],
  );
  const { data, error, loading, revalidating, reload } = useSwrRead<ChatMessage[]>(
    key,
    fetcher,
    // Only watch the container when the chat is in scope and opened. An
    // out-of-scope / not-yet-opened chat uses an empty read key, so subscribing
    // its `containerUrl` would point the notification hook at a container that
    // may be blocked (out of the user's own pods) for no benefit (roborev
    // finding). Gate the topic on `chat` so it matches the read key's gate.
    { topicUrl: chat ? containerUrl : undefined },
  );

  const send = useCallback(
    async (content: string) => {
      if (chat) {
        await chat.send(content);
        reload();
      }
    },
    [chat, reload],
  );

  // An out-of-scope container is a hard error, not a load — surface it directly
  // (no fetch happens for it, the key is empty).
  if (outOfScope && containerUrl) {
    return {
      data: undefined,
      error: new ChatScopeError(containerUrl, "your pods"),
      loading: false,
      revalidating: false,
      reload,
      send,
      outOfScope: true,
    };
  }

  return { data, error, loading, revalidating, reload, send, outOfScope };
}
