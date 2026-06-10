"use client";

/**
 * Live-update hook — subscribes to Solid notifications for a topic resource and
 * calls `onChange` when the pod data changes, so a view can re-`reload()` itself
 * without polling (PM finding #3).
 *
 * **Progressive enhancement, never a dependency** (AGENTS.md / solid-notifications
 * skill): if the server doesn't support notifications, or discovery / subscription
 * / the socket fails, this hook quietly does nothing — the view keeps its existing
 * fetch-on-mount + manual-reload behaviour. {@link subscribeToResource} already
 * swallows every error and returns a no-op unsubscribe, so this hook never throws.
 *
 * Lifecycle: subscribes only while `status === "logged-in"` and `topicUrl` is set;
 * re-subscribes when the topic or session changes; unsubscribes on unmount. Change
 * bursts are debounced (default 500ms) so a flurry of writes triggers one reload.
 */
import { useEffect, useRef } from "react";
import { useSession } from "@/components/session-provider";
import { subscribeToResource } from "@/lib/notifications";

/**
 * Subscribe to change notifications for `topicUrl` and invoke `onChange`
 * (debounced) when it changes.
 *
 * @param topicUrl - the resource/container to watch, or `undefined` to subscribe
 *   to nothing (e.g. before the URL is known). A change to this value re-subscribes.
 * @param onChange - called after a debounced burst of notifications. Typically a
 *   view's `reload()`. The latest reference is always used (no stale closure).
 * @param debounceMs - coalesce window for bursts. Defaults to 500ms.
 */
export function useResourceNotifications(
  topicUrl: string | undefined,
  onChange: () => void,
  debounceMs = 500,
): void {
  const { status } = useSession();
  // Keep the latest onChange without making it a subscription dependency — a new
  // callback identity each render must not tear down and re-open the socket.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (status !== "logged-in" || !topicUrl) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;

    const fire = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (!cancelled) onChangeRef.current();
      }, debounceMs);
    };

    // subscribeToResource never rejects (it degrades to a no-op unsubscribe), but
    // guard with .catch anyway so a future change can't break the view.
    subscribeToResource(topicUrl, fire)
      .then((unsub) => {
        if (cancelled) {
          unsub(); // unmounted before the subscription settled — tear it down now
        } else {
          unsubscribe = unsub;
        }
      })
      .catch(() => {
        // Unreachable today; defensive — notifications are best-effort.
      });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
    };
  }, [topicUrl, status, debounceMs]);
}
