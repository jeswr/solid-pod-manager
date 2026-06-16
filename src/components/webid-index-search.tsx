// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * WebID-index people search — a search box over the configured `solid-webid-index`
 * (`NEXT_PUBLIC_WEBID_INDEX`), surfacing matching people as name/avatar/WebID
 * cards. Each result offers:
 *   - "Add as contact" — writes a `vcard:Individual` (carrying the WebID) to the
 *     user's contacts via PM's existing {@link contactsStore}; and
 *   - "Suggest to index" — POSTs an AS2 Announce to the index's LDN inbox so a
 *     not-yet-known WebID gets crawled.
 *
 * The whole panel is GATED on `isWebIdIndexEnabled`: when no index is configured
 * the parent renders nothing (it never mounts this).
 *
 * SECURITY/PRIVACY: search/suggest go through `@/lib/webid-index`, which only
 * talks to the configured index origin with credentials omitted — the user's
 * DPoP auth is never attached to the index, and only the typed query / a chosen
 * WebID leaves the app. "Add as contact" writes to the user's OWN pod through the
 * authenticated store (PM's normal auth path), unchanged.
 */
import { useMemo, useState } from "react";
import { Check, Loader2, Search, Send, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/components/session-provider";
import { useStore } from "@/components/use-productivity";
import { useWebIdSearch } from "@/components/use-webid-search";
import { EmptyState, ErrorState } from "@/components/states";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ItemRowSkeleton } from "@/components/item-row";
import { contactsStore, type Contact } from "@/lib/contacts";
import { webIdIndexClient } from "@/lib/webid-index";
import type { IndexEntry } from "@/lib/webid-index-client";

/** Two-letter initials for the avatar fallback (mirrors the contacts list). */
export function indexInitials(entry: Pick<IndexEntry, "name" | "webid">): string {
  const source = (entry.name ?? entry.webid).trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/**
 * Map an index entry to the {@link Contact} shape PM's contacts store persists.
 * Pure + exported so the add-as-contact mapping is unit-testable without React.
 * The display name falls back to the WebID when the entry carries no label, and
 * the WebID is always preserved (it is the whole point of adding the contact).
 */
export function indexEntryToContact(entry: IndexEntry): Contact {
  return {
    fn: entry.name?.trim() || entry.webid,
    webId: entry.webid,
  };
}

/**
 * The search panel. Mount only when {@link isWebIdIndexEnabled} (the parent
 * gates on it). `onAdded` is called after a contact is successfully written so
 * the parent can refresh its list.
 */
export function WebIdIndexSearch({ onAdded }: { onAdded?: () => void }) {
  const { webId } = useSession();
  const store = useStore<Contact>(contactsStore);
  const [input, setInput] = useState("");
  const [submitted, setSubmitted] = useState("");
  // Per-WebID action progress, so each card's buttons reflect their own state.
  const [adding, setAdding] = useState<Record<string, boolean>>({});
  const [added, setAdded] = useState<Record<string, boolean>>({});
  const [suggesting, setSuggesting] = useState<Record<string, boolean>>({});

  const { data, error, loading, enabled, reload } = useWebIdSearch(submitted);
  const entries = data?.entries ?? [];

  // A submitted query that has finished loading with no results.
  const isEmpty = useMemo(
    () => Boolean(submitted) && !loading && !error && entries.length === 0,
    [submitted, loading, error, entries.length],
  );

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(input.trim());
  }

  async function onAddContact(entry: IndexEntry) {
    if (!store) {
      toast.error("Sign in and choose a storage to add contacts.");
      return;
    }
    setAdding((m) => ({ ...m, [entry.webid]: true }));
    try {
      const contact = indexEntryToContact(entry);
      await store.create(contact, contact.fn);
      setAdded((m) => ({ ...m, [entry.webid]: true }));
      toast.success(`Added ${contact.fn} to your contacts`);
      onAdded?.();
    } catch {
      toast.error("Could not add that contact. Please try again.");
    } finally {
      setAdding((m) => ({ ...m, [entry.webid]: false }));
    }
  }

  async function onSuggest(entry: IndexEntry) {
    if (!webIdIndexClient) return;
    setSuggesting((m) => ({ ...m, [entry.webid]: true }));
    try {
      // Record the signed-in user's WebID as the AS2 actor (provenance, optional).
      const outcome = await webIdIndexClient.suggestWebId(
        entry.webid,
        webId ? { actor: webId } : undefined,
      );
      switch (outcome) {
        case "submitted":
          toast.success("Suggested to the index — it will be crawled shortly.");
          break;
        case "already-indexed":
          toast.info("That WebID is already in the index.");
          break;
        case "rate-limited":
          toast.error("Too many suggestions right now. Please try again later.");
          break;
        case "invalid":
          toast.error("That WebID can't be suggested.");
          break;
        default:
          toast.error("Could not reach the index. Please try again.");
      }
    } finally {
      setSuggesting((m) => ({ ...m, [entry.webid]: false }));
    }
  }

  if (!enabled) return null;

  return (
    <section aria-labelledby="webid-search-heading" className="flex flex-col gap-4">
      <div>
        <h2 id="webid-search-heading" className="text-lg font-semibold tracking-tight">
          Find people in the WebID index
        </h2>
        <p className="measure mt-1 text-sm text-muted-foreground text-pretty">
          Search the public index for people by name or WebID, add them to your
          contacts, or suggest a WebID to be indexed.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex flex-wrap gap-2" role="search">
        <label htmlFor="webid-search-input" className="sr-only">
          Search the WebID index
        </label>
        <Input
          id="webid-search-input"
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search by name or WebID…"
          className="min-w-0 flex-1"
          autoComplete="off"
        />
        <Button type="submit" disabled={!input.trim()}>
          <Search aria-hidden="true" />
          Search
        </Button>
      </form>

      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading ? (
        <ul className="flex flex-col gap-2" aria-label="Searching the WebID index">
          {Array.from({ length: 3 }).map((_, i) => (
            <ItemRowSkeleton key={i} />
          ))}
        </ul>
      ) : isEmpty ? (
        <EmptyState
          icon={Search}
          title="No matching people"
          description="No one in the index matched that search. If you know their WebID, you can suggest it below or add it directly."
        />
      ) : entries.length > 0 ? (
        <ul className="grid gap-2 sm:grid-cols-2" aria-label="WebID index results">
          {entries.map((entry) => (
            <li key={entry.webid}>
              <ResultCard
                entry={entry}
                adding={Boolean(adding[entry.webid])}
                added={Boolean(added[entry.webid])}
                suggesting={Boolean(suggesting[entry.webid])}
                onAdd={() => onAddContact(entry)}
                onSuggest={() => onSuggest(entry)}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ResultCard({
  entry,
  adding,
  added,
  suggesting,
  onAdd,
  onSuggest,
}: {
  entry: IndexEntry;
  adding: boolean;
  added: boolean;
  suggesting: boolean;
  onAdd: () => void;
  onSuggest: () => void;
}) {
  const name = entry.name?.trim() || "Unnamed person";
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3">
      <div className="flex items-center gap-3">
        <Avatar className="size-10 shrink-0">
          {entry.photoUrl ? <AvatarImage src={entry.photoUrl} alt="" /> : null}
          <AvatarFallback>{indexInitials(entry)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{name}</p>
          <p className="truncate text-xs text-muted-foreground">{entry.webid}</p>
        </div>
        <Badge variant="outline" className="shrink-0">
          Indexed
        </Badge>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onAdd}
          disabled={adding || added}
          aria-label={`Add ${name} as a contact`}
        >
          {adding ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : added ? (
            <Check aria-hidden="true" />
          ) : (
            <UserPlus aria-hidden="true" />
          )}
          {added ? "Added" : "Add as contact"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onSuggest}
          disabled={suggesting}
          aria-label={`Suggest ${name} to the index`}
        >
          {suggesting ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <Send aria-hidden="true" />
          )}
          Suggest to index
        </Button>
      </div>
    </div>
  );
}
