// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Bookmarks renderer (design: `docs/typed-data-views.md` P3): a list of
 * bookmark rows — favicon + title + host — with an **Open** action and **no raw
 * triples**. Consumes the pure `BookmarkModel`; all RDF stayed in `lib/`.
 *
 * The favicon is fetched from Google's stateless favicon service keyed by the
 * bookmark host (no per-site asset stored in the pod). Like other remote images
 * in the typed views this is a privacy/CSP consideration; it degrades to a
 * link/bookmark icon when the host is unknown or the image fails to load.
 */
import { Bookmark as BookmarkIcon, ExternalLink } from "lucide-react";
import { useState } from "react";
import type { Bookmark, BookmarkModel } from "@/lib/typed-views/bookmark-view";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/** The bookmark-row list for a bookmarks resource. */
export function BookmarkCardList({ model }: { model: BookmarkModel; url: string }) {
  if (model.items.length === 0) {
    return <p className="text-sm text-muted-foreground">No bookmarks found in this resource.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {model.items.map((bookmark) => (
        <BookmarkRow key={bookmark.id} bookmark={bookmark} />
      ))}
    </div>
  );
}

function BookmarkRow({ bookmark }: { bookmark: Bookmark }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 py-4">
        <Favicon host={bookmark.host} />

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-medium leading-tight" title={bookmark.title}>
            {bookmark.title}
          </span>
          {bookmark.host && (
            <span className="truncate text-sm text-muted-foreground">{bookmark.host}</span>
          )}
        </div>

        {bookmark.href && (
          <Button variant="outline" size="sm" asChild className="shrink-0">
            <a href={bookmark.href} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-4" aria-hidden="true" />
              Open
            </a>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/** A favicon tile keyed by host; falls back to a bookmark icon when absent/failed. */
function Favicon({ host }: { host?: string }) {
  const [failed, setFailed] = useState(false);
  const src = host
    ? `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(host)}`
    : undefined;

  return (
    <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-accent text-accent-foreground">
      {src && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- remote favicon, not a build-time asset
        <img
          src={src}
          alt=""
          width={24}
          height={24}
          className="size-6 object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <BookmarkIcon className="size-5" aria-hidden="true" />
      )}
    </div>
  );
}
