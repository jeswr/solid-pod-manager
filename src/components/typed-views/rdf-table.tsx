// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
/**
 * The generic raw-triples table — the "Data" rendering of an RDF resource.
 *
 * Extracted from `resource-viewer.tsx` so it can be reused by the view-switcher
 * tray's "Data" mode (A3) and the under-the-hood developer panel (A4) without
 * duplication. It is the explicit unknown-type fallback (typed-data-views §4.5)
 * and the opt-in "show me the raw triples" surface — never the default when a
 * typed card exists.
 *
 * Literals are humanised via `formatLiteral` (A2 — dates/durations/booleans/
 * numbers, with a subtle language chip for tagged strings); IRIs are gated
 * through `safeLinkHref` (SEC-2 — `javascript:`/`data:` IRIs render inert).
 */
import { LinkIcon } from "lucide-react";
import type { PropertyGroup, PropertyValue } from "@/lib/resource-view";
import { formatLiteral } from "@/lib/literal-format";
import { safeLinkHref } from "@/lib/pod-scope";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** Friendly property table for RDF resources (the "structured data" viewer). */
export function RdfViewer({ groups }: { groups: PropertyGroup[] }) {
  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This resource has no readable properties.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <Card key={group.subject}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              {group.label}
              {group.primary && (
                <span className="rounded-full bg-accent px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wide text-accent-foreground">
                  Main
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {/* Accessible underlying table (DESIGN.md §8, R8). */}
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Properties of {group.label}</caption>
              <thead className="sr-only">
                <tr>
                  <th scope="col">Property</th>
                  <th scope="col">Value</th>
                </tr>
              </thead>
              <tbody>
                {group.properties.map((entry) => (
                  <tr key={entry.predicate} className="border-b border-border/60 last:border-0">
                    <th
                      scope="row"
                      className="whitespace-nowrap py-2 pr-4 text-left align-top font-medium text-muted-foreground"
                    >
                      {entry.label}
                    </th>
                    <td className="py-2 align-top">
                      <ul className="flex flex-col gap-1">
                        {entry.values.map((v, i) => (
                          <li key={`${v.value}-${i}`} className="break-all">
                            <Value value={v} />
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Render one property value — safe IRI link or humanised literal (A2). */
function Value({ value }: { value: PropertyValue }) {
  if (value.kind === "named") {
    // SECURITY (SEC-2): only render an IRI as a link when its scheme is safe;
    // `javascript:`/`data:` IRIs from pod data render as inert text.
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
        {value.value}
      </a>
    );
  }
  // Literal → humanised (A2): dates, durations, booleans, numbers, lang tags.
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
