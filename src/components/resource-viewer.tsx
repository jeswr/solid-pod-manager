"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Download, ExternalLink, FileQuestion } from "lucide-react";
import type { LoadedResource } from "@/components/use-resource";
import { selectTypedView, viewMetaFor } from "@/components/typed-views/registry";
import { RdfViewer } from "@/components/typed-views/rdf-table";
import { ViewSwitcher } from "@/components/typed-views/view-switcher";
import { ClassTable } from "@/components/typed-views/class-table";
import { SourceActionButton } from "@/components/typed-views/source-action";
import { UnderTheHood } from "@/components/typed-views/under-the-hood";
import { Markdown } from "@/components/markdown";
import { looksLikeMarkdown } from "@/lib/literal-format";
import { buildClassTable } from "@/lib/typed-views/table-of-class";
import {
  initialViewMode,
  shouldShowSwitcher,
  viewModeOptions,
  type ViewMode,
} from "@/lib/typed-views/view-modes";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Render a loaded resource with the viewer chosen by its content type. The
 * `rdf` kind adds the view-switcher tray (A3 — typed card ↔ raw data ↔ source)
 * and an always-available, collapsed-by-default under-the-hood panel (A4); the
 * `text` kind renders Markdown safely (A2). `actions` is the caller's
 * resource-level controls (e.g. Delete), reused inside the under-the-hood panel.
 */
export function ResourceViewer({
  resource,
  actions,
}: {
  resource: LoadedResource;
  actions?: ReactNode;
}) {
  switch (resource.viewer.kind) {
    case "rdf":
      return <RdfResourceView resource={resource} actions={actions} />;
    case "image":
      return (
        <figure className="overflow-hidden rounded-2xl border border-border bg-card">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={resource.url}
            alt={`Preview of ${new URL(resource.url).pathname.split("/").pop() ?? "image"}`}
            className="mx-auto max-h-[70vh] w-auto"
          />
        </figure>
      );
    case "text":
      return <TextResourceView resource={resource} />;
    case "pdf":
      return (
        <object
          data={resource.url}
          type="application/pdf"
          className="h-[70vh] w-full rounded-2xl border border-border"
          aria-label="PDF preview"
        >
          <GenericFallback resource={resource} />
        </object>
      );
    case "audio":
      return <audio controls src={resource.url} className="w-full" />;
    case "video":
      return <video controls src={resource.url} className="w-full rounded-2xl" />;
    default:
      return <GenericFallback resource={resource} />;
  }
}

/**
 * The RDF view: typed card by default (no-raw-RDF-by-default, §5.1), with a
 * view-switcher tray to reveal the raw triples or the source platform on demand,
 * and an under-the-hood developer panel below. When no typed view matches, the
 * triple table is the only rendering (no tray) and remains the explicit
 * unknown-type fallback (typed-data-views §4.5).
 */
function RdfResourceView({
  resource,
  actions,
}: {
  resource: LoadedResource;
  actions?: ReactNode;
}) {
  const typed = useMemo(() => selectTypedView(resource), [resource]);
  const meta = useMemo(() => viewMetaFor(resource), [resource]);
  const inputs = {
    hasTypedView: typed != null,
    hasSource: meta.source != null,
    hasClassTable: meta.tableClass != null,
  };
  const options = viewModeOptions(inputs);
  const [mode, setMode] = useState<ViewMode>(() => initialViewMode(inputs));

  const classTable = useMemo(
    () =>
      meta.tableClass && resource.dataset
        ? buildClassTable(resource.dataset, meta.tableClass)
        : undefined,
    [meta.tableClass, resource.dataset],
  );

  // No typed view and nothing else to switch to → the triple table is the sole
  // rendering (the fallback); the under-the-hood panel would only duplicate it.
  if (!typed && options.length === 0) {
    return <RdfViewer groups={resource.properties ?? []} />;
  }

  return (
    <div className="flex flex-col gap-4">
      {shouldShowSwitcher(inputs) && (
        <ViewSwitcher options={options} active={mode} onChange={setMode} />
      )}

      {mode === "typed" && typed}
      {mode === "data" && <RdfViewer groups={resource.properties ?? []} />}
      {mode === "table" && classTable && <ClassTable model={classTable} />}
      {mode === "source" && meta.source && (
        <Card>
          <CardContent className="flex flex-col items-start gap-3 py-6">
            <p className="text-sm text-muted-foreground">
              This item came from another service. Open it there:
            </p>
            <SourceActionButton source={meta.source} />
          </CardContent>
        </Card>
      )}

      <UnderTheHood resource={resource} actions={actions} />
    </div>
  );
}

/**
 * The text view: render Markdown as safe formatted HTML for `text/markdown`, or
 * for plain text that *looks* like Markdown (A2). Everything else stays as
 * monospace text. The `Markdown` component maps a parsed AST to React elements —
 * there is no HTML string and no `dangerouslySetInnerHTML`, so no XSS surface.
 */
function TextResourceView({ resource }: { resource: LoadedResource }) {
  const body = resource.text ?? "";
  const isMarkdown =
    resource.viewer.mediaType === "text/markdown" ||
    (resource.viewer.mediaType === "text/plain" && looksLikeMarkdown(body));

  if (isMarkdown) {
    return (
      <article className="rounded-2xl border border-border bg-card p-4 text-sm leading-relaxed">
        <Markdown source={body} />
      </article>
    );
  }

  return (
    <pre className="measure-none overflow-x-auto rounded-2xl border border-border bg-muted/40 p-4 text-sm leading-relaxed">
      <code>{body}</code>
    </pre>
  );
}

/** The safe generic view: metadata + open/download, never inline execution. */
function GenericFallback({ resource }: { resource: LoadedResource }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-4 py-6">
        <span className="flex items-center gap-2 text-muted-foreground">
          <FileQuestion className="size-5" aria-hidden="true" />
          This file can&apos;t be previewed safely here.
        </span>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <a href={resource.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-4" aria-hidden="true" />
              Open
            </a>
          </Button>
          <Button variant="outline" asChild>
            <a href={resource.url} download>
              <Download className="size-4" aria-hidden="true" />
              Download
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
