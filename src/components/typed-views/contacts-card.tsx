// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Contacts renderer (design: `docs/typed-data-views.md` P1): a profile-card
 * list — avatar + name + email/phone *actions* — with no raw triples and no
 * raw URLs. Consumes the pure `ContactsModel`; all RDF stayed in `lib/`.
 *
 * Email/phone become `mailto:`/`tel:` actions from the stored URIs (gated by
 * `safeLinkHref`, which permits `mailto:`). Avatars are remote IRIs on profile
 * subjects (the same remote-image/CSP consideration as elsewhere); they degrade
 * to initials via the shadcn `Avatar` fallback.
 */
import { Mail, Phone, UserRound } from "lucide-react";
import type { ContactCard, ContactsModel } from "@/lib/typed-views/contacts-view";
import { safeLinkHref } from "@/lib/pod-scope";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { initials } from "@/components/account-menu";

/** The profile-card list for a contacts resource. */
export function ContactsCardList({ model }: { model: ContactsModel; url: string }) {
  if (model.items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No contacts found in this resource.</p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {model.items.map((contact) => (
        <ContactRow key={contact.id} contact={contact} />
      ))}
    </div>
  );
}

function ContactRow({ contact }: { contact: ContactCard }) {
  // safeLinkHref permits mailto:; tel: is not in the safe set, so build it
  // directly from the stored, already-normalised tel: URI (no user-controlled
  // scheme — contacts.ts wrote it via toTel()).
  const mailHref = contact.emailUri ? safeLinkHref(contact.emailUri) : undefined;
  const telHref = contact.phoneUri?.startsWith("tel:") ? contact.phoneUri : undefined;

  return (
    <Card>
      <CardContent className="flex items-start gap-4 py-4">
        <Avatar size="lg">
          {contact.avatarUrl ? (
            <AvatarImage src={contact.avatarUrl} alt="" />
          ) : null}
          <AvatarFallback className="bg-accent text-accent-foreground">
            {contact.name.trim() ? (
              initials(contact.name)
            ) : (
              <UserRound className="size-4" aria-hidden="true" />
            )}
          </AvatarFallback>
        </Avatar>

        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-medium leading-tight">{contact.name}</span>
          {contact.email && (
            <span className="text-sm text-muted-foreground">{contact.email}</span>
          )}
          {contact.phone && (
            <span className="text-sm text-muted-foreground">{contact.phone}</span>
          )}
          {contact.note && (
            <p className="mt-1 text-sm text-muted-foreground">{contact.note}</p>
          )}

          {(mailHref || telHref) && (
            <div className="mt-2 flex flex-wrap gap-2">
              {mailHref && (
                <Button variant="outline" size="sm" asChild>
                  <a href={mailHref}>
                    <Mail className="size-4" aria-hidden="true" />
                    Send email
                  </a>
                </Button>
              )}
              {telHref && (
                <Button variant="outline" size="sm" asChild>
                  <a href={telHref}>
                    <Phone className="size-4" aria-hidden="true" />
                    Call
                  </a>
                </Button>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
