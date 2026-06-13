// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * PeoplePicker — a reusable agent selector: search the user's contacts +
 * `foaf:knows` friends by name/email/WebID, or paste a raw WebID to add anyone.
 * Selected agents render as removable chips.
 *
 * Designed as a SHARED component: Wave 3 Sharing (add a person to an ACL),
 * group membership here, and Wave 6 chat invites all reuse it. It owns no pod
 * I/O of its own — it composes the `usePeople` hook + the pure
 * `people-search` matchers, and reports selections via `onChange` so the
 * consuming feature decides what a selection means.
 */
import { useId, useMemo, useState } from "react";
import { Loader2, Search, UserPlus, X } from "lucide-react";
import { usePeople } from "@/components/use-people";
import {
  filterPeople,
  looksLikeWebId,
  resolveWebIdOption,
  type PersonOption,
} from "@/lib/people-search";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function initials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || /^https?:/i.test(label)) return "@";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

const SOURCE_LABEL: Record<PersonOption["source"], string> = {
  contact: "Contact",
  friend: "Friend",
  webid: "WebID",
};

export interface PeoplePickerProps {
  /** Currently selected WebIDs. */
  value: string[];
  /** Called with the next selection whenever it changes. */
  onChange: (next: string[]) => void;
  /** Single selection (default false → multi-select with chips). */
  single?: boolean;
  /** Accessible label for the search box. */
  label?: string;
  /** Placeholder for the search box. */
  placeholder?: string;
}

export function PeoplePicker({
  value,
  onChange,
  single = false,
  label = "Find people",
  placeholder = "Search contacts, or paste a WebID…",
}: PeoplePickerProps) {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [resolving, setResolving] = useState(false);
  const { data: people, loading } = usePeople();

  const selected = useMemo(() => new Set(value), [value]);

  const matches = useMemo(() => {
    const all = people ?? [];
    return filterPeople(all, query).filter((o) => !selected.has(o.webId));
  }, [people, query, selected]);

  // Labels for the selected chips: prefer the known option's label.
  const labelFor = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of people ?? []) map.set(o.webId, o.label);
    return (webId: string) => map.get(webId) ?? webId;
  }, [people]);

  const queryIsNewWebId =
    looksLikeWebId(query) &&
    !selected.has(query.trim()) &&
    !matches.some((m) => m.webId === query.trim());

  function pick(webId: string) {
    const next = single ? [webId] : [...value, webId];
    onChange(next);
    setQuery("");
  }

  function unpick(webId: string) {
    onChange(value.filter((w) => w !== webId));
  }

  async function addTypedWebId() {
    const webId = query.trim();
    if (!looksLikeWebId(webId)) return;
    setResolving(true);
    try {
      // Resolve for a friendly label (best-effort); the WebID is what we add.
      await resolveWebIdOption(webId);
    } finally {
      setResolving(false);
    }
    pick(webId);
  }

  return (
    <div className="flex flex-col gap-3">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Selected people">
          {value.map((webId) => (
            <li key={webId}>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-accent py-1 pr-1 pl-2 text-sm text-accent-foreground">
                <Avatar size="sm">
                  <AvatarFallback>{initials(labelFor(webId))}</AvatarFallback>
                </Avatar>
                <span className="max-w-48 truncate">{labelFor(webId)}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-5 rounded-full"
                  onClick={() => unpick(webId)}
                  aria-label={`Remove ${labelFor(webId)}`}
                >
                  <X className="size-3" aria-hidden="true" />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id={inputId}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && queryIsNewWebId) {
              e.preventDefault();
              void addTypedWebId();
            }
          }}
          className="pl-9"
          placeholder={placeholder}
          aria-label={label}
          autoComplete="off"
          role="combobox"
          aria-expanded={query.length > 0}
          aria-controls={`${inputId}-list`}
        />
      </div>

      {query.length > 0 && (
        <ul
          id={`${inputId}-list`}
          className="flex flex-col gap-1 rounded-xl border border-border bg-card p-1"
          aria-label="Search results"
        >
          {loading ? (
            <li className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Loading your people…
            </li>
          ) : (
            <>
              {matches.slice(0, 8).map((o) => (
                <li key={o.webId}>
                  <button
                    type="button"
                    onClick={() => pick(o.webId)}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <Avatar size="sm">
                      <AvatarFallback>{initials(o.label)}</AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{o.label}</span>
                      {o.detail && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {o.detail}
                        </span>
                      )}
                    </span>
                    <Badge variant="secondary">{SOURCE_LABEL[o.source]}</Badge>
                  </button>
                </li>
              ))}

              {queryIsNewWebId && (
                <li>
                  <button
                    type="button"
                    onClick={() => void addTypedWebId()}
                    disabled={resolving}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                      {resolving ? (
                        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                      ) : (
                        <UserPlus className="size-3" aria-hidden="true" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">Add this WebID</span>
                      <span className="block truncate font-mono text-xs text-muted-foreground">
                        {query.trim()}
                      </span>
                    </span>
                  </button>
                </li>
              )}

              {matches.length === 0 && !queryIsNewWebId && (
                <li className="px-3 py-2 text-sm text-muted-foreground">
                  No matches. Paste a full WebID (https://…) to add someone new.
                </li>
              )}
            </>
          )}
        </ul>
      )}
    </div>
  );
}
