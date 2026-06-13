// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Photos renderer (design: `docs/typed-data-views.md` P3): a thumbnail grid —
 * each tile is the hosted asset (`schema:contentUrl`) with the caption and an
 * **"Open in <source>"** action (Google Photos / Pinterest), and **no raw
 * triples / no raw URLs**. Consumes the pure `PhotoModel`; all RDF stayed in
 * `lib/`.
 *
 * Thumbnails are remote pod-asset IRIs — the same privacy/CSP consideration as
 * music cover art and profile avatars. Each src is re-gated through
 * `safeLinkHref` here (http(s) only) before it becomes an `<img>`; a missing or
 * unsafe asset falls back to an image-placeholder icon.
 */
import { ImageIcon } from "lucide-react";
import type { Photo, PhotoModel } from "@/lib/typed-views/photo-view";
import { safeLinkHref } from "@/lib/pod-scope";
import { Card, CardContent } from "@/components/ui/card";
import { SourceActionButton } from "@/components/typed-views/source-action";

/** The thumbnail grid for a photos resource. */
export function PhotoGrid({ model }: { model: PhotoModel; url: string }) {
  if (model.items.length === 0) {
    return <p className="text-sm text-muted-foreground">No photos found in this resource.</p>;
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {model.items.map((photo) => (
        <PhotoTile key={photo.id} photo={photo} />
      ))}
    </div>
  );
}

function PhotoTile({ photo }: { photo: Photo }) {
  // Only ever load an http(s) asset IRI (privacy/CSP); anything else falls back
  // to the placeholder icon.
  const src = photo.contentUrl ? safeLinkHref(photo.contentUrl) : undefined;

  return (
    <Card className="overflow-hidden py-0">
      <CardContent className="flex flex-col gap-2 p-0">
        <div className="flex aspect-square w-full items-center justify-center overflow-hidden bg-accent text-accent-foreground">
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element -- remote pod asset, not a build-time asset
            <img src={src} alt={photo.title} loading="lazy" className="size-full object-cover" />
          ) : (
            <ImageIcon className="size-8" aria-hidden="true" />
          )}
        </div>
        <div className="flex flex-col gap-2 px-3 pb-3">
          <span className="truncate text-sm font-medium leading-tight" title={photo.title}>
            {photo.title}
          </span>
          {photo.source && (
            <div className="flex flex-wrap gap-2">
              <SourceActionButton source={photo.source} />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
