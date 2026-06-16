// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Render-side typed-view registry (design: `docs/typed-data-views.md` §4.2,
 * §4.5). Binds each pure `TypedViewer` to its React renderer and exposes
 * `selectTypedView(resource)` — the single call `ResourceViewer` makes for the
 * `"rdf"` kind. Returns `null` when no viewer matches, so the caller falls back
 * to the generic `RdfViewer` triple table (the explicit unknown-type fallback).
 */
import type { ReactNode } from "react";
import type { Quad } from "@rdfjs/types";
import type { LoadedResource } from "@/components/use-resource";
import type { TypedViewer } from "@/lib/typed-views/types";
import { selectTypedViewer, buildViewerContext } from "@/lib/typed-views/select";
import { sourceActionFor, type SourceMatch } from "@/lib/typed-views/sources";
import { dominantTabulatableClass } from "@/lib/typed-views/table-of-class";
import { profileViewer, type ProfileModel } from "@/lib/typed-views/profile-view";
import { contactsViewer, type ContactsModel } from "@/lib/typed-views/contacts-view";
import { musicViewer, type MusicModel } from "@/lib/typed-views/music-view";
import { photoViewer, type PhotoModel } from "@/lib/typed-views/photo-view";
import { eventViewer, type EventModel } from "@/lib/typed-views/event-view";
import { bookmarkViewer, type BookmarkModel } from "@/lib/typed-views/bookmark-view";
import { taskViewer, type TaskModel } from "@/lib/typed-views/task-view";
import { noteViewer, type NoteModel } from "@/lib/typed-views/note-view";
import { issueViewer, type IssueModel } from "@/lib/typed-views/issue-view";
import { ProfileCardList } from "@/components/typed-views/profile-card";
import { ContactsCardList } from "@/components/typed-views/contacts-card";
import { MusicCardList } from "@/components/typed-views/music-card";
import { PhotoGrid } from "@/components/typed-views/photo-grid";
import { EventCardList } from "@/components/typed-views/event-card";
import { BookmarkCardList } from "@/components/typed-views/bookmark-card";
import { TaskCardList } from "@/components/typed-views/task-card";
import { NoteCardList } from "@/components/typed-views/note-card";
import { IssueCardList } from "@/components/typed-views/issue-card";

/** A React card for a viewer's model. */
type CardComponent<M> = (props: { model: M; url: string }) => ReactNode;

/** Binds a pure {@link TypedViewer} to its React card renderer. */
interface TypedViewEntry<M> {
  viewer: TypedViewer<M>;
  card: CardComponent<M>;
}

/** A type-erased entry that renders itself given a context + url. */
interface RenderableEntry {
  render: (ctx: ReturnType<typeof buildViewerContext>, url: string) => ReactNode;
}

/** Erase the model type while keeping viewer + card paired (no `any`). */
function entry<M>(e: TypedViewEntry<M>): RenderableEntry {
  const Card = e.card;
  return {
    render: (ctx, url) => <Card model={e.viewer.extract(ctx)} url={url} />,
  };
}

/**
 * The render bindings, keyed by viewer id. Selection runs over the *pure*
 * `TYPED_VIEWERS` registry; this map only resolves the matched viewer to its
 * card. Adding a viewer = one pure viewer + one entry here.
 */
const ENTRIES: Record<string, RenderableEntry> = {
  [profileViewer.id]: entry<ProfileModel>({ viewer: profileViewer, card: ProfileCardList }),
  [contactsViewer.id]: entry<ContactsModel>({ viewer: contactsViewer, card: ContactsCardList }),
  [musicViewer.id]: entry<MusicModel>({ viewer: musicViewer, card: MusicCardList }),
  [photoViewer.id]: entry<PhotoModel>({ viewer: photoViewer, card: PhotoGrid }),
  [eventViewer.id]: entry<EventModel>({ viewer: eventViewer, card: EventCardList }),
  [bookmarkViewer.id]: entry<BookmarkModel>({ viewer: bookmarkViewer, card: BookmarkCardList }),
  [taskViewer.id]: entry<TaskModel>({ viewer: taskViewer, card: TaskCardList }),
  [noteViewer.id]: entry<NoteModel>({ viewer: noteViewer, card: NoteCardList }),
  [issueViewer.id]: entry<IssueModel>({ viewer: issueViewer, card: IssueCardList }),
};

/**
 * Render the typed view for an RDF `LoadedResource`, or `null` if none applies.
 * Requires `dataset` to be populated (see `use-resource.ts`); without it, no
 * typed view can be selected and the caller falls back to the triple table.
 */
export function selectTypedView(resource: LoadedResource): ReactNode | null {
  if (!resource.dataset) return null;
  const ctx = buildViewerContext(resource.url, resource.dataset, resource.categoryId);
  const viewer = selectTypedViewer(ctx);
  if (!viewer) return null;
  const found = ENTRIES[viewer.id];
  if (!found) return null;
  return found.render(ctx, resource.url);
}

const SCHEMA_URL = "https://schema.org/url";
const SCHEMA_URL_HTTP = "http://schema.org/url";

/** What the view-switcher tray (A3) needs to decide which modes to offer. */
export interface ViewMeta {
  /** Did a typed viewer match (so the card is the default rendering)? */
  hasTypedView: boolean;
  /** A recognised "Open in …" source action, if the resource carries one. */
  source?: SourceMatch;
  /** The dominant `rdf:type` with >= 2 instances (A5), if any — drives "Table". */
  tableClass?: string;
}

/**
 * Inspect a loaded RDF resource for the view-switcher: whether a typed card
 * applies, whether it resolves a branded source action, and whether it holds a
 * tabulatable class. The source is found by scanning the `schema:url` objects
 * through `sourceActionFor` (the same safe gate the cards use) — so the tray's
 * "Source" mode matches exactly what a card would surface, with no raw URL ever
 * exposed.
 */
export function viewMetaFor(resource: LoadedResource): ViewMeta {
  if (!resource.dataset) return { hasTypedView: false };
  const ctx = buildViewerContext(resource.url, resource.dataset, resource.categoryId);
  const hasTypedView = selectTypedViewer(ctx) !== undefined;
  const tableClass = dominantTabulatableClass(resource.dataset);

  let source: SourceMatch | undefined;
  if (hasTypedView) {
    for (const quad of resource.dataset as Iterable<Quad>) {
      if (
        (quad.predicate.value === SCHEMA_URL || quad.predicate.value === SCHEMA_URL_HTTP) &&
        quad.object.termType === "NamedNode"
      ) {
        const match = sourceActionFor(quad.object.value);
        if (match) {
          source = match;
          break;
        }
      }
    }
  }
  return { hasTypedView, source, tableClass };
}
