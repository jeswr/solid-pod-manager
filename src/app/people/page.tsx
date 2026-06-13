// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
"use client";

/**
 * People — social depth over the address book: your `foaf:knows` friends and
 * your `vcard:Group` address-book groups. Both reuse the shared PeoplePicker.
 */
import { useMemo, useState } from "react";
import { Loader2, Trash2, Users, UsersRound } from "lucide-react";
import { toast } from "sonner";
import { PeoplePicker } from "@/components/people-picker";
import { useFriends } from "@/components/use-friends";
import { useStore, useItems } from "@/components/use-productivity";
import { groupsStore, type Group } from "@/lib/social";
import { usePeople } from "@/components/use-people";
import { EmptyState, ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import type { StoredItem } from "@/lib/productivity-store";

export default function PeoplePage() {
  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-start gap-4">
        <span
          aria-hidden="true"
          className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"
        >
          <UsersRound className="size-6" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">People</h1>
          <p className="measure mt-1 text-sm text-muted-foreground text-pretty">
            The people you know and the groups you keep them in — all in your pod.
          </p>
        </div>
      </header>

      <FriendsSection />
      <GroupsSection />
    </div>
  );
}

/** Friendly label for a WebID, drawn from the user's known people. */
function useLabeller(): (webId: string) => string {
  const { data: people } = usePeople();
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const p of people ?? []) map.set(p.webId, p.label);
    return (webId: string) => map.get(webId) ?? webId;
  }, [people]);
}

function FriendsSection() {
  const { data: friends, loading, error, reload, add, remove } = useFriends();
  const [busy, setBusy] = useState<string | null>(null);
  const label = useLabeller();

  async function onAdd(next: string[]) {
    const webId = next[0];
    if (!webId) return;
    setBusy(webId);
    try {
      await add(webId);
      toast.success("Added to your friends");
    } catch {
      toast.error("Could not add this person. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function onRemove(webId: string) {
    setBusy(webId);
    try {
      await remove(webId);
      toast.success("Removed");
    } catch {
      toast.error("Could not remove this person. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="friends-h">
      <h2 id="friends-h" className="text-lg font-semibold">
        Friends
      </h2>
      <p className="text-sm text-muted-foreground">
        People you connect to publicly (<code className="text-xs">foaf:knows</code>).
        Pick from your contacts or paste a WebID.
      </p>

      {/* single-select: each pick adds one friend, then clears */}
      <PeoplePicker
        value={[]}
        onChange={onAdd}
        single
        label="Add a friend"
        placeholder="Add a friend by name or WebID…"
      />

      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading ? (
        <Skeleton className="h-16 w-full" />
      ) : (friends?.length ?? 0) === 0 ? (
        <p className="text-sm text-muted-foreground">No friends added yet.</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2" aria-label="Your friends">
          {friends!.map((webId) => (
            <li
              key={webId}
              className="flex items-center gap-3 rounded-xl border border-border bg-card p-3"
            >
              <Avatar size="sm">
                <AvatarFallback>{chip(label(webId))}</AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{label(webId)}</span>
                <span className="block truncate font-mono text-xs text-muted-foreground">
                  {webId}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => onRemove(webId)}
                disabled={busy === webId}
                aria-label={`Remove ${label(webId)}`}
              >
                {busy === webId ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <Trash2 aria-hidden="true" />
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function GroupsSection() {
  const store = useStore<Group>(groupsStore);
  const { data: groups, loading, error, reload } = useItems(store);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!store || !name.trim()) {
      toast.error("Please name the group.");
      return;
    }
    setSaving(true);
    try {
      await store.create({ name: name.trim(), members }, name);
      toast.success("Group created");
      setName("");
      setMembers([]);
      setCreating(false);
      reload();
    } catch {
      toast.error("Could not create the group. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="groups-h">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="groups-h" className="text-lg font-semibold">
          Groups
        </h2>
        {!creating && (
          <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
            New group
          </Button>
        )}
      </div>

      {creating && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New group</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={onCreate} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="group-name">Group name</Label>
                <Input
                  id="group-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Family, Team, Book club"
                  autoFocus
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Members</Label>
                <PeoplePicker value={members} onChange={setMembers} />
              </div>
              <div className="flex items-center gap-2">
                <Button type="submit" disabled={saving}>
                  {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                  Create group
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setCreating(false);
                    setName("");
                    setMembers([]);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading ? (
        <Skeleton className="h-24 w-full" />
      ) : (groups?.length ?? 0) === 0 && !creating ? (
        <EmptyState
          icon={Users}
          title="No groups yet"
          description="Organise contacts into groups — handy when you share with several people at once."
          action={
            <Button onClick={() => setCreating(true)}>New group</Button>
          }
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" aria-label="Your groups">
          {(groups ?? []).map((g) => (
            <GroupCard key={g.url} group={g} store={store} onChanged={reload} />
          ))}
        </ul>
      )}
    </section>
  );
}

function GroupCard({
  group,
  store,
  onChanged,
}: {
  group: StoredItem<Group>;
  store: ReturnType<typeof groupsStore> | undefined;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [members, setMembers] = useState<string[]>(group.data.members);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const label = useLabeller();

  async function onSave() {
    if (!store) return;
    setSaving(true);
    try {
      await store.update(group.url, { name: group.data.name, members }, group.etag);
      toast.success("Group updated");
      setEditing(false);
      onChanged();
    } catch {
      toast.error("Could not update the group. Reopen it and try again.");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!store) return;
    setDeleting(true);
    try {
      await store.remove(group.url);
      toast.success("Group deleted");
      onChanged();
    } catch {
      toast.error("Could not delete the group.");
      setDeleting(false);
    }
  }

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium">
          <Users className="size-4 text-muted-foreground" aria-hidden="true" />
          {group.data.name || "Unnamed group"}
          <Badge variant="secondary">{group.data.members.length}</Badge>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          disabled={deleting}
          aria-label={`Delete ${group.data.name || "group"}`}
        >
          {deleting ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <Trash2 aria-hidden="true" />
          )}
        </Button>
      </div>

      {editing ? (
        <div className="flex flex-col gap-3">
          <PeoplePicker value={members} onChange={setMembers} />
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={onSave} disabled={saving}>
              {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              Save members
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setMembers(group.data.members);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {group.data.members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No members yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {group.data.members.map((m) => (
                <li key={m} className="truncate text-sm text-muted-foreground">
                  {label(m)}
                </li>
              ))}
            </ul>
          )}
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            Edit members
          </Button>
        </div>
      )}
    </li>
  );
}

function chip(label: string): string {
  if (/^https?:/i.test(label)) return "@";
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
