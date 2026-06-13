// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * "Under-the-hood" developer panel (SolidOS-parity A4).
 *
 * A collapsible panel on any RDF resource view that reveals the raw RDF/triples
 * (the source) and the resource's technical metadata (URI, content-type, size).
 * It is **collapsed by default** — the typed card stays the front-and-centre
 * rendering and raw triples are strictly opt-in (the no-raw-RDF-by-default
 * principle, §5.1). Opening it does not refetch; it renders the already-parsed
 * property groups through the shared `RdfViewer`, so the developer sees the same
 * triple table the "Data" view uses.
 *
 * The existing delete affordance is reused, not reimplemented: the caller passes
 * its delete control via `actions`, so this panel adds no second deletion path.
 *
 * Pure presentation built on the native `<details>`/`<summary>` disclosure, so
 * it is keyboard-accessible and needs no JS state.
 */
import { ChevronDown, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import type { LoadedResource } from "@/components/use-resource";
import { RdfViewer } from "@/components/typed-views/rdf-table";
import { formatBytes } from "@/lib/format";

/** A collapsible developer panel: technical metadata + raw triples + actions. */
export function UnderTheHood({
  resource,
  actions,
}: {
  resource: LoadedResource;
  /** Optional caller-owned controls (e.g. the existing Delete button). */
  actions?: ReactNode;
}) {
  return (
    <details className="group rounded-2xl border border-border bg-muted/20">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <Wrench className="size-4" aria-hidden="true" />
        Under the hood
        <span className="text-xs font-normal text-muted-foreground/70">
          (raw data &amp; technical details)
        </span>
        <ChevronDown
          className="ml-auto size-4 transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>

      <div className="flex flex-col gap-4 border-t border-border px-4 py-4">
        {/* Technical metadata. */}
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="font-medium text-muted-foreground">URI</dt>
          <dd className="break-all font-mono text-xs">{resource.url}</dd>

          <dt className="font-medium text-muted-foreground">Content type</dt>
          <dd className="font-mono text-xs">{resource.viewer.mediaType || "unknown"}</dd>

          {resource.size != null && (
            <>
              <dt className="font-medium text-muted-foreground">Size</dt>
              <dd className="tabular">{formatBytes(resource.size)}</dd>
            </>
          )}
        </dl>

        {/* Raw triples — the source, on demand only. */}
        {resource.properties && resource.properties.length > 0 && (
          <section aria-label="Raw triples" className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Triples
            </h3>
            <RdfViewer groups={resource.properties} />
          </section>
        )}

        {actions && <div className="flex flex-wrap gap-2 pt-1">{actions}</div>}
      </div>
    </details>
  );
}
