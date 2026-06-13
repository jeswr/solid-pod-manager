// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Render-side typed-view registry (design: `docs/typed-data-views.md` §4.2,
 * §4.5). Binds each pure `TypedViewer` to its React renderer and exposes
 * `selectTypedView(resource)` — the single call `ResourceViewer` makes for the
 * `"rdf"` kind. Returns `null` when no viewer matches, so the caller falls back
 * to the generic `RdfViewer` triple table (the explicit unknown-type fallback).
 */
import type { ReactNode } from "react";
import type { LoadedResource } from "@/components/use-resource";
import type { TypedViewer } from "@/lib/typed-views/types";
import { selectTypedViewer, buildViewerContext } from "@/lib/typed-views/select";
import { contactsViewer, type ContactsModel } from "@/lib/typed-views/contacts-view";
import { ContactsCardList } from "@/components/typed-views/contacts-card";

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
  [contactsViewer.id]: entry<ContactsModel>({ viewer: contactsViewer, card: ContactsCardList }),
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
