// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * Table-of-class renderer (SolidOS-parity A5): "all instances of this rdf:type"
 * as a table — one row per instance, one column per predicate. Consumes the pure
 * `ClassTableModel` from `table-of-class.ts`; all RDF parsing stayed in `lib/`.
 *
 * Cells are humanised: literals go through `formatLiteral` (A2 — dates,
 * durations, booleans, numbers, language tags) and IRIs are gated through
 * `safeLinkHref` (SEC-2 — `javascript:`/`data:` render inert). An accessible
 * `<table>` with row/column headers (DESIGN §8, R8). When the dataset holds more
 * than one class, a small selector lets the user pick which class to tabulate.
 */
import { LinkIcon } from "lucide-react";
import type { ClassCellValue, ClassTableModel } from "@/lib/typed-views/table-of-class";
import { formatLiteral } from "@/lib/literal-format";
import { safeLinkHref } from "@/lib/pod-scope";
import { localName } from "@/lib/resource-view";

/** Render a single class as an instances table. */
export function ClassTable({ model }: { model: ClassTableModel }) {
  if (model.rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No instances of {model.classLabel} in this resource.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        {model.truncated
          ? `Showing ${model.rows.length} of ${model.total} ${model.classLabel} instances.`
          : `${model.total} ${model.classLabel} ${model.total === 1 ? "instance" : "instances"}.`}
      </p>
      <div className="overflow-x-auto rounded-2xl border border-border bg-card">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">All {model.classLabel} instances</caption>
          <thead>
            <tr className="border-b border-border text-left">
              <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                Item
              </th>
              {model.columns.map((col) => (
                <th
                  key={col.predicate}
                  scope="col"
                  className="px-3 py-2 font-medium text-muted-foreground"
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row) => (
              <tr key={row.subject} className="border-b border-border/60 last:border-0">
                <th scope="row" className="px-3 py-2 text-left align-top font-medium">
                  {row.label}
                </th>
                {model.columns.map((col) => (
                  <td key={col.predicate} className="px-3 py-2 align-top">
                    <Cell values={row.cells[col.predicate]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Render one cell's values (humanised literals + safe IRI links). */
function Cell({ values }: { values?: ClassCellValue[] }) {
  if (!values || values.length === 0) {
    return <span className="text-muted-foreground/60">—</span>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {values.map((v, i) => (
        <li key={`${v.value}-${i}`} className="break-words">
          <CellValue value={v} />
        </li>
      ))}
    </ul>
  );
}

function CellValue({ value }: { value: ClassCellValue }) {
  if (value.kind === "named") {
    const href = safeLinkHref(value.value);
    if (!href) return <span>{value.value}</span>;
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
      >
        <LinkIcon className="size-3 shrink-0" aria-hidden="true" />
        {localName(value.value) || value.value}
      </a>
    );
  }
  // Literal → humanised (dates/durations/booleans/numbers/lang); A2.
  const formatted = formatLiteral({
    value: value.value,
    datatype: value.datatype,
    language: value.language,
  });
  return (
    <span>
      {formatted.text}
      {formatted.language && (
        <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[0.625rem] font-medium uppercase text-muted-foreground">
          {formatted.language}
        </span>
      )}
    </span>
  );
}
