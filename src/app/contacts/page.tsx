"use client";

/**
 * Contacts — a first-party address book. Lists the user's contacts
 * (`vcard:Individual` under `contacts/`) alphabetically, with create / open /
 * edit / delete via `/contacts/[id]`.
 */
import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Download, Mail, Phone, Plus, Upload, Users } from "lucide-react";
import { toast } from "sonner";
import { contactsStore, type Contact } from "@/lib/contacts";
import { useStore, useItems } from "@/components/use-productivity";
import { EmptyState, ErrorState } from "@/components/states";
import { ItemRowSkeleton } from "@/components/item-row";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { WebIdIndexSearch } from "@/components/webid-index-search";
import { isWebIdIndexEnabled } from "@/lib/webid-index";
import { exportVCard, importVCard } from "@/lib/vcard-io";
import { downloadText, readFileText } from "@/lib/download";
import type { StoredItem } from "@/lib/productivity-store";

export default function ContactsPage() {
  const store = useStore<Contact>(contactsStore);
  const { data, loading, error, reload } = useItems(store);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const contacts = useMemo(
    () =>
      [...(data ?? [])].sort((a, b) =>
        (a.data.fn || "").localeCompare(b.data.fn || "", undefined, { sensitivity: "base" }),
      ),
    [data],
  );

  function onExport() {
    if (!data || data.length === 0) {
      toast.error("There are no contacts to export.");
      return;
    }
    downloadText("contacts.vcf", exportVCard(data.map((i) => i.data)), "text/vcard");
  }

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !store) return;
    setBusy(true);
    try {
      const parsed = importVCard(await readFileText(file));
      if (parsed.length === 0) {
        toast.error("No contacts (VCARD) found in that file.");
        return;
      }
      let added = 0;
      let failed = false;
      for (const c of parsed) {
        try {
          await store.create(c, c.fn);
          added += 1;
        } catch {
          failed = true;
          break;
        }
      }
      if (added > 0) reload();
      if (failed) {
        toast.error(
          added > 0
            ? `Imported ${added} of ${parsed.length} contacts before an error. The rest were not imported.`
            : "Could not import the contacts. Please try again.",
        );
      } else {
        toast.success(`Imported ${added} ${added === 1 ? "contact" : "contacts"}`);
      }
    } catch {
      toast.error("Could not import that file. Please check it is a valid .vcf vCard.");
    } finally {
      setBusy(false);
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
            <Users className="size-6" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
            <p className="measure mt-1 text-sm text-muted-foreground text-pretty">
              Your address book, stored privately in your pod.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept=".vcf,text/vcard"
            className="sr-only"
            onChange={onImportFile}
            aria-hidden="true"
            tabIndex={-1}
          />
          <Button variant="outline" onClick={() => fileInput.current?.click()} disabled={busy || !store}>
            <Upload aria-hidden="true" />
            Import
          </Button>
          <Button variant="outline" onClick={onExport} disabled={!data || data.length === 0}>
            <Download aria-hidden="true" />
            Export
          </Button>
          <Button asChild>
            <Link href="/contacts/edit">
              <Plus aria-hidden="true" />
              New contact
            </Link>
          </Button>
        </div>
      </header>

      {isWebIdIndexEnabled ? (
        <>
          <WebIdIndexSearch onAdded={reload} />
          <Separator />
          <h2 className="text-lg font-semibold tracking-tight">Your contacts</h2>
        </>
      ) : null}

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
              <Link href="/contacts/edit">
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
  const href = `/contacts/edit?id=${encodeURIComponent(contact.url)}`;
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
