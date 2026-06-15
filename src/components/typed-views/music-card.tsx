// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Music renderer (design: `docs/typed-data-views.md` P2): a list of cover-art
 * rows — art (or a music-note icon fallback) + title + artist (+ album +
 * humanised duration) — with an **"Open in Spotify"** action and **no raw
 * triples / no raw URLs**. Consumes the pure `MusicModel`; all RDF stayed in
 * `lib/`.
 *
 * Cover art: no album-art triple is imported today (the Spotify adapter reads
 * `album.name` only, not `album.images`), so `track.imageUrl` is normally
 * absent and we render a music-note icon. The image path is already wired and
 * `safeLinkHref`-gated, so it lights up automatically once a one-line adapter
 * change writes `album.images[0].url` onto `schema:image` (FOLLOW-UP — see
 * `music-view.ts` header and docs §6 Q4). Remote image loading is the same
 * privacy/CSP consideration as profile avatars.
 */
import { Clock, Music } from "lucide-react";
import type { MusicModel, MusicTrack } from "@/lib/typed-views/music-view";
import { humanizeDuration } from "@/lib/typed-views/music-view";
import { safeLinkHref } from "@/lib/pod-scope";
import { Card, CardContent } from "@/components/ui/card";
import { SourceActionButton } from "@/components/typed-views/source-action";

/** The cover-art row list for a music resource. */
export function MusicCardList({ model }: { model: MusicModel; url: string }) {
  if (model.items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No music found in this resource.</p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {model.items.map((track) => (
        <MusicRow key={track.id} track={track} />
      ))}
    </div>
  );
}

function MusicRow({ track }: { track: MusicTrack }) {
  // Only ever load an http(s) cover-art IRI (privacy/CSP); anything else falls
  // back to the icon. No adapter writes art today, so this is normally null.
  const artHref = track.imageUrl ? safeLinkHref(track.imageUrl) : undefined;
  const duration = humanizeDuration(track.duration);

  return (
    <Card>
      <CardContent className="flex items-start gap-4 py-4">
        <CoverArt src={artHref} />

        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-medium leading-tight">{track.title}</span>
          {track.artist && (
            <span className="text-sm text-muted-foreground">{track.artist}</span>
          )}
          {(track.album || duration) && (
            <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {track.album && <span className="truncate">{track.album}</span>}
              {track.album && duration && <span aria-hidden="true">·</span>}
              {duration && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3.5" aria-hidden="true" />
                  {duration}
                </span>
              )}
            </span>
          )}

          {track.source && (
            <div className="mt-2 flex flex-wrap gap-2">
              <SourceActionButton source={track.source} />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Square cover-art thumbnail; a music-note icon when no art triple is present. */
function CoverArt({ src }: { src?: string }) {
  return (
    <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-accent text-accent-foreground">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- remote pod art, not a build-time asset
        <img src={src} alt="" className="size-full object-cover" />
      ) : (
        <Music className="size-5" aria-hidden="true" />
      )}
    </div>
  );
}
