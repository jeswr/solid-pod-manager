// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * Chat hook — opens a chat at a container URL (scope-guarded to the user's own
 * pods via `openChat`/`ChatScopeError`), lists messages, and sends. Production
 * paths pass NO `fetch`. Re-lists on reload (wired to live notifications by the
 * page).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "@/components/session-provider";
import { openChat, type Chat, type ChatMessage } from "@/lib/chat";
import { ChatScopeError } from "@/lib/errors";
import type { AsyncState } from "@/components/use-pod-data";

export interface UseChat extends AsyncState<ChatMessage[]> {
  reload: () => void;
  send: (content: string) => Promise<void>;
  /** True when the container URL is out of the user's own pods (blocked). */
  outOfScope: boolean;
}

export function useChat(containerUrl: string | undefined): UseChat {
  const { webId, activeStorage, profile, status } = useSession();
  const [state, setState] = useState<AsyncState<ChatMessage[]>>({ loading: true });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // Scope against ALL of the user's own pods (not just the active one), so a chat
  // saved/invited in another of the user's storages is still in scope.
  const storages = useMemo(() => {
    const all = profile?.storages ?? [];
    return all.length > 0 ? all : activeStorage ? [activeStorage] : [];
  }, [profile?.storages, activeStorage]);

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

  useEffect(() => {
    if (!containerUrl) {
      setState({ loading: true });
      return;
    }
    if (outOfScope) {
      setState({ loading: false, error: new ChatScopeError(containerUrl, "your pods") });
      return;
    }
    if (!chat) {
      setState({ loading: true });
      return;
    }
    let cancelled = false;
    setState({ loading: true });
    chat
      .messages()
      .then((m) => {
        if (!cancelled) setState({ loading: false, data: m });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState({ loading: false, error: e instanceof Error ? e : new Error(String(e)) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chat, outOfScope, containerUrl, nonce]);

  const send = useCallback(
    async (content: string) => {
      if (chat) {
        await chat.send(content);
        reload();
      }
    },
    [chat, reload],
  );

  return { ...state, reload, send, outOfScope };
}
