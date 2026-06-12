"use client";

/**
 * The Tier-C **file-import** flow for the connect detail page. The user selects
 * their official platform export file; the parser in `src/lib` reads it and
 * writes structured RDF into the pod, with progress and a real outcome panel —
 * the export-file analogue of the OAuth `TierAFlow`.
 *
 * Accessibility: a labelled file input (keyboard-operable), an `aria-live`
 * region announcing progress/outcome, and a visible, focusable choose-file
 * control. No file bytes are read here — only the parser layer touches them.
 */
import { useId, useRef } from "react";
import Link from "next/link";
import { CheckCircle2, ExternalLink, FileUp, Loader2, ShieldCheck } from "lucide-react";
import { categoryIcon } from "@/components/category-icon";
import { ErrorState } from "@/components/states";
import { useFileImport } from "@/components/use-file-import";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { categoryById } from "@/lib/categories";
import type { FileImportAdapter } from "@/lib/integrations/core/file-import";
import type { ImportReport } from "@/lib/integrations/core/import-runner";
import type { CatalogEntry } from "@/lib/integrations/registry";

export function TierCImport({
  entry,
  adapter,
}: {
  entry: CatalogEntry;
  adapter: FileImportAdapter;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const { state, importFile, reset } = useFileImport(adapter);
  const busy = state.phase === "importing";

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void importFile(file);
    // Allow re-selecting the same file after a reset.
    e.target.value = "";
  };

  return (
    <section aria-label="Import from a file" className="flex flex-col gap-4">
      <div className="rounded-2xl border border-border bg-card p-5">
        <h2 className="flex items-center gap-2 font-medium">
          <FileUp className="size-5 text-primary" aria-hidden="true" />
          Import your {entry.name} export
        </h2>
        <p className="mt-1 text-sm text-muted-foreground text-pretty">
          {entry.name} has no live connection, but it lets you download your own
          data. This imports that real export file into your pod — nothing is
          sent anywhere else.
        </p>
        <p className="mt-3 text-sm">{adapter.fileHint}</p>

        {/* Send the user straight to the platform's own export page when it
            has one (adapter.exportUrl). In-app/bank-specific exports have no
            single URL — the field is absent and the fileHint stands alone.
            Real <a href>: external link, new tab, noopener noreferrer. */}
        {adapter.exportUrl ? (
          <p className="mt-3">
            <Button variant="outline" size="sm" asChild>
              <a href={adapter.exportUrl} target="_blank" rel="noopener noreferrer">
                Get your export from {entry.name}
                <ExternalLink className="size-4" aria-hidden="true" />
              </a>
            </Button>
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={adapter.accept}
            onChange={onFileChange}
            disabled={busy}
            className="block w-full max-w-sm text-sm text-muted-foreground file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-2 file:text-sm file:font-medium file:text-primary-foreground hover:file:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
            aria-describedby={`${inputId}-hint`}
          />
        </div>
        <p id={`${inputId}-hint`} className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
          Your file is read in your browser and written only to your own pod.
        </p>
      </div>

      {/* Progress + outcome announced to screen readers as they change. */}
      <div aria-live="polite" className="flex flex-col gap-4">
        {state.phase === "importing" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {state.progress?.label ?? `Importing ${state.fileName ?? "your file"}…`}
          </p>
        ) : null}

        {state.phase === "done" && state.report ? (
          <TierCSuccess entry={entry} report={state.report} fileName={state.fileName} />
        ) : null}

        {state.phase === "error" && state.error ? (
          <ErrorState error={state.error} onRetry={() => inputRef.current?.click()} />
        ) : null}
      </div>

      {state.phase === "done" ? (
        <div>
          <Button variant="outline" onClick={reset}>
            Import another file
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function TierCSuccess({
  entry,
  report,
  fileName,
}: {
  entry: CatalogEntry;
  report: ImportReport;
  fileName?: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <h2 className="flex flex-wrap items-center gap-2 font-medium">
        <CheckCircle2 className="size-5 text-primary" aria-hidden="true" />
        {entry.name} data imported
        <Badge variant="secondary">Your data</Badge>
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {report.written.length}{" "}
        {report.written.length === 1 ? "document" : "documents"} saved to your
        pod{fileName ? ` from ${fileName}` : ""}. Find it under:
      </p>
      <ul className="mt-3 flex flex-wrap gap-2">
        {report.categories.map((id) => {
          const category = categoryById(id);
          if (!category) return null;
          const Icon = categoryIcon(category.icon);
          return (
            <li key={id}>
              <Link
                href={`/my-data/${id}`}
                className="flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-sm text-accent-foreground transition-colors hover:bg-accent/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <Icon className="size-4" aria-hidden="true" />
                {category.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
