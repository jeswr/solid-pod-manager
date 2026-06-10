"use client";

/**
 * Contacts — a first-party address book. Lists the user's contacts
 * (`vcard:Individual` under `contacts/`) alphabetically, with create / open /
 * edit / delete via `/contacts/[id]`.
 */
import { useMemo } from "react";
import Link from "next/link";
import { Mail, Phone, Plus, Users } from "lucide-react";
import { contactsStore, type Contact } from "@/lib/contacts";
import { useStore, useItems } from "@/components/use-productivity";
import { EmptyState, ErrorState } from "@/components/states";
import { ItemRowSkeleton } from "@/components/item-row";
import { Button } from "@/components/ui/button";
import type { StoredItem } from "@/lib/productivity-store";

export default function ContactsPage() {
  const store = useStore<Contact>(contactsStore);
  const { data, loading, error, reload } = useItems(store);

  const contacts = useMemo(
    () =>
      [...(data ?? [])].sort((a, b) =>
        (a.data.fn || "").localeCompare(b.data.fn || "", undefined, { sensitivity: "base" }),
      ),
    [data],
  );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"
          >
            <Users className="size-6" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
            <p className="measure mt-1 text-sm text-muted-foreground text-pretty">
              Your address book, stored privately in your pod.
            </p>
          </div>
        </div>
        <Button asChild>
          <Link href="/contacts/new">
            <Plus aria-hidden="true" />
            New contact
          </Link>
        </Button>
      </header>

      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading ? (
        <ul className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <ItemRowSkeleton key={i} />
          ))}
        </ul>
      ) : contacts.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No contacts yet"
          description="Add the people you keep in touch with. Their details stay in your pod."
          action={
            <Button asChild>
              <Link href="/contacts/new">
                <Plus aria-hidden="true" />
                New contact
              </Link>
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2" aria-label="Your contacts">
          {contacts.map((contact) => (
            <li key={contact.url}>
              <ContactRow contact={contact} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function ContactRow({ contact }: { contact: StoredItem<Contact> }) {
  const c = contact.data;
  const href = `/contacts/${encodeURIComponent(contact.url)}`;
  const name = c.fn.trim() || "Unnamed contact";
  const detail = c.email || c.phone;

  return (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
      >
        {initials(c.fn)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{name}</span>
        <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
          {c.email ? (
            <Mail className="size-3 shrink-0" aria-hidden="true" />
          ) : c.phone ? (
            <Phone className="size-3 shrink-0" aria-hidden="true" />
          ) : null}
          {detail ?? "No contact details"}
        </span>
      </span>
    </Link>
  );
}
