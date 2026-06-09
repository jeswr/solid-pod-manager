import { Download, ExternalLink, FileQuestion, LinkIcon } from "lucide-react";
import type { LoadedResource } from "@/components/use-resource";
import type { PropertyGroup } from "@/lib/resource-view";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** Render a loaded resource with the viewer chosen by its content type. */
export function ResourceViewer({ resource }: { resource: LoadedResource }) {
  switch (resource.viewer.kind) {
    case "rdf":
      return <RdfViewer groups={resource.properties ?? []} />;
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
      return (
        <pre className="measure-none overflow-x-auto rounded-2xl border border-border bg-muted/40 p-4 text-sm leading-relaxed">
          <code>{resource.text}</code>
        </pre>
      );
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

/** Friendly property table for RDF resources (the "structured data" viewer). */
function RdfViewer({ groups }: { groups: PropertyGroup[] }) {
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
                            {v.kind === "named" ? (
                              <a
                                href={v.value}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                              >
                                <LinkIcon className="size-3 shrink-0" aria-hidden="true" />
                                {v.value}
                              </a>
                            ) : (
                              <span>{v.value}</span>
                            )}
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
