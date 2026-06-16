// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Profile renderer (design: `docs/typed-data-views.md` §4): a profile snippet —
 * avatar + name + nickname + bio — with a **Visit homepage** action and **no raw
 * triples / no raw URLs**. Consumes the pure `ProfileModel`; all RDF stayed in
 * `lib/`.
 *
 * The avatar is a remote IRI (the same remote-image/CSP consideration as the
 * contacts card); it degrades to initials via the shadcn `Avatar` fallback. The
 * homepage was already gated by `safeLinkHref` upstream (pure layer).
 */
import { ExternalLink, UserRound } from "lucide-react";
import type { ProfileModel, ProfileSnippet } from "@/lib/typed-views/profile-view";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { initials } from "@/components/account-menu";

/** The profile-snippet list for a profile resource. */
export function ProfileCardList({ model }: { model: ProfileModel; url: string }) {
  if (model.items.length === 0) {
    return <p className="text-sm text-muted-foreground">No profile found in this resource.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {model.items.map((profile) => (
        <ProfileRow key={profile.id} profile={profile} />
      ))}
    </div>
  );
}

function ProfileRow({ profile }: { profile: ProfileSnippet }) {
  return (
    <Card>
      <CardContent className="flex items-start gap-4 py-4">
        <Avatar size="lg">
          {profile.avatarUrl ? <AvatarImage src={profile.avatarUrl} alt="" /> : null}
          <AvatarFallback className="bg-accent text-accent-foreground">
            {profile.name.trim() ? (
              initials(profile.name)
            ) : (
              <UserRound className="size-4" aria-hidden="true" />
            )}
          </AvatarFallback>
        </Avatar>

        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-medium leading-tight">{profile.name}</span>
          {profile.nickname && (
            <span className="text-sm text-muted-foreground">{profile.nickname}</span>
          )}
          {profile.bio && (
            <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">{profile.bio}</p>
          )}

          {profile.homepage && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <a href={profile.homepage} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="size-4" aria-hidden="true" />
                  Visit homepage
                </a>
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
