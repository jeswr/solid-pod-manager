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
import { useCallback, useMemo, useRef, useState } from "react";
import { useSession } from "@/components/session-provider";
import { useSwrRead } from "@/components/use-swr-read";
import { openChat, FOREIGN_CHAT_READ_ENABLED, type Chat, type ChatMessage } from "@/lib/chat";
import { ChatScopeError } from "@/lib/errors";
import type { RevalidatableState } from "@/components/use-pod-data";

export interface UseChat extends RevalidatableState<ChatMessage[]> {
  reload: () => void;
  send: (content: string) => Promise<void>;
  /** True when the container URL is out of the user's own pods (blocked). */
  outOfScope: boolean;
  /**
   * True when this chat is READ-ONLY interop — a foreign-origin channel, or an
   * on-pod channel detected as a SolidOS `meeting:LongChat` (which PM reads but
   * never writes). The compose box is hidden when set. A foreign chat is
   * read-only from construction; an on-pod long-chat becomes read-only once the
   * first read detects the shape (so this can flip true after the load lands).
   */
  readOnly: boolean;
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
        // Foreign-origin READ-ONLY interop is feature-gated (ships dark unless
        // NEXT_PUBLIC_FOREIGN_CHAT_READ is set). When off, a non-own-pod URL is
        // blocked exactly as before (outOfScope). openChat still SSRF-validates
        // any foreign URL and reads it with the pristine native fetch.
        chat: openChat({ containerUrl, storages, webId, allowForeign: FOREIGN_CHAT_READ_ENABLED }),
        outOfScope: false,
      };
    } catch (e) {
      if (e instanceof ChatScopeError) return { chat: undefined, outOfScope: true };
      throw e;
    }
  }, [status, webId, storages, containerUrl]);

  // A foreign chat is read-only from construction; an on-pod chat only becomes
  // read-only once its first read DETECTS a `meeting:LongChat` shape, so we track
  // the detected read-only flag in state and update it after each fetch settles.
  const [detectedReadOnly, setDetectedReadOnly] = useState(false);

  // Per-chat cache key; an out-of-scope / not-yet-opened chat uses an empty key
  // (no fetch, no cache entry), matching the previous loading/blocked behaviour.
  const key = chat && containerUrl ? `chat:${containerUrl}` : "";

  // The read key the detected-read-only flag belongs to. Used to (a) RESET the
  // flag when the chat KEY changes, and (b) DISCARD a late-resolving fetch's flag
  // update if the user has since navigated to a different chat (roborev findings,
  // Low + Medium). The ref mirrors the current key so the async fetcher can check
  // "am I still the active chat?" at resolve time without being a stale closure.
  const keyRef = useRef(key);
  keyRef.current = key;

  // RESET the detected read-only flag when the chat KEY changes: without this,
  // navigating from a long-chat channel to a native one (or to a channel whose
  // load then fails) would inherit the previous channel's stale read-only UI and
  // wrongly hide the compose box. Derive-state-during-render (React's documented
  // "adjust state when a prop changes" pattern, same as use-swr-read) so the new
  // key never paints the old key's flag even once.
  const [activeKey, setActiveKey] = useState(key);
  if (activeKey !== key) {
    setActiveKey(key);
    setDetectedReadOnly(false);
  }

  const fetcher = useCallback(
    async () => {
      if (!chat) return [] as ChatMessage[];
      const fetchKey = key;
      const msgs = await chat.messages();
      // chat.readOnly is now authoritative (detectedKind set by messages()). Only
      // apply it if THIS chat is still the active one — a late promise from a
      // since-abandoned chat must NOT set the flag for the current chat.
      if (keyRef.current === fetchKey) setDetectedReadOnly(chat.readOnly);
      return msgs;
    },
    [chat, key],
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

  // A foreign chat is read-only immediately; an on-pod long-chat once detected.
  const readOnly = (chat?.readOnly ?? false) || detectedReadOnly;

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
      readOnly: false,
    };
  }

  return { data, error, loading, revalidating, reload, send, outOfScope, readOnly };
}
