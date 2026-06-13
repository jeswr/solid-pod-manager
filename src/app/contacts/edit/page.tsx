"use client";

/**
 * Contact editor — create (no `?id=`) or edit/delete an existing contact
 * (`?id=` = the contact's resource URL). A query parameter rather than a path
 * segment so the page prerenders under `output: "export"`. A name is required;
 * email / phone / note are optional. Conditional writes use the read ETag
 * (412 → reopen).
 */
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, Loader2, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { contactsStore, type Contact } from "@/lib/contacts";
import { useStore, useItem } from "@/components/use-productivity";
import { ErrorState } from "@/components/states";
import { ResourceWriteError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";

export default function ContactEditorPage() {
  // useSearchParams requires a Suspense boundary in a prerendered page.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <ContactEditor />
    </Suspense>
  );
}

function ContactEditor() {
  // `?id=` is the contact's resource URL (URLSearchParams decodes it); absent → new.
  const url = useSearchParams().get("id") ?? undefined;
  const isNew = !url;

  const router = useRouter();
  const store = useStore<Contact>(contactsStore);
  const { data: item, loading, error } = useItem(store, url);

  const [fn, setFn] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [contactWebId, setContactWebId] = useState("");
  const [etag, setEtag] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (item) {
      setFn(item.data.fn);
      setEmail(item.data.email ?? "");
      setPhone(item.data.phone ?? "");
      setNote(item.data.note ?? "");
      setContactWebId(item.data.webId ?? "");
      setEtag(item.etag);
    }
  }, [item]);

  const ready = Boolean(store) && (isNew || Boolean(item) || !loading);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!store) return;
    if (!fn.trim()) {
      toast.error("Please enter a name.");
      return;
    }
    setSaving(true);
    try {
      const webIdValue = contactWebId.trim();
      if (webIdValue && !/^https?:\/\//i.test(webIdValue)) {
        toast.error("A WebID must be a full web address (https://…).");
        setSaving(false);
        return;
      }
      const contact: Contact = {
        fn: fn.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        note: note.trim() || undefined,
        webId: webIdValue || undefined,
      };
      if (isNew) {
        const { url: created } = await store.create(contact, fn);
        toast.success("Contact added");
        router.replace(`/contacts/edit?id=${encodeURIComponent(created)}`);
      } else if (url) {
        await store.update(url, contact, etag);
        toast.success("Contact saved");
        router.push("/contacts");
      }
    } catch (err) {
      if (err instanceof ResourceWriteError && err.status === 412) {
        toast.error("This contact changed elsewhere. Reopen it and try again.");
      } else {
        toast.error("Could not save this contact. Please try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!store || !url) return;
    setDeleting(true);
    try {
      await store.remove(url);
      toast.success("Contact deleted");
      router.push("/contacts");
    } catch {
      toast.error("Could not delete this contact. Please try again.");
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <ol className="flex items-center gap-1">
          <li>
            <Link href="/contacts" className="hover:text-foreground hover:underline">
              Contacts
            </Link>
          </li>
          <ChevronRight className="size-4" aria-hidden="true" />
          <li aria-current="page" className="font-medium text-foreground">
            {isNew ? "New contact" : "Edit contact"}
          </li>
        </ol>
      </nav>

      {error ? (
        <ErrorState error={error} />
      ) : !ready ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <form onSubmit={onSave} className="flex max-w-xl flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="contact-fn">Name</Label>
            <Input
              id="contact-fn"
              value={fn}
              onChange={(e) => setFn(e.target.value)}
              placeholder="Full name"
              required
              autoFocus={isNew}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="contact-email">Email (optional)</Label>
              <Input
                id="contact-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="contact-phone">Phone (optional)</Label>
              <Input
                id="contact-phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 555 123 4567"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="contact-note">Note (optional)</Label>
            <Textarea
              id="contact-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="How you know them, anything to remember…"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="contact-webid">
              WebID (optional)
              <span className="ml-1.5 font-normal text-muted-foreground">
                — their Solid address, so you can pick them when sharing
              </span>
            </Label>
            <Input
              id="contact-webid"
              type="url"
              inputMode="url"
              value={contactWebId}
              onChange={(e) => setContactWebId(e.target.value)}
              placeholder="https://them.example/profile/card#me"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={saving}>
              {saving ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Save aria-hidden="true" />
              )}
              {isNew ? "Add contact" : "Save changes"}
            </Button>
            <Button type="button" variant="ghost" asChild>
              <Link href="/contacts">Cancel</Link>
            </Button>
            {!isNew && (
              <Button
                type="button"
                variant="destructive"
                className="ml-auto"
                onClick={onDelete}
                disabled={deleting}
              >
                {deleting ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <Trash2 aria-hidden="true" />
                )}
                Delete
              </Button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
