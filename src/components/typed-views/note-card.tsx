// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Notes renderer (design: `docs/typed-data-views.md` §4): a list of note cards —
 * title + last-edited time + a body preview — with **no raw triples**. Consumes
 * the pure `NoteModel`; all RDF stayed in `lib/`.
 *
 * The body is shown as a clamped plain-text preview (NOT rendered as markdown/HTML
 * — pod text is untrusted input, so it is never interpreted as live markup). The
 * pure layer keeps `modified` as a raw ISO string; this card formats it for
 * display in the user's locale via `Intl`.
 */
import { FileText } from "lucide-react";
import type { NoteItem, NoteModel } from "@/lib/typed-views/note-view";
import { Card, CardContent } from "@/components/ui/card";

/** The note-card list for a notes resource. */
export function NoteCardList({ model }: { model: NoteModel; url: string }) {
  if (model.items.length === 0) {
    return <p className="text-sm text-muted-foreground">No notes found in this resource.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {model.items.map((note) => (
        <NoteRow key={note.id} note={note} />
      ))}
    </div>
  );
}

function NoteRow({ note }: { note: NoteItem }) {
  const when = formatDate(note.modified);
  return (
    <Card>
      <CardContent className="flex items-start gap-4 py-4">
        <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-accent text-accent-foreground">
          <FileText className="size-5" aria-hidden="true" />
        </div>

        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-medium leading-tight">{note.title}</span>
          {when && <span className="text-sm text-muted-foreground">Edited {when}</span>}
          {note.text && (
            <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-sm text-muted-foreground">
              {note.text}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Locale-friendly date, e.g. "11 Jun 2026". Tolerates bad/absent input. */
function formatDate(iso?: string): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(t));
}
